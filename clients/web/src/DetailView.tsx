import { useEffect, useState } from "react";
import { fetchAlbumTracks, fetchArtistReleases, fetchArtistTracks, fetchRadio } from "./api";
import { Artwork } from "./Artwork";
import { EntityCard } from "./EntityCard";
import { ChevronLeftIcon, HeartFilledIcon, HeartIcon, PlayIcon, RadioIcon, ShareIcon, ShuffleIcon } from "./icons";
import { LikeButton } from "./LikeButton";
import { useLikesContext } from "./LikesContext";
import { TrackOverflowMenu } from "./TrackOverflowMenu";
import { TrackRow } from "./TrackRow";
import type { Playlist } from "./usePlaylists";
import type { ReleaseSummary, Track } from "./types";

export interface DetailTarget {
  type: "artist" | "album";
  providerId: string;
  ref: string;
  name: string;
  year?: string | null;
}

interface Props {
  target: DetailTarget;
  token: string;
  onClose: () => void;
  onPlay: (tracks: Track[], startId?: string) => void;
  onPlayNext: (track: Track) => void;
  onEnqueue: (track: Track) => void;
  onRadio: (track: Track) => void;
  onShare: (track: Track) => void | Promise<void>;
  onShareAlbum: (album: DetailTarget, artistName?: string | null) => void | Promise<void>;
  onShareArtist: (artist: DetailTarget) => void | Promise<void>;
  onOpenDetail: (target: DetailTarget) => void;
  playlists: Playlist[];
  onAddToPlaylist: (playlistId: string, track: Track) => void;
  onCreatePlaylist: (name: string, initialTracks?: Track[]) => void;
  onStartJam: () => void;
  jamActive: boolean;
}

const ARTIST_PAGE_SIZE = 10;

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function formatAlbumDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours} hr ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${Math.floor(seconds)} sec`;
}

export function DetailView({
  target,
  token,
  onClose,
  onPlay,
  onPlayNext,
  onEnqueue,
  onRadio,
  onShare,
  onShareAlbum,
  onShareArtist,
  onOpenDetail,
  playlists,
  onAddToPlaylist,
  onCreatePlaylist,
  onStartJam,
  jamActive,
}: Props) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [similarArtists, setSimilarArtists] = useState<Track[]>([]);
  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  const [addingAlbum, setAddingAlbum] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [artistPage, setArtistPage] = useState(0);
  const { isLiked, toggleLike } = useLikesContext();

  useEffect(() => {
    setLoading(true);
    setSimilarArtists([]);
    setReleases([]);
    setArtistPage(0);
    const fetcher = target.type === "artist" ? fetchArtistTracks : fetchAlbumTracks;
    fetcher(token, target.providerId, target.ref).then((t) => {
      setTracks(t);
      setLoading(false);

      // "Similar artists" rides the same radio/mix signal as the Discover
      // page's "Similar to X" rows — seeded off one of this artist's own
      // tracks, then narrowed down to the distinct other artists in it.
      if (target.type === "artist" && t[0]) {
        fetchRadio(token, t[0]).then((related) => {
          const seen = new Map<string, Track>();
          for (const track of related) {
            if (track.artist_ref && track.artist_ref !== target.ref && track.artist_name) {
              seen.set(track.artist_ref, track);
            }
          }
          setSimilarArtists([...seen.values()].slice(0, 10));
        });
      }
    });

    if (target.type === "artist") {
      fetchArtistReleases(token, target.providerId, target.ref).then(setReleases);
    }
  }, [target.type, target.providerId, target.ref, token]);

  const albums = releases.filter((r) => !r.is_single);
  const singles = releases.filter((r) => r.is_single);
  const artistPageCount = Math.max(1, Math.ceil(tracks.length / ARTIST_PAGE_SIZE));
  const artistPageTracks = tracks.slice(artistPage * ARTIST_PAGE_SIZE, (artistPage + 1) * ARTIST_PAGE_SIZE);
  const albumArtist = tracks.find((track) => track.artist_ref && track.artist_name && track.sources[0]);
  const albumDuration = tracks.reduce((total, track) => total + (track.duration_secs ?? 0), 0);
  const allAlbumTracksLiked = tracks.length > 0 && tracks.every(isLiked);

  function toggleAlbumLike() {
    tracks.filter((track) => isLiked(track) === allAlbumTracksLiked).forEach(toggleLike);
  }

  function addAlbumToPlaylist(playlistId: string) {
    tracks.forEach((track) => onAddToPlaylist(playlistId, track));
    setAddingAlbum(false);
  }

  function createPlaylistFromAlbum(e: React.FormEvent) {
    e.preventDefault();
    const name = newPlaylistName.trim();
    if (!name) return;
    onCreatePlaylist(name, tracks);
    setNewPlaylistName("");
    setAddingAlbum(false);
  }

  function trackActions(track: Track) {
    return (
      <>
        <LikeButton track={track} />
        <TrackOverflowMenu
          track={track}
          playlists={playlists}
          onPlayNext={onPlayNext}
          onEnqueue={onEnqueue}
          onShare={onShare}
          onRadio={onRadio}
          onAddToPlaylist={onAddToPlaylist}
          onOpenDetail={onOpenDetail}
          onStartJam={onStartJam}
          jamActive={jamActive}
        />
      </>
    );
  }

  const emptyNote =
    !loading && tracks.length === 0 ? (
      <p className="detail-view-note">
        Nothing found — this provider may not support browsing by {target.type}.
      </p>
    ) : null;

  if (target.type === "artist") {
    return (
      <div className="detail-view">
        <div className="detail-view-topbar">
          <button onClick={onClose} title="Back">
            <ChevronLeftIcon /> Back
          </button>
        </div>

        <div className="artist-hero">
          <Artwork url={tracks[0]?.artwork_url ?? null} size="lg" alt="" />
          <h2>{target.name}</h2>
          <div className="artist-stats">
            <span>{tracks.length >= 50 ? "50+" : tracks.length} songs</span>
            <span>{albums.length} albums</span>
          </div>
          {tracks.length > 0 && (
            <div className="artist-hero-actions">
              <button onClick={() => onPlay(tracks)}>
                <PlayIcon /> Play
              </button>
              <button onClick={() => onPlay(shuffled(tracks))}>
                <ShuffleIcon /> Shuffle
              </button>
              <button onClick={() => onRadio(tracks[0])}>
                <RadioIcon /> Radio
              </button>
              <button onClick={() => onShareArtist(target)}>
                <ShareIcon /> Share
              </button>
            </div>
          )}
        </div>

        {loading && tracks.length === 0 && <p className="detail-view-note">Loading…</p>}
        {emptyNote}

        {tracks.length > 0 && (
          <section className="home-row">
            <div className="home-row-heading">
              <h3>Top songs</h3>
            </div>
            <ul className="track-list">
              {artistPageTracks.map((t) => (
                <TrackRow key={t.id} track={t} onPlay={() => onPlay(tracks, t.id)}>
                  {trackActions(t)}
                </TrackRow>
              ))}
            </ul>
            {artistPageCount > 1 && (
              <div className="detail-pagination">
                <button disabled={artistPage === 0} onClick={() => setArtistPage((page) => page - 1)}>
                  Previous
                </button>
                <span>Page {artistPage + 1} of {artistPageCount}</span>
                <button
                  disabled={artistPage >= artistPageCount - 1}
                  onClick={() => setArtistPage((page) => page + 1)}
                >
                  Next
                </button>
              </div>
            )}
          </section>
        )}

        {albums.length > 0 && (
          <section className="home-row">
            <div className="home-row-heading">
              <h3>Albums</h3>
            </div>
            <div className="home-row-scroll">
              {albums.map((r) => (
                <EntityCard
                  key={r.id}
                  name={r.title}
                  subtitle={r.year ?? undefined}
                  artworkUrl={r.artwork_url}
                  onClick={() =>
                    onOpenDetail({ type: "album", providerId: target.providerId, ref: r.id, name: r.title, year: r.year })
                  }
                />
              ))}
            </div>
          </section>
        )}

        {singles.length > 0 && (
          <section className="home-row">
            <div className="home-row-heading">
              <h3>Singles &amp; EPs</h3>
            </div>
            <div className="home-row-scroll">
              {singles.map((r) => (
                <EntityCard
                  key={r.id}
                  name={r.title}
                  subtitle={r.year ?? undefined}
                  artworkUrl={r.artwork_url}
                  onClick={() =>
                    onOpenDetail({ type: "album", providerId: target.providerId, ref: r.id, name: r.title, year: r.year })
                  }
                />
              ))}
            </div>
          </section>
        )}

        {similarArtists.length > 0 && (
          <section className="home-row">
            <div className="home-row-heading">
              <h3>Similar artists</h3>
            </div>
            <div className="home-row-scroll">
              {similarArtists.map((t) => (
                <EntityCard
                  key={t.artist_ref}
                  name={t.artist_name!}
                  artworkUrl={t.artwork_url}
                  round
                  onClick={() =>
                    onOpenDetail({
                      type: "artist",
                      providerId: t.sources[0]!.provider_id,
                      ref: t.artist_ref!,
                      name: t.artist_name!,
                    })
                  }
                />
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="detail-view">
      <div className="detail-view-topbar">
        <button onClick={onClose} title="Back">
          <ChevronLeftIcon /> Back
        </button>
      </div>

      <div className="detail-view-header">
        <Artwork url={tracks[0]?.artwork_url ?? null} size="lg" alt="" />
        <div>
          <div className="detail-view-kind">Album</div>
          <h2>{target.name}</h2>
          {albumArtist && (
            <button
              className="album-artist-link"
              onClick={() =>
                onOpenDetail({
                  type: "artist",
                  providerId: albumArtist.sources[0]!.provider_id,
                  ref: albumArtist.artist_ref!,
                  name: albumArtist.artist_name!,
                })
              }
            >
              {albumArtist.artist_name}
            </button>
          )}
          {tracks.length > 0 && (
            <div className="album-stats">
              {target.year && <span>Released {target.year}</span>}
              <span>{tracks.length} {tracks.length === 1 ? "song" : "songs"}</span>
              {albumDuration > 0 && <span>{formatAlbumDuration(albumDuration)} total</span>}
            </div>
          )}
          {tracks.length > 0 && (
            <div className="album-actions">
              <button onClick={() => onPlay(tracks)}><PlayIcon /> Play</button>
              <button onClick={() => onPlay(shuffled(tracks))}><ShuffleIcon /> Shuffle</button>
              <button onClick={toggleAlbumLike} title={allAlbumTracksLiked ? "Unlike album" : "Like album"}>
                {allAlbumTracksLiked ? <HeartFilledIcon /> : <HeartIcon />} Like
              </button>
              <button onClick={() => onShareAlbum(target, albumArtist?.artist_name)}>Share</button>
              <div className="album-playlist">
                <button onClick={() => setAddingAlbum((open) => !open)}>Add to playlist</button>
                {addingAlbum && (
                  <div className="album-playlist-menu">
                    {playlists.map((playlist) => (
                      <button key={playlist.id} onClick={() => addAlbumToPlaylist(playlist.id)}>{playlist.name}</button>
                    ))}
                    <form onSubmit={createPlaylistFromAlbum}>
                      <input value={newPlaylistName} onChange={(e) => setNewPlaylistName(e.target.value)} placeholder="New playlist..." />
                      <button type="submit">Create</button>
                    </form>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {loading && tracks.length === 0 && <p className="detail-view-note">Loading…</p>}
      {emptyNote}

      <ul className="track-list">
        {tracks.map((t) => (
          <TrackRow key={t.id} track={t} onPlay={() => onPlay(tracks, t.id)}>
            {trackActions(t)}
          </TrackRow>
        ))}
      </ul>
    </div>
  );
}
