import { useCallback, useEffect, useRef, useState } from "react";

export type SleepTimerMode = { kind: "duration"; minutes: number } | { kind: "end-of-track" } | null;

// Owned by App.tsx (not NowPlayingView, which mounts/unmounts as the user
// navigates) so a running timer survives closing the full-player view.
export function useSleepTimer(pause: () => void, currentTrackId: string | null) {
  const [mode, setMode] = useState<SleepTimerMode>(null);
  const [minutesLeft, setMinutesLeft] = useState<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The track that was "current" when "end of track" was armed — watched
  // for below, rather than hooking into useQueue's own advance-on-ended
  // logic, which is already a delicate cross-device-sync state machine
  // not worth risking for this.
  const armedTrackIdRef = useRef<string | null>(null);

  const clearTimers = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    timeoutRef.current = null;
    intervalRef.current = null;
  }, []);

  const cancelTimer = useCallback(() => {
    clearTimers();
    armedTrackIdRef.current = null;
    setMode(null);
    setMinutesLeft(null);
  }, [clearTimers]);

  const setDurationTimer = useCallback(
    (minutes: number) => {
      clearTimers();
      armedTrackIdRef.current = null;
      const endsAt = Date.now() + minutes * 60_000;
      setMode({ kind: "duration", minutes });
      setMinutesLeft(minutes);
      timeoutRef.current = setTimeout(() => {
        pause();
        cancelTimer();
      }, minutes * 60_000);
      intervalRef.current = setInterval(() => {
        setMinutesLeft(Math.max(0, Math.ceil((endsAt - Date.now()) / 60_000)));
      }, 15_000);
    },
    [clearTimers, pause, cancelTimer],
  );

  const setEndOfTrackTimer = useCallback(() => {
    clearTimers();
    armedTrackIdRef.current = currentTrackId;
    setMode({ kind: "end-of-track" });
    setMinutesLeft(null);
  }, [clearTimers, currentTrackId]);

  // Fires once the track that was playing when "end of track" was armed
  // changes to something else (it finished and the queue advanced) —
  // pauses right away, so at most a brief instant of the next track plays
  // before stopping.
  useEffect(() => {
    if (mode?.kind !== "end-of-track" || armedTrackIdRef.current === null) return;
    if (currentTrackId !== armedTrackIdRef.current) {
      pause();
      cancelTimer();
    }
  }, [currentTrackId, mode, pause, cancelTimer]);

  useEffect(() => clearTimers, [clearTimers]);

  return { mode, minutesLeft, setDurationTimer, setEndOfTrackTimer, cancelTimer };
}
