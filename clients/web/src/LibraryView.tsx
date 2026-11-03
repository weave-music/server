import { useEffect, useState } from "react";
import { fetchLikes, fetchLocalLibrary, fetchPlaylistDetail, type PlaylistSummary } from "./api";
import { EmptyState } from "./EmptyState";
import { LibraryIcon } from "./icons";
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

export function LibraryView({
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

  const [localTracks, setLocalTracks] = useState<Track[]>([]);
  const [localOpen, setLocalOpen] = useState(false);
  const [localShuffleKey, setLocalShuffleKey] = useState(0);

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

  // Only fetched once the section is actually opened — browsing the local
  // folder isn't the common path, so there's no reason to pull a shuffled
  // sample on every Library page visit.
  useEffect(() => {
    if (!localOpen) return;
    fetchLocalLibrary(token).then(setLocalTracks);
  }, [token, localOpen, localShuffleKey]);

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
      <h2>Liked Songs</h2>
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
                <TrackRow
                  key={track.id}
                  track={track}
                  onPlay={() => onPlay(visibleLikedTracks, track.id)}
                  upgradeStatus={track.upgrade_status}
                >
                  <LikeButton track={track} />
                </TrackRow>
              ))}
            </ul>
          )}
        </li>
      </ul>

      <h2>Your Playlists</h2>
      <form className="playlists-create-form" onSubmit={createPlaylist}>
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

      <h2>Your Music Library</h2>
      <ul className="playlist-list">
        <li>
          <div className="playlist-header">
            <button onClick={() => setLocalOpen((open) => !open)}>
              {localOpen ? "▾" : "▸"} Browse local files
            </button>
            {localOpen && (
              <>
                {localTracks.length > 0 && <button onClick={() => onPlay(localTracks)}>Play</button>}
                <button onClick={() => setLocalShuffleKey((k) => k + 1)}>Shuffle again</button>
              </>
            )}
          </div>
          {localOpen && localTracks.length === 0 && (
            <EmptyState
              icon={<LibraryIcon />}
              title="No local files found"
              message="Nothing in your local music folder yet — tracks you like get downloaded here, or add files directly to the library path."
            />
          )}
          {localOpen && localTracks.length > 0 && (
            <>
              <p className="jam-room-empty">
                A shuffled sample from your local music folder — not yet grouped by artist or album.
              </p>
              <ul className="track-list">
                {localTracks.map((track) => (
                  <TrackRow key={track.id} track={track} onPlay={() => onPlay(localTracks, track.id)}>
                    <LikeButton track={track} />
                  </TrackRow>
                ))}
              </ul>
            </>
          )}
        </li>
      </ul>

      {otherPlaylists.length > 0 && (
        <>
          <h2>Shared Playlists</h2>
          <p className="jam-room-empty">From other people on this server</p>
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
