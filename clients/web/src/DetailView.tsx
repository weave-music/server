import { useEffect, useState } from "react";
import { fetchAlbumTracks, fetchArtistTracks, fetchRadio } from "./api";
import { Artwork } from "./Artwork";
import { EntityCard } from "./EntityCard";
import { ChevronLeftIcon, PlayIcon, RadioIcon, ShuffleIcon } from "./icons";
import { TrackRow } from "./TrackRow";
import type { Track } from "./types";

export interface DetailTarget {
  type: "artist" | "album";
  providerId: string;
  ref: string;
  name: string;
}

interface Props {
  target: DetailTarget;
  token: string;
  onClose: () => void;
  onPlay: (tracks: Track[], startId?: string) => void;
  onRadio: (track: Track) => void;
  onOpenDetail: (target: DetailTarget) => void;
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function DetailView({ target, token, onClose, onPlay, onRadio, onOpenDetail }: Props) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [similarArtists, setSimilarArtists] = useState<Track[]>([]);

  useEffect(() => {
    setLoading(true);
    setSimilarArtists([]);
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
  }, [target.type, target.providerId, target.ref, token]);

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
          {tracks.length > 0 && <div className="artist-hero-stat">{tracks.length}+ Songs</div>}
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
              {tracks.map((t) => (
                <TrackRow key={t.id} track={t} onPlay={() => onPlay(tracks, t.id)} />
              ))}
            </ul>
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
          {tracks.length > 0 && <button onClick={() => onPlay(tracks)}>Play all</button>}
        </div>
      </div>

      {loading && tracks.length === 0 && <p className="detail-view-note">Loading…</p>}
      {emptyNote}

      <ul className="track-list">
        {tracks.map((t) => (
          <TrackRow key={t.id} track={t} onPlay={() => onPlay(tracks, t.id)} />
        ))}
      </ul>
    </div>
  );
}
