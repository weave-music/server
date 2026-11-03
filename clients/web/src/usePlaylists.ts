import { useCallback, useEffect, useState } from "react";
import {
  addTrackToPlaylistApi,
  createPlaylistApi,
  deletePlaylistApi,
  fetchAllPlaylists,
  fetchMyPlaylists,
  removeTrackFromPlaylistApi,
  type PlaylistSummary,
} from "./api";
import { randomId } from "./randomId";
import type { Track } from "./types";

export interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
}

const LOCAL_STORAGE_KEY = "weave.playlists.v1";
const MIGRATED_FLAG_KEY = "weave.playlists.migrated.v1";

// One-time upload of whatever was in the old browser-local playlists (see
// git history before this hook became server-backed) so existing users
// don't lose them. Safe to call on every mount — it no-ops immediately
// once MIGRATED_FLAG_KEY is set, which happens right after a successful
// upload, before anything else touches the server.
async function migrateLocalPlaylists(token: string) {
  if (localStorage.getItem(MIGRATED_FLAG_KEY)) return;
  let local: Playlist[] = [];
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    local = raw ? JSON.parse(raw) : [];
  } catch {
    local = [];
  }
  if (local.length === 0) {
    localStorage.setItem(MIGRATED_FLAG_KEY, "1");
    return;
  }
  for (const pl of local) {
    try {
      const created = await createPlaylistApi(token, pl.name);
      for (const track of pl.tracks) {
        await addTrackToPlaylistApi(token, created.id, track);
      }
    } catch {
      // Leave the migrated flag unset so a retry on next load can pick up
      // whatever didn't make it across this time.
      return;
    }
  }
  localStorage.setItem(MIGRATED_FLAG_KEY, "1");
}

// Playlists are per-account and visible to every logged-in user on this
// server (self-hosted, trusted household — no private/public flag), backed
// by /api/playlists. `playlists` here is specifically the caller's own,
// full track lists included, matching this hook's shape from before it was
// server-backed so every consumer (PlaylistsView, AddToPlaylistMenu,
// SearchView, DetailView, NowPlayingView, TrackOverflowMenu) needed zero
// changes.
export function usePlaylists(token: string | null) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [allPlaylists, setAllPlaylists] = useState<PlaylistSummary[]>([]);

  const refresh = useCallback(async () => {
    if (!token) return;
    const [mine, all] = await Promise.all([fetchMyPlaylists(token), fetchAllPlaylists(token)]);
    setPlaylists(mine);
    setAllPlaylists(all);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    migrateLocalPlaylists(token).then(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const createPlaylist = useCallback(
    (name: string, initialTracks: Track[] = []) => {
      if (!token) return;
      // Optimistic placeholder so the new playlist appears immediately;
      // replaced wholesale by the next refresh() once the server confirms.
      const placeholder: Playlist = { id: randomId(), name, tracks: initialTracks };
      setPlaylists((p) => [...p, placeholder]);
      (async () => {
        try {
          const created = await createPlaylistApi(token, name);
          for (const track of initialTracks) {
            await addTrackToPlaylistApi(token, created.id, track);
          }
        } finally {
          refresh();
        }
      })();
    },
    [token, refresh],
  );

  const deletePlaylist = useCallback(
    (id: string) => {
      if (!token) return;
      setPlaylists((p) => p.filter((pl) => pl.id !== id));
      deletePlaylistApi(token, id).finally(refresh);
    },
    [token, refresh],
  );

  const addTrackToPlaylist = useCallback(
    (playlistId: string, track: Track) => {
      if (!token) return;
      setPlaylists((p) =>
        p.map((pl) => (pl.id === playlistId ? { ...pl, tracks: [...pl.tracks, track] } : pl)),
      );
      addTrackToPlaylistApi(token, playlistId, track).finally(refresh);
    },
    [token, refresh],
  );

  const removeTrackFromPlaylist = useCallback(
    (playlistId: string, trackId: string) => {
      if (!token) return;
      setPlaylists((p) =>
        p.map((pl) =>
          pl.id === playlistId ? { ...pl, tracks: pl.tracks.filter((t) => t.id !== trackId) } : pl,
        ),
      );
      removeTrackFromPlaylistApi(token, playlistId, trackId).finally(refresh);
    },
    [token, refresh],
  );

  // Playlists are collaborative by default (any logged-in user can add to
  // any playlist, matching the already-open visibility model), so "add to
  // playlist" menus should offer every playlist on the server, not just
  // the caller's own — `allPlaylists` already includes everyone's,
  // including the caller's, so this needs no merging.
  const addablePlaylists = allPlaylists.map((p) => ({ id: p.id, name: p.name }));

  return {
    playlists,
    allPlaylists,
    addablePlaylists,
    createPlaylist,
    deletePlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
  };
}
