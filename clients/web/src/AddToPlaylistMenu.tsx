import { useState } from "react";
import { PlaylistIcon } from "./icons";
import type { Playlist } from "./usePlaylists";
import type { Track } from "./types";

interface Props {
  track: Track;
  playlists: Playlist[];
  onAddToPlaylist: (playlistId: string, track: Track) => void;
  onCreatePlaylist: (name: string, initialTracks?: Track[]) => void;
}

export function AddToPlaylistMenu({ track, playlists, onAddToPlaylist, onCreatePlaylist }: Props) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");

  function createAndAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    onCreatePlaylist(newName.trim(), [track]);
    setNewName("");
    setOpen(false);
  }

  return (
    <div className="add-to-playlist">
      <button onClick={() => setOpen((o) => !o)} title="Add to playlist">
        <PlaylistIcon /> Playlist
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="add-to-playlist-menu">
            {playlists.length === 0 && <p className="add-to-playlist-empty">No playlists yet</p>}
            {playlists.map((pl) => (
              <button
                key={pl.id}
                onClick={() => {
                  onAddToPlaylist(pl.id, track);
                  setOpen(false);
                }}
              >
                {pl.name}
              </button>
            ))}
            <form onSubmit={createAndAdd}>
              <input
                autoFocus={playlists.length === 0}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New playlist..."
              />
              <button type="submit">Create</button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
