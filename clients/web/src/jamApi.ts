import type { Track } from "./types";

export interface JamMemberInfo {
  name: string;
  is_host: boolean;
}

export interface JamQueueLogEntry {
  id: string;
  track: Track;
  added_by_name: string;
}

export interface JamLive {
  now_playing: Track | null;
  position_secs: number;
  is_playing: boolean;
  upcoming: Track[];
}

export interface JamState {
  jam_id: string;
  members: JamMemberInfo[];
  queue_log: JamQueueLogEntry[];
  live: JamLive | null;
}

export type JamEvent =
  | { type: "MemberJoined"; jam_id: string; name: string }
  | { type: "QueueAdded"; jam_id: string; track: Track; added_by_name: string }
  | { type: "PlaybackUpdated"; jam_id: string; live: JamLive }
  | { type: "Ended"; jam_id: string };

// Starting a jam uses the caller's real login token — every other jam
// action below uses the jam-scoped token this returns instead, which only
// ever authenticates jam routes (see JamMember in auth.rs).
export async function createJam(loginToken: string): Promise<{ jam_id: string; token: string }> {
  const res = await fetch("/api/jam", { method: "POST", headers: { Authorization: `Bearer ${loginToken}` } });
  if (!res.ok) throw new Error("Could not start jam.");
  return res.json();
}

export async function joinJam(jamId: string, name: string): Promise<{ jam_id: string; token: string; name: string }> {
  const res = await fetch(`/api/jam/${encodeURIComponent(jamId)}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("Could not join jam — it may have ended.");
  return res.json();
}

export async function fetchJamState(jamToken: string, jamId: string): Promise<JamState | null> {
  const res = await fetch(`/api/jam/${encodeURIComponent(jamId)}/state`, {
    headers: { Authorization: `Bearer ${jamToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

export async function addToJamQueue(jamToken: string, jamId: string, track: Track): Promise<void> {
  await fetch(`/api/jam/${encodeURIComponent(jamId)}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jamToken}` },
    body: JSON.stringify({ track }),
  });
}

// Fire-and-forget, same reasoning as updatePlaybackState: a dropped
// heartbeat isn't worth surfacing, the next one catches up.
export function postJamPlayback(
  jamToken: string,
  jamId: string,
  track: Track | null,
  positionSecs: number,
  isPlaying: boolean,
  upcoming: Track[],
): void {
  fetch(`/api/jam/${encodeURIComponent(jamId)}/playback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jamToken}` },
    body: JSON.stringify({ track, position_secs: positionSecs, is_playing: isPlaying, upcoming }),
  }).catch(() => {});
}

export async function endJam(jamToken: string, jamId: string): Promise<void> {
  await fetch(`/api/jam/${encodeURIComponent(jamId)}/end`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jamToken}` },
  });
}

export async function fetchJamRecommendations(jamToken: string, jamId: string): Promise<Track[]> {
  const res = await fetch(`/api/jam/${encodeURIComponent(jamId)}/recommendations`, {
    headers: { Authorization: `Bearer ${jamToken}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results ?? [];
}

// Native WebSocket can't set an Authorization header, so auth travels as
// ?token= here too (same reason playbackWsUrl does it).
export function jamWsUrl(jamToken: string, jamId: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/jam/${encodeURIComponent(jamId)}/ws?token=${encodeURIComponent(jamToken)}`;
}
