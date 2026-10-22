import { useCallback, useEffect, useRef, useState } from "react";
import {
  addToJamQueue,
  createJam,
  endJam as endJamRequest,
  fetchJamRecommendations,
  fetchJamState,
  jamWsUrl,
  postJamPlayback,
  type JamEvent,
  type JamState,
} from "./jamApi";
import type { useQueue } from "./useQueue";
import type { Track } from "./types";

// Shared by both the host panel and the guest room: fetches one snapshot,
// then stays live over the jam's WebSocket. `onEvent` lets the host layer
// (useJam, below) react to events too, without this hook needing to know
// anything about a real playback queue.
export function useJamViewer(jamToken: string | null, jamId: string | null, onEvent?: (event: JamEvent) => void) {
  const [state, setState] = useState<JamState | null>(null);
  const [recommendations, setRecommendations] = useState<Track[]>([]);
  const [ended, setEnded] = useState(false);

  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const refreshRecommendations = useCallback(() => {
    if (!jamToken || !jamId) return;
    fetchJamRecommendations(jamToken, jamId).then(setRecommendations);
  }, [jamToken, jamId]);

  useEffect(() => {
    if (!jamToken || !jamId) {
      setState(null);
      setEnded(false);
      return;
    }
    let cancelled = false;
    fetchJamState(jamToken, jamId).then((s) => {
      if (!cancelled) setState(s);
    });
    refreshRecommendations();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jamToken, jamId]);

  const handleEvent = useCallback(
    (event: JamEvent) => {
      onEventRef.current?.(event);
      switch (event.type) {
        case "MemberJoined":
          setState((s) => (s ? { ...s, members: [...s.members, { name: event.name, is_host: false }] } : s));
          break;
        case "QueueAdded":
          setState((s) =>
            s
              ? {
                  ...s,
                  queue_log: [
                    ...s.queue_log,
                    { id: `${Date.now()}-${Math.random()}`, track: event.track, added_by_name: event.added_by_name },
                  ],
                }
              : s,
          );
          refreshRecommendations();
          break;
        case "PlaybackUpdated":
          setState((s) => (s ? { ...s, live: event.live } : s));
          break;
        case "Ended":
          setEnded(true);
          break;
      }
    },
    [refreshRecommendations],
  );
  const handleEventRef = useRef(handleEvent);
  useEffect(() => {
    handleEventRef.current = handleEvent;
  }, [handleEvent]);

  useEffect(() => {
    if (!jamToken || !jamId) return;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    function connect() {
      socket = new WebSocket(jamWsUrl(jamToken!, jamId!));
      socket.onmessage = (ev) => {
        try {
          handleEventRef.current(JSON.parse(ev.data));
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
  }, [jamToken, jamId]);

  const addTrack = useCallback(
    (track: Track) => {
      if (!jamToken || !jamId) return;
      void addToJamQueue(jamToken, jamId, track);
    },
    [jamToken, jamId],
  );

  return { state, recommendations, ended, addTrack };
}

// Host side: starts/ends jams and is the only thing that ever calls
// queueApi.enqueue in response to a jam event — the jam layer otherwise
// knows nothing about playback order/shuffle/repeat, which stay entirely
// owned by useQueue.
export function useJam(token: string | null, queueApi: ReturnType<typeof useQueue>) {
  const [jam, setJam] = useState<{ jamId: string; token: string } | null>(null);

  const queueApiRef = useRef(queueApi);
  useEffect(() => {
    queueApiRef.current = queueApi;
  }, [queueApi]);

  const onJamEvent = useCallback((event: JamEvent) => {
    if (event.type === "QueueAdded") queueApiRef.current.enqueue(event.track);
  }, []);

  const viewer = useJamViewer(jam?.token ?? null, jam?.jamId ?? null, onJamEvent);

  const startJam = useCallback(async () => {
    if (!token) return;
    const { jam_id, token: jamToken } = await createJam(token);
    setJam({ jamId: jam_id, token: jamToken });
  }, [token]);

  const endJam = useCallback(async () => {
    if (!jam) return;
    await endJamRequest(jam.token, jam.jamId);
    setJam(null);
  }, [jam]);

  // Mirrors "now playing" + the real queue's tail for guests to watch —
  // pushed right away on track/play-state change, and every 5s otherwise
  // (same cadence idea as the cross-device playback heartbeat).
  useEffect(() => {
    if (!jam) return;
    const activeJam = jam;
    function push() {
      const q = queueApiRef.current;
      const idx = q.currentTrack ? q.queue.findIndex((t) => t.id === q.currentTrack!.id) : -1;
      const upcoming = idx >= 0 ? q.queue.slice(idx + 1) : [];
      postJamPlayback(activeJam.token, activeJam.jamId, q.currentTrack, q.currentTime, q.isPlaying, upcoming);
    }
    push();
    const interval = setInterval(push, 5000);
    return () => clearInterval(interval);
  }, [jam, queueApi.currentTrack?.id, queueApi.isPlaying]);

  return {
    jam,
    joinUrl: jam ? `${location.origin}/jam/${jam.jamId}` : null,
    members: viewer.state?.members ?? [],
    queueLog: viewer.state?.queue_log ?? [],
    live: viewer.state?.live ?? null,
    recommendations: viewer.recommendations,
    ended: viewer.ended,
    startJam,
    endJam,
    addTrack: viewer.addTrack,
  };
}
