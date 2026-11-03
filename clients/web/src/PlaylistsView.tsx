import { useEffect, useState } from "react";
import { fetchLikes, fetchPlaylistDetail, type PlaylistSummary } from "./api";
import { LikeButton } from "./LikeButton";
import { useLikesContext } from "./LikesContext";
import { TrackRow } from "./TrackRow";
import type { Playlist } from "./usePlaylists";
import type { Track } from "./types";

interface Props {
  token: string;
  selfId: string;
  playlists: Playlist[];
  allPlaylists: PlaylistSummary[];
  onCreate: (name: string) => void;
  onDelete: (id: string) => void;
  onRemoveTrack: (playlistId: string, trackId: string) => void;
  onPlay: (tracks: Track[], startId?: string) => void;
}

export function PlaylistsView({
  token,
  selfId,
  playlists,
  allPlaylists,
  onCreate,
  onDelete,
  onRemoveTrack,
  onPlay,
}: Props) {
  const [newName, setNewName] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [likedTracks, setLikedTracks] = useState<Track[]>([]);
  const [likedOpen, setLikedOpen] = useState(false);
  const { isLiked } = useLikesContext();

  // Lazy-loaded per playlist on expand — unlike "your playlists" (already
  // fetched with tracks included), browsing someone else's is read-only and
  // uncommon enough that fetching every other user's full tracklist upfront
  // would be wasted work most of the time.
  const [openOtherId, setOpenOtherId] = useState<string | null>(null);
  const [otherTracks, setOtherTracks] = useState<Record<string, Track[]>>({});
  const otherPlaylists = allPlaylists.filter((pl) => pl.owner_id !== selfId);

  // Collaborative playlists are editable by anyone, but `otherTracks` is
  // this component's own cache (fetched lazily on expand) — removing a
  // track needs to patch it locally too, or the stale list would stick
  // around until the next expand/collapse re-fetch.
  function removeOtherTrack(playlistId: string, trackId: string) {
    setOtherTracks((prev) => ({
      ...prev,
      [playlistId]: (prev[playlistId] ?? []).filter((t) => t.id !== trackId),
    }));
    onRemoveTrack(playlistId, trackId);
  }

  function toggleOther(pl: PlaylistSummary) {
    if (openOtherId === pl.id) {
      setOpenOtherId(null);
      return;
    }
    setOpenOtherId(pl.id);
    if (!otherTracks[pl.id]) {
      fetchPlaylistDetail(token, pl.id).then((detail) => {
        if (detail) setOtherTracks((prev) => ({ ...prev, [pl.id]: detail.tracks }));
      });
    }
  }

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
      <form className="playlists-create-form" onSubmit={createPlaylist}>
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

      {otherPlaylists.length > 0 && (
        <>
          <h3>From other people on this server</h3>
          <ul className="playlist-list">
            {otherPlaylists.map((pl) => {
              const tracks = otherTracks[pl.id] ?? [];
              return (
                <li key={pl.id}>
                  <div className="playlist-header">
                    <button onClick={() => toggleOther(pl)}>
                      {openOtherId === pl.id ? "▾" : "▸"} {pl.name} ({pl.track_count}) — by {pl.owner_username}
                    </button>
                    {tracks.length > 0 && <button onClick={() => onPlay(tracks)}>Play</button>}
                  </div>
                  {openOtherId === pl.id && (
                    <ul className="track-list">
                      {tracks.map((track) => (
                        <TrackRow key={track.id} track={track} onPlay={() => onPlay(tracks, track.id)}>
                          <LikeButton track={track} />
                          <button onClick={() => removeOtherTrack(pl.id, track.id)} title="Remove">
                            ✕
                          </button>
                        </TrackRow>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
