import { useCallback, useEffect, useRef, useState } from "react";
import {
  addToJamQueue,
  createJam,
  endJam as endJamRequest,
  fetchJamRecommendations,
  fetchJamState,
  fetchMyActiveJam,
  jamWsUrl,
  postJamPlayback,
  sendJamCommand,
  type JamEvent,
  type JamState,
  type RemoteCommandName,
} from "./jamApi";
import type { useQueue } from "./useQueue";
import type { Track } from "./types";

const HOST_MEMBERSHIP_KEY = "weave.jam-host";

interface StoredHostMembership {
  jamId: string;
  token: string;
  isSource: boolean;
}

// Without this, every page reload minted a brand-new host member row via
// createJam (it's safe to call repeatedly — see below — but always returns
// a *fresh* token), so refreshing the host's own device repeatedly added
// another "admin" to the jam's member list instead of reusing the same one.
function loadHostMembership(): StoredHostMembership | null {
  try {
    const raw = localStorage.getItem(HOST_MEMBERSHIP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveHostMembership(membership: StoredHostMembership) {
  localStorage.setItem(HOST_MEMBERSHIP_KEY, JSON.stringify(membership));
}

function clearHostMembership() {
  localStorage.removeItem(HOST_MEMBERSHIP_KEY);
}

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
          // Dedupe by the server-assigned log id — a broadcast channel
          // doesn't guarantee exactly-once delivery (e.g. a brief window
          // with two live sockets open, such as React StrictMode's dev-mode
          // double effect invocation), so the same add can arrive twice.
          setState((s) => {
            if (!s || s.queue_log.some((entry) => entry.id === event.id)) return s;
            return {
              ...s,
              queue_log: [...s.queue_log, { id: event.id, track: event.track, added_by_name: event.added_by_name }],
            };
          });
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
// queueApi.enqueueQuiet in response to a jam event — the jam layer
// otherwise knows nothing about playback order/shuffle/repeat, which stay
// entirely owned by useQueue. enqueueQuiet (not enqueue) matters here: a
// device that just hydrated into the jam and hasn't started playing
// anything of its own must never autoplay off of a synced queue addition —
// only the device someone actually hit play on should ever be the audio
// source (see the comment on enqueueQuiet in useQueue.ts).
//
// "Source" is an explicit, sticky concept, not a per-instant heuristic:
// whichever device's create_jam call actually created the jam stays the
// one real audio source for its whole lifetime (see is_source in main.rs).
// Every other host-role device — including the same account's own other
// devices — is a remote: it can send Play/Pause/Next/Prev/Volume, but only
// ever acts on a RemoteCommand locally when it IS the source, so a remote
// pressing its own Play button can never accidentally start competing
// local playback (which is exactly how the old "whichever device happens
// to have isPlaying=true" heuristic could get hijacked).
export function useJam(token: string | null, queueApi: ReturnType<typeof useQueue>) {
  const [jam, setJam] = useState<{ jamId: string; token: string; isSource: boolean } | null>(null);
  const jamRef = useRef(jam);
  useEffect(() => {
    jamRef.current = jam;
  }, [jam]);

  const queueApiRef = useRef(queueApi);
  useEffect(() => {
    queueApiRef.current = queueApi;
  }, [queueApi]);

  // Tracks which QueueAdded ids have already been enqueued into the real
  // queue — same dedupe reasoning as useJamViewer's queue_log, but this one
  // matters more: without it, duplicate delivery would double-add the
  // track to actual playback, not just to a display list.
  const enqueuedIdsRef = useRef<Set<string>>(new Set());
  const onJamEvent = useCallback((event: JamEvent) => {
    if (event.type === "QueueAdded") {
      if (enqueuedIdsRef.current.has(event.id)) return;
      enqueuedIdsRef.current.add(event.id);
      queueApiRef.current.enqueueQuiet(event.track);
      return;
    }
    if (event.type === "RemoteCommand") {
      if (!jamRef.current?.isSource) return; // not the source — not mine to act on
      const q = queueApiRef.current;
      switch (event.command) {
        case "play":
          q.play();
          break;
        case "pause":
          q.pause();
          break;
        case "next":
          q.next();
          break;
        case "prev":
          q.prev();
          break;
        case "volume":
          if (event.value != null) q.setVolume(event.value);
          break;
      }
    }
  }, []);

  const viewer = useJamViewer(jam?.token ?? null, jam?.jamId ?? null, onJamEvent);

  // On load, hydrate into a jam this account already has running — either
  // on this same device (reusing its own stored membership, so a refresh
  // doesn't re-join as a fresh "admin" every time) or on another device
  // (minting this device its own token once, then remembering it too).
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const stored = loadHostMembership();
    fetchMyActiveJam(token).then((activeJamId) => {
      if (cancelled) return;
      if (!activeJamId) {
        clearHostMembership();
        return;
      }
      if (stored && stored.jamId === activeJamId) {
        setJam({ jamId: stored.jamId, token: stored.token, isSource: stored.isSource });
        return;
      }
      createJam(token).then(({ jam_id, token: jamToken, is_source }) => {
        if (cancelled) return;
        saveHostMembership({ jamId: jam_id, token: jamToken, isSource: is_source });
        setJam({ jamId: jam_id, token: jamToken, isSource: is_source });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const startJam = useCallback(async () => {
    if (!token) return;
    const { jam_id, token: jamToken, is_source } = await createJam(token);
    saveHostMembership({ jamId: jam_id, token: jamToken, isSource: is_source });
    setJam({ jamId: jam_id, token: jamToken, isSource: is_source });
  }, [token]);

  const endJam = useCallback(async () => {
    if (!jam) return;
    await endJamRequest(jam.token, jam.jamId);
    clearHostMembership();
    setJam(null);
  }, [jam]);

  // The jam ended from somewhere else (another host device, or it simply
  // wound down) — drop the stored membership so the next load doesn't try
  // to resume a dead jam.
  useEffect(() => {
    if (viewer.ended) clearHostMembership();
  }, [viewer.ended]);

  // Mirrors "now playing" + the real queue's tail for guests to watch —
  // pushed right away on track/play-state change, and every 5s otherwise
  // (same cadence idea as the cross-device playback heartbeat). Every
  // host-role device does this, not just the source — a remote's own
  // queueApi mirrors the same account's cross-device playback state, so
  // this is mostly redundant with the source's own heartbeat but harmless
  // (jam_live is just overwritten with equivalent data either way).
  useEffect(() => {
    if (!jam) return;
    const activeJam = jam;
    function push() {
      const q = queueApiRef.current;
      const idx = q.currentTrack ? q.queue.findIndex((t) => t.id === q.currentTrack!.id) : -1;
      const upcoming = idx >= 0 ? q.queue.slice(idx + 1) : [];
      postJamPlayback(activeJam.token, activeJam.jamId, q.currentTrack, q.currentTime, q.isPlaying, upcoming, q.volume);
    }
    push();
    const interval = setInterval(push, 5000);
    return () => clearInterval(interval);
  }, [jam, queueApi.currentTrack?.id, queueApi.isPlaying, queueApi.volume]);

  // Fire-and-forget nudge to the source — this device acts on it too if it
  // turns out to be the source (see the RemoteCommand branch above), since
  // every host-role device receives its own jam ws broadcast back.
  const sendCommand = useCallback(
    (command: RemoteCommandName, value?: number) => {
      if (!jam) return;
      sendJamCommand(jam.token, jam.jamId, command, value);
    },
    [jam],
  );

  return {
    jam,
    isSource: jam?.isSource ?? false,
    joinUrl: jam ? `${location.origin}/jam/${jam.jamId}` : null,
    members: viewer.state?.members ?? [],
    queueLog: viewer.state?.queue_log ?? [],
    live: viewer.state?.live ?? null,
    recommendations: viewer.recommendations,
    ended: viewer.ended,
    startJam,
    endJam,
    addTrack: viewer.addTrack,
    sendCommand,
  };
}
