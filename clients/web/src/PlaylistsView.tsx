import { useState } from "react";
import { TrackRow } from "./TrackRow";
import type { Playlist } from "./usePlaylists";
import type { Track } from "./types";

interface Props {
  playlists: Playlist[];
  onCreate: (name: string) => void;
  onDelete: (id: string) => void;
  onRemoveTrack: (playlistId: string, trackId: string) => void;
  onPlay: (tracks: Track[], startId?: string) => void;
}

export function PlaylistsView({ playlists, onCreate, onDelete, onRemoveTrack, onPlay }: Props) {
  const [newName, setNewName] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  function createPlaylist(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    onCreate(newName.trim());
    setNewName("");
  }

  return (
    <section>
      <form onSubmit={createPlaylist}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New playlist name..."
        />
        <button type="submit">Create</button>
      </form>
      <ul className="playlist-list">
        {playlists.map((pl) => (
          <li key={pl.id}>
            <div className="playlist-header">
              <button onClick={() => setOpenId(openId === pl.id ? null : pl.id)}>
                {openId === pl.id ? "▾" : "▸"} {pl.name} ({pl.tracks.length})
              </button>
              {pl.tracks.length > 0 && <button onClick={() => onPlay(pl.tracks)}>Play</button>}
              <button onClick={() => onDelete(pl.id)}>Delete</button>
            </div>
            {openId === pl.id && (
              <ul className="track-list">
                {pl.tracks.map((track) => (
                  <TrackRow key={track.id} track={track} onPlay={() => onPlay(pl.tracks, track.id)}>
                    <button onClick={() => onRemoveTrack(pl.id, track.id)} title="Remove">
                      ✕
                    </button>
                  </TrackRow>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
