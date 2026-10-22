import { useCallback, useEffect, useRef, useState } from "react";
import { streamUrl } from "./api";
import type { Track } from "./types";

export type RepeatMode = "off" | "all" | "one";

// Tracking "current" by track id rather than array index means reordering
// or removing other queue entries never has to special-case shifting an
// index out from under the currently playing track.
export function useQueue(token: string | null) {
  // A plain useRef here would be stale: the <audio> element only mounts
  // once the user is past the auth gate, but a ref's value isn't reactive
  // — an effect keyed on a dependency that never changes (like a stable
  // callback) has no way to know the ref finally has a real element, so it
  // never re-attaches listeners to it. State (via a callback ref) is.
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");

  // Mirrors of the above for use inside stable callbacks (next/prev/ended
  // handler) that intentionally keep an empty dependency array — see the
  // existing setQueue(q => {...; return q}) trick below for why.
  const shuffleRef = useRef(shuffle);
  const repeatRef = useRef(repeat);
  useEffect(() => {
    shuffleRef.current = shuffle;
  }, [shuffle]);
  useEffect(() => {
    repeatRef.current = repeat;
  }, [repeat]);
  // Tracks played before the current one while shuffling, so "previous"
  // can undo a shuffled jump instead of just going sequentially backward.
  const shuffleHistoryRef = useRef<string[]>([]);

  const currentIndex = queue.findIndex((t) => t.id === currentTrackId);
  const currentTrack = currentIndex >= 0 ? queue[currentIndex] : null;

  const playTrack = useCallback((track: Track) => {
    setQueue([track]);
    setCurrentTrackId(track.id);
    shuffleHistoryRef.current = [];
  }, []);

  const playTracks = useCallback((tracks: Track[], startId?: string) => {
    setQueue(tracks);
    setCurrentTrackId(startId ?? tracks[0]?.id ?? null);
    shuffleHistoryRef.current = [];
  }, []);

  const enqueue = useCallback((track: Track) => {
    setQueue((q) => [...q, track]);
    setCurrentTrackId((id) => id ?? track.id);
  }, []);

  const removeFromQueue = useCallback(
    (id: string) => {
      setQueue((q) => {
        const idx = q.findIndex((t) => t.id === id);
        const next = q.filter((t) => t.id !== id);
        if (id === currentTrackId) {
          const replacement = next[idx] ?? next[idx - 1] ?? null;
          setCurrentTrackId(replacement ? replacement.id : null);
        }
        return next;
      });
    },
    [currentTrackId],
  );

  const moveInQueue = useCallback((id: string, direction: -1 | 1) => {
    setQueue((q) => {
      const idx = q.findIndex((t) => t.id === id);
      const swapWith = idx + direction;
      if (idx < 0 || swapWith < 0 || swapWith >= q.length) return q;
      const copy = [...q];
      [copy[idx], copy[swapWith]] = [copy[swapWith], copy[idx]];
      return copy;
    });
  }, []);

  const next = useCallback(() => {
    setQueue((q) => {
      setCurrentTrackId((id) => {
        if (q.length === 0) return id;
        if (shuffleRef.current) {
          if (id) shuffleHistoryRef.current.push(id);
          const remaining = q.filter((t) => t.id !== id);
          if (remaining.length === 0) return id;
          return remaining[Math.floor(Math.random() * remaining.length)].id;
        }
        const idx = q.findIndex((t) => t.id === id);
        if (idx >= 0 && idx + 1 < q.length) return q[idx + 1].id;
        if (repeatRef.current === "all") return q[0].id;
        return id;
      });
      return q;
    });
  }, []);

  const prev = useCallback(() => {
    setQueue((q) => {
      setCurrentTrackId((id) => {
        if (q.length === 0) return id;
        if (shuffleRef.current) {
          const previous = shuffleHistoryRef.current.pop();
          if (previous) return previous;
          return id;
        }
        const idx = q.findIndex((t) => t.id === id);
        if (idx > 0) return q[idx - 1].id;
        if (repeatRef.current === "all") return q[q.length - 1].id;
        return id;
      });
      return q;
    });
  }, []);

  // Separate from next(): when a track ends naturally, repeat-one replays
  // it instead of advancing — but the manual "skip" button should still
  // always move forward even in repeat-one mode.
  const handleEnded = useCallback(() => {
    if (repeatRef.current === "one") {
      if (audioElement) {
        audioElement.currentTime = 0;
        audioElement.play().catch(() => {});
      }
      return;
    }
    next();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next, audioElement]);

  const toggleShuffle = useCallback(() => setShuffle((s) => !s), []);
  const cycleRepeat = useCallback(() => {
    setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off"));
  }, []);

  const togglePlay = useCallback(() => {
    if (!audioElement) return;
    if (audioElement.paused) audioElement.play();
    else audioElement.pause();
  }, [audioElement]);

  const seek = useCallback(
    (seconds: number) => {
      if (audioElement) audioElement.currentTime = seconds;
    },
    [audioElement],
  );

  // Load whatever track is now "current" into the <audio> element.
  useEffect(() => {
    if (!audioElement || !currentTrack) return;
    const url = streamUrl(currentTrack, token);
    if (!url) return;
    audioElement.src = url;
    audioElement.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id, token, audioElement]);

  // Re-runs once audioElement actually becomes non-null (the fix: depending
  // on the element itself, not a ref to it, so React knows to retry once
  // the <audio> tag mounts for real past the auth gate).
  useEffect(() => {
    if (!audioElement) return;
    const onTime = () => setCurrentTime(audioElement.currentTime);
    const onLoaded = () => setDuration(audioElement.duration || 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    audioElement.addEventListener("timeupdate", onTime);
    audioElement.addEventListener("loadedmetadata", onLoaded);
    audioElement.addEventListener("ended", handleEnded);
    audioElement.addEventListener("play", onPlay);
    audioElement.addEventListener("pause", onPause);
    return () => {
      audioElement.removeEventListener("timeupdate", onTime);
      audioElement.removeEventListener("loadedmetadata", onLoaded);
      audioElement.removeEventListener("ended", handleEnded);
      audioElement.removeEventListener("play", onPlay);
      audioElement.removeEventListener("pause", onPause);
    };
  }, [audioElement, handleEnded]);

  return {
    audioRef: setAudioElement,
    queue,
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    shuffle,
    repeat,
    playTrack,
    playTracks,
    enqueue,
    removeFromQueue,
    moveInQueue,
    next,
    prev,
    toggleShuffle,
    cycleRepeat,
    togglePlay,
    seek,
  };
}
