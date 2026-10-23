import type { Track } from "./types";

export interface JamMemberInfo {
  name: string;
  is_host: boolean;
}

// The host can have more than one *device* in the member list (laptop +
// phone co-hosting the same jam), but that's still just one person — collapse
// every host row down to a single entry so "Who's Here" and the people
// count reflect real people, not device/session count. Guests aren't
// deduped: two distinct joins are two distinct people even if their chosen
// names happen to collide.
export function dedupeMembers(members: JamMemberInfo[]): JamMemberInfo[] {
  const host = members.find((m) => m.is_host);
  const guests = members.filter((m) => !m.is_host);
  return host ? [host, ...guests] : guests;
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
  volume: number;
}

export interface JamState {
  jam_id: string;
  members: JamMemberInfo[];
  queue_log: JamQueueLogEntry[];
  live: JamLive | null;
}

export type RemoteCommandName = "play" | "pause" | "next" | "prev" | "volume";

export type JamEvent =
  | { type: "MemberJoined"; jam_id: string; name: string }
  | { type: "QueueAdded"; jam_id: string; id: string; track: Track; added_by_name: string }
  | { type: "PlaybackUpdated"; jam_id: string; live: JamLive }
  | { type: "RemoteCommand"; jam_id: string; command: RemoteCommandName; value: number | null }
  | { type: "Ended"; jam_id: string };

// Starting a jam uses the caller's real login token — every other jam
// action below uses the jam-scoped token this returns instead, which only
// ever authenticates jam routes (see JamMember in auth.rs). Safe to call
// even when this account already has a jam running elsewhere — the server
// resumes it (issuing this device its own host token for the same jam)
// instead of ending it out from under whichever device started it.
// `is_source` is true only for the device whose call actually created the
// jam — that device stays the real audio source for the jam's whole
// lifetime; every other host-role device is a remote (see useJam.ts).
export async function createJam(loginToken: string): Promise<{ jam_id: string; token: string; is_source: boolean }> {
  const res = await fetch("/api/jam", { method: "POST", headers: { Authorization: `Bearer ${loginToken}` } });
  if (!res.ok) throw new Error("Could not start jam.");
  return res.json();
}

// Fire-and-forget nudge to whichever device is this jam's source — see
// RemoteCommand in auth.rs/main.rs for why no server-side targeting is
// needed (every host-role device gets it, only the source acts on it).
export function sendJamCommand(jamToken: string, jamId: string, command: RemoteCommandName, value?: number): void {
  fetch(`/api/jam/${encodeURIComponent(jamId)}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jamToken}` },
    body: JSON.stringify({ command, value }),
  }).catch(() => {});
}

// Lightweight presence check for hydrating a newly-opened device into a
// jam this account already has running elsewhere — doesn't issue a token
// or create a member row by itself.
export async function fetchMyActiveJam(loginToken: string): Promise<string | null> {
  const res = await fetch("/api/jam/mine", { headers: { Authorization: `Bearer ${loginToken}` } });
  if (!res.ok || res.status === 204) return null;
  const data = await res.json();
  return data.jam_id ?? null;
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
  volume: number,
): void {
  fetch(`/api/jam/${encodeURIComponent(jamId)}/playback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jamToken}` },
    body: JSON.stringify({ track, position_secs: positionSecs, is_playing: isPlaying, upcoming, volume }),
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
