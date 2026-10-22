import { useEffect, useState } from "react";
import { fetchLikes } from "./api";
import { LikeButton } from "./LikeButton";
import { useLikesContext } from "./LikesContext";
import { TrackRow } from "./TrackRow";
import type { Playlist } from "./usePlaylists";
import type { Track } from "./types";

interface Props {
  token: string;
  playlists: Playlist[];
  onCreate: (name: string) => void;
  onDelete: (id: string) => void;
  onRemoveTrack: (playlistId: string, trackId: string) => void;
  onPlay: (tracks: Track[], startId?: string) => void;
}

export function PlaylistsView({ token, playlists, onCreate, onDelete, onRemoveTrack, onPlay }: Props) {
  const [newName, setNewName] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [likedTracks, setLikedTracks] = useState<Track[]>([]);
  const [likedOpen, setLikedOpen] = useState(false);
  const { isLiked } = useLikesContext();

  useEffect(() => {
    fetchLikes(token).then(setLikedTracks);
  }, [token]);

  // Filtered live against the shared likes context, so unliking a track
  // from this list removes it immediately instead of waiting for a refetch.
  const visibleLikedTracks = likedTracks.filter(isLiked);

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
        <li>
          <div className="playlist-header">
            <button onClick={() => setLikedOpen((open) => !open)}>
              {likedOpen ? "▾" : "▸"} Liked Songs ({visibleLikedTracks.length})
            </button>
            {visibleLikedTracks.length > 0 && <button onClick={() => onPlay(visibleLikedTracks)}>Play</button>}
          </div>
          {likedOpen && (
            <ul className="track-list">
              {visibleLikedTracks.map((track) => (
                <TrackRow key={track.id} track={track} onPlay={() => onPlay(visibleLikedTracks, track.id)}>
                  <LikeButton track={track} />
                </TrackRow>
              ))}
            </ul>
          )}
        </li>
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
                    <LikeButton track={track} />
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
