import type { ExternalPlaylist, ReleaseSummary, Track } from "./types";

// Streaming goes through <audio src>, which can't set an Authorization
// header, so the token travels as a query param there instead (the same
// reason Subsonic-style APIs put auth in the URL for media endpoints).
export function streamUrl(track: Track, token: string | null): string | null {
  const source = track.sources[0];
  if (!source) return null;
  const params = new URLSearchParams({ provider: source.provider_id, ref: source.source_ref });
  if (token) params.set("token", token);
  return `/api/stream?${params.toString()}`;
}

export async function fetchLikes(token: string): Promise<Track[]> {
  const res = await fetch("/api/likes", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results ?? [];
}

export async function likeTrack(token: string, track: Track): Promise<void> {
  await fetch("/api/likes", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(track),
  });
}

export async function unlikeTrack(token: string, track: Track): Promise<void> {
  const source = track.sources[0];
  if (!source) return;
  const params = new URLSearchParams({ provider: source.provider_id, ref: source.source_ref });
  await fetch(`/api/likes?${params.toString()}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function searchTracks(query: string, token: string): Promise<Track[]> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.results ?? [];
}

// Randomized discovery, not personalized recommendations — there's no
// listening history or taste profile behind this yet.
export async function fetchFeatured(token: string): Promise<Track[]> {
  const res = await fetch("/api/featured", { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.results ?? [];
}

export async function fetchRadio(token: string, track: Track): Promise<Track[]> {
  const source = track.sources[0];
  if (!source) return [];
  const params = new URLSearchParams({ provider: source.provider_id, ref: source.source_ref });
  const res = await fetch(`/api/radio?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results ?? [];
}

export async function fetchArtistTracks(token: string, providerId: string, artistRef: string): Promise<Track[]> {
  const params = new URLSearchParams({ provider: providerId, ref: artistRef });
  const res = await fetch(`/api/artist?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results ?? [];
}

export async function fetchAlbumTracks(token: string, providerId: string, albumRef: string): Promise<Track[]> {
  const params = new URLSearchParams({ provider: providerId, ref: albumRef });
  const res = await fetch(`/api/album?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results ?? [];
}

// Separate from searchTracks — kept as its own request (rather than folded
// into /api/search's response) so a plain track search doesn't pay for a
// playlist lookup it isn't going to use.
export async function searchExternalPlaylists(query: string, token: string): Promise<ExternalPlaylist[]> {
  const res = await fetch(`/api/search/playlists?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.playlists ?? [];
}

export async function fetchPlaylistTracks(token: string, providerId: string, playlistRef: string): Promise<Track[]> {
  const params = new URLSearchParams({ provider: providerId, ref: playlistRef });
  const res = await fetch(`/api/playlist?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results ?? [];
}

export async function fetchArtistReleases(
  token: string,
  providerId: string,
  artistRef: string,
): Promise<ReleaseSummary[]> {
  const params = new URLSearchParams({ provider: providerId, ref: artistRef });
  const res = await fetch(`/api/artist/releases?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.releases ?? [];
}

export interface PlaybackState {
  track: Track;
  position_secs: number;
  is_playing: boolean;
  device_id: string;
}

export async function fetchPlaybackState(token: string): Promise<PlaybackState | null> {
  const res = await fetch("/api/playback", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok || res.status === 204) return null;
  return res.json();
}

// Fire-and-forget: a dropped sync update isn't worth surfacing to the user,
// the next heartbeat or play/pause will catch up.
export function updatePlaybackState(
  token: string,
  deviceId: string,
  track: Track,
  positionSecs: number,
  isPlaying: boolean,
): void {
  fetch("/api/playback", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ device_id: deviceId, track, position_secs: positionSecs, is_playing: isPlaying }),
  }).catch(() => {});
}

// Native WebSocket can't set an Authorization header, so auth travels as
// ?token= here too (same reason streamUrl does it).
export function playbackWsUrl(token: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/playback/ws?token=${encodeURIComponent(token)}`;
}

export async function getSetupComplete(): Promise<boolean> {
  const res = await fetch("/api/auth/setup");
  if (!res.ok) return true; // fail closed — don't dangle the setup option if the check itself fails
  const data = await res.json();
  return !!data.setup_complete;
}

export async function getRegistrationAllowed(): Promise<boolean> {
  const res = await fetch("/api/settings/registration");
  if (!res.ok) return false;
  const data = await res.json();
  return !!data.allow_registration;
}

export async function setRegistrationAllowed(token: string, allow: boolean): Promise<void> {
  const res = await fetch("/api/settings/registration", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ allow_registration: allow }),
  });
  if (!res.ok) throw new Error("Could not update setting.");
}

export async function getOidcLoginEnabled(): Promise<boolean> {
  const res = await fetch("/api/auth/oidc/status");
  if (!res.ok) return false;
  const data = await res.json();
  return !!data.enabled;
}

// Native navigation, not fetch — this needs to be a real top-level redirect
// (the IdP's login page, not a response this page's JS can read).
export function oidcLoginUrl(): string {
  return "/api/auth/oidc/login";
}

export interface OidcSettings {
  issuer: string;
  client_id: string;
  has_client_secret: boolean;
}

export async function getOidcSettings(token: string): Promise<OidcSettings> {
  const res = await fetch("/api/admin/oidc-settings", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("Could not load SSO settings.");
  return res.json();
}

export async function setOidcSettings(
  token: string,
  settings: { issuer: string; client_id: string; client_secret?: string },
): Promise<void> {
  const res = await fetch("/api/admin/oidc-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error("Could not save SSO settings.");
}

export interface LidarrSettings {
  url: string;
  has_api_key: boolean;
  root_folder: string;
  quality_profile_id: number | null;
}

export async function getLidarrSettings(token: string): Promise<LidarrSettings> {
  const res = await fetch("/api/admin/lidarr-settings", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("Could not load Lidarr settings.");
  return res.json();
}

export async function setLidarrSettings(
  token: string,
  settings: { url: string; api_key?: string; root_folder: string; quality_profile_id: number | null },
): Promise<void> {
  const res = await fetch("/api/admin/lidarr-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error("Could not save Lidarr settings.");
}

export interface LidarrRootFolder {
  id: number;
  path: string;
}

export interface LidarrQualityProfile {
  id: number;
  name: string;
}

export async function getLidarrRootFolders(token: string): Promise<LidarrRootFolder[]> {
  const res = await fetch("/api/admin/lidarr/root-folders", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("Could not reach Lidarr — check the URL and API key.");
  return res.json();
}

export async function getLidarrQualityProfiles(token: string): Promise<LidarrQualityProfile[]> {
  const res = await fetch("/api/admin/lidarr/quality-profiles", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("Could not reach Lidarr — check the URL and API key.");
  return res.json();
}

export async function getLidarrEnabled(token: string): Promise<boolean> {
  const res = await fetch("/api/lidarr/status", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return false;
  const data = await res.json();
  return !!data.enabled;
}

export interface LidarrArtistResult {
  artistName: string;
  foreignArtistId: string;
  overview?: string;
  remoteCoverUrl?: string;
  images?: { coverType: string; remoteUrl?: string; url?: string }[];
}

export async function searchLidarrArtists(token: string, query: string): Promise<LidarrArtistResult[]> {
  const res = await fetch(`/api/lidarr/search?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  return res.json();
}

export async function requestLidarrArtist(token: string, foreignArtistId: string, artistName: string): Promise<void> {
  const res = await fetch("/api/lidarr/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ foreign_artist_id: foreignArtistId, artist_name: artistName }),
  });
  if (!res.ok) throw new Error("Lidarr rejected the request.");
}

export interface UserInfo {
  id: string;
  username: string;
  is_admin: boolean;
  created_at: string;
}

export async function listUsers(token: string): Promise<UserInfo[]> {
  const res = await fetch("/api/users", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("Could not load users.");
  return res.json();
}

export async function createUser(
  token: string,
  username: string,
  password: string,
  isAdmin: boolean,
): Promise<UserInfo> {
  const res = await fetch("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username, password, is_admin: isAdmin }),
  });
  if (!res.ok) throw new Error("Could not create user — username may already be taken.");
  return res.json();
}

export async function deleteUser(token: string, id: string): Promise<void> {
  const res = await fetch(`/api/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Could not delete user.");
}
