import { useCallback, useEffect, useRef, useState } from "react";
import { streamUrl } from "./api";
import type { Track } from "./types";

export type RepeatMode = "off" | "all" | "one";

// Tracking "current" by track id rather than array index means reordering
// or removing other queue entries never has to special-case shifting an
// index out from under the currently playing track.
export function useQueue(token: string | null) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
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
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = 0;
        audio.play().catch(() => {});
      }
      return;
    }
    next();
  }, [next]);

  const toggleShuffle = useCallback(() => setShuffle((s) => !s), []);
  const cycleRepeat = useCallback(() => {
    setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off"));
  }, []);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play();
    else audio.pause();
  }, []);

  const seek = useCallback((seconds: number) => {
    if (audioRef.current) audioRef.current.currentTime = seconds;
  }, []);

  // Load whatever track is now "current" into the <audio> element.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    const url = streamUrl(currentTrack, token);
    if (!url) return;
    audio.src = url;
    audio.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id, token]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onLoaded = () => setDuration(audio.duration || 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, [handleEnded]);

  return {
    audioRef,
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
