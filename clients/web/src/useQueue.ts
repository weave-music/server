import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPlaybackState, playbackWsUrl, sendPlaybackCommand, streamUrl, updatePlaybackState } from "./api";
import { getDeviceId } from "./deviceId";
import type { Track } from "./types";

export type RepeatMode = "off" | "all" | "one";

type PlaybackBroadcast =
  | { type: "StateUpdate"; device_id: string; track: Track; position_secs: number; is_playing: boolean }
  | { type: "Command"; device_id: string; command: "next" | "prev" };

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

  // --- Cross-device playback sync -----------------------------------------
  // Stable per-browser-profile id so a device can tell "an update I just
  // sent" apart from "another device changed something" in its own WS feed.
  const deviceIdRef = useRef(getDeviceId());
  // Mirrors for use inside callbacks/listeners that read "latest" without
  // wanting to re-subscribe every render (same pattern as shuffleRef above).
  const currentTrackRef = useRef<Track | null>(currentTrack);
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    currentTrackRef.current = currentTrack;
  }, [currentTrack]);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);
  // Set right before a track change that should only update what's
  // *displayed* (hydrating from the server, or mirroring another device
  // that's idle) rather than actually starting playback here.
  const autoplayNextLoadRef = useRef(true);
  // Set right before this device pauses itself *because* another device
  // just started playing — the resulting native "pause" event shouldn't be
  // re-broadcast as this device's own state, or it'd stomp the row the other
  // device just wrote with this device's stale track.
  const suppressNextPushRef = useRef(false);
  // A seek position to apply once the freshly-loaded track's metadata is
  // ready (setting currentTime before that is unreliable across browsers).
  const pendingSeekRef = useRef<number | null>(null);
  const lastPushRef = useRef(0);
  const hydratedRef = useRef(false);
  // Forward references to next/prev (defined further down) so the remote
  // WS handler — defined up here, before they exist — can still call the
  // latest version of them when a skip Command arrives.
  const nextRef = useRef<() => void>(() => {});
  const prevRef = useRef<() => void>(() => {});

  const pushPlaybackState = useCallback(
    (playing: boolean, opts?: { force?: boolean }) => {
      if (suppressNextPushRef.current) {
        suppressNextPushRef.current = false;
        return;
      }
      if (!token || !audioElement || !currentTrackRef.current) return;
      const now = Date.now();
      if (!opts?.force && now - lastPushRef.current < 1000) return;
      lastPushRef.current = now;
      updatePlaybackState(token, deviceIdRef.current, currentTrackRef.current, audioElement.currentTime, playing);
    },
    [token, audioElement],
  );

  // Another device's update, received live over the WebSocket below.
  const handleRemoteEvent = useCallback(
    (event: PlaybackBroadcast) => {
      if (event.type === "Command") {
        // No device_id self-check here on purpose — "whichever device is
        // actually playing reacts" is correct whether this device sent the
        // command itself (tapping Next in its own jam-room view) or
        // received it from elsewhere, since at most one device is ever
        // genuinely playing at a time.
        if (!isPlayingRef.current) return;
        if (event.command === "next") nextRef.current();
        else prevRef.current();
        return;
      }
      if (event.device_id === deviceIdRef.current) return;
      if (event.is_playing && audioElement && !audioElement.paused) {
        suppressNextPushRef.current = true;
        audioElement.pause();
      }
      // Don't interrupt local listening — only mirror the remote track here
      // if this device isn't itself actively playing something.
      if (isPlayingRef.current) return;

      // Track identity from the server is a fresh random id every fetch, so
      // compare by source instead — otherwise every ~5s heartbeat from the
      // playing device would look like a "new" track and reload the <audio>
      // element here for no reason.
      const current = currentTrackRef.current;
      const remoteSource = event.track.sources[0];
      const currentSource = current?.sources[0];
      const sameTrack =
        currentSource &&
        remoteSource &&
        currentSource.provider_id === remoteSource.provider_id &&
        currentSource.source_ref === remoteSource.source_ref;

      if (sameTrack) {
        if (audioElement) audioElement.currentTime = event.position_secs;
        setCurrentTime(event.position_secs);
        return;
      }

      autoplayNextLoadRef.current = false;
      pendingSeekRef.current = event.position_secs;
      setQueue([event.track]);
      setCurrentTrackId(event.track.id);
    },
    [audioElement],
  );
  const handleRemoteEventRef = useRef(handleRemoteEvent);
  useEffect(() => {
    handleRemoteEventRef.current = handleRemoteEvent;
  }, [handleRemoteEvent]);

  // One-time hydration: pick up whatever was last playing anywhere on this
  // account, paused, so opening the app elsewhere shows the same track/spot
  // without surprise-autoplaying audio the user didn't ask this device for.
  useEffect(() => {
    if (!token || hydratedRef.current) return;
    hydratedRef.current = true;
    fetchPlaybackState(token).then((state) => {
      if (!state || currentTrackRef.current) return;
      autoplayNextLoadRef.current = false;
      pendingSeekRef.current = state.position_secs;
      setQueue([state.track]);
      setCurrentTrackId(state.track.id);
    });
  }, [token]);

  // Live feed of other devices' playback changes. Reconnects on drop since
  // this is a long-lived background connection for as long as the app's open.
  useEffect(() => {
    if (!token) return;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    function connect() {
      socket = new WebSocket(playbackWsUrl(token!));
      socket.onmessage = (ev) => {
        try {
          handleRemoteEventRef.current(JSON.parse(ev.data));
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = () => {
        if (!stopped) retryTimer = setTimeout(connect, 3000);
      };
    }
    connect();

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      socket?.close();
    };
  }, [token]);

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

  // Same as enqueue, but if this device hasn't got anything "current" yet,
  // never autoplay the track it ends up setting — used when a jam adds to
  // this device's queue automatically (useJam), so a device that's just
  // along for the ride (hasn't hydrated/started playing anything of its
  // own) can't accidentally autoplay and, via the existing "only one
  // device plays at a time" cross-device sync, steal playback away from
  // whichever device is actually meant to be the jam's audio source.
  const enqueueQuiet = useCallback((track: Track) => {
    setQueue((q) => [...q, track]);
    setCurrentTrackId((id) => {
      if (id) return id;
      autoplayNextLoadRef.current = false;
      return track.id;
    });
  }, []);

  // Put a track directly after the one playing now. If nothing is playing,
  // this has the same useful behaviour as adding the first item to a queue.
  const enqueueNext = useCallback(
    (track: Track) => {
      setQueue((q) => {
        const currentIndex = q.findIndex((item) => item.id === currentTrackId);
        if (currentIndex < 0) return [...q, track];
        return [...q.slice(0, currentIndex + 1), track, ...q.slice(currentIndex + 1)];
      });
      setCurrentTrackId((id) => id ?? track.id);
    },
    [currentTrackId],
  );

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
  useEffect(() => {
    nextRef.current = next;
  }, [next]);
  useEffect(() => {
    prevRef.current = prev;
  }, [prev]);

  // Asks "whichever device is actually playing" to skip — see the Command
  // branch in handleRemoteEvent above. Always goes through the broadcast
  // (even when this device is itself the one playing, its own socket gets
  // its own broadcast back) rather than also calling next()/prev() here
  // directly, so there's exactly one code path to reason about.
  const sendSkipCommand = useCallback(
    (direction: "next" | "prev") => {
      if (!token) return;
      sendPlaybackCommand(token, deviceIdRef.current, direction);
    },
    [token],
  );

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
      if (!audioElement) return;
      audioElement.currentTime = seconds;
      pushPlaybackState(isPlayingRef.current);
    },
    [audioElement, pushPlaybackState],
  );

  // Load whatever track is now "current" into the <audio> element. Normal
  // local actions (play/skip/etc.) autoplay as before; a hydration or
  // idle-device sync sets autoplayNextLoadRef false first to only update
  // what's displayed without actually starting audio on this device.
  useEffect(() => {
    if (!audioElement || !currentTrack) return;
    const url = streamUrl(currentTrack, token);
    if (!url) return;
    audioElement.src = url;
    if (autoplayNextLoadRef.current) {
      audioElement.play().catch(() => {});
    } else {
      autoplayNextLoadRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id, token, audioElement]);

  // Re-runs once audioElement actually becomes non-null (the fix: depending
  // on the element itself, not a ref to it, so React knows to retry once
  // the <audio> tag mounts for real past the auth gate).
  useEffect(() => {
    if (!audioElement) return;
    const onTime = () => setCurrentTime(audioElement.currentTime);
    const onLoaded = () => {
      setDuration(audioElement.duration || 0);
      if (pendingSeekRef.current != null) {
        audioElement.currentTime = pendingSeekRef.current;
        setCurrentTime(pendingSeekRef.current);
        pendingSeekRef.current = null;
      }
    };
    const onPlay = () => {
      setIsPlaying(true);
      pushPlaybackState(true, { force: true });
    };
    const onPause = () => {
      setIsPlaying(false);
      pushPlaybackState(false, { force: true });
    };
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
  }, [audioElement, handleEnded, pushPlaybackState]);

  // Keeps the server's position roughly fresh while playing, so a device
  // opening mid-track doesn't hydrate several minutes behind.
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => pushPlaybackState(true), 5000);
    return () => clearInterval(interval);
  }, [isPlaying, pushPlaybackState]);

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
    enqueueQuiet,
    enqueueNext,
    removeFromQueue,
    moveInQueue,
    next,
    prev,
    toggleShuffle,
    cycleRepeat,
    togglePlay,
    seek,
    sendSkipCommand,
  };
}
