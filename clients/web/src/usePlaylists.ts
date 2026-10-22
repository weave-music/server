import { useCallback, useEffect, useState } from "react";
import { randomId } from "./randomId";
import type { Track } from "./types";

export interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
}

const STORAGE_KEY = "weave.playlists.v1";

// No server-side persistence yet (REQUIREMENTS.md §13 database decision is
// still open), so playlists live in the browser for now. Full track objects
// are stored rather than ids, since track ids aren't stable across searches
// without a backing library database.
export function usePlaylists() {
  const [playlists, setPlaylists] = useState<Playlist[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(playlists));
  }, [playlists]);

  const createPlaylist = useCallback((name: string, track?: Track) => {
    setPlaylists((p) => [...p, { id: randomId(), name, tracks: track ? [track] : [] }]);
  }, []);

  const deletePlaylist = useCallback((id: string) => {
    setPlaylists((p) => p.filter((pl) => pl.id !== id));
  }, []);

  const addTrackToPlaylist = useCallback((playlistId: string, track: Track) => {
    setPlaylists((p) =>
      p.map((pl) => (pl.id === playlistId ? { ...pl, tracks: [...pl.tracks, track] } : pl)),
    );
  }, []);

  const removeTrackFromPlaylist = useCallback((playlistId: string, trackId: string) => {
    setPlaylists((p) =>
      p.map((pl) =>
        pl.id === playlistId ? { ...pl, tracks: pl.tracks.filter((t) => t.id !== trackId) } : pl,
      ),
    );
  }, []);

  return { playlists, createPlaylist, deletePlaylist, addTrackToPlaylist, removeTrackFromPlaylist };
}
