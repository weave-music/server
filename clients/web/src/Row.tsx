import { Artwork } from "./Artwork";
import type { Track } from "./types";

interface Props {
  title: string;
  subtitle?: string;
  tracks: Track[];
  onPlay: (tracks: Track[], startId: string) => void;
  loading?: boolean;
}

// A horizontally-scrolling shelf of tracks, e.g. one genre or one "similar
// to X" set — the building block the whole Discover/Home page is made of.
export function Row({ title, subtitle, tracks, onPlay, loading }: Props) {
  if (!loading && tracks.length === 0) return null;

  return (
    <section className="home-row">
      <div className="home-row-heading">
        {subtitle && <div className="home-row-subtitle">{subtitle}</div>}
        <h3>{title}</h3>
      </div>
      <div className="home-row-scroll">
        {loading && tracks.length === 0
          ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="home-card home-card-skeleton" />)
          : tracks.map((track) => (
              <button key={track.id} className="home-card" onClick={() => onPlay(tracks, track.id)}>
                <Artwork url={track.artwork_url} size="lg" alt="" />
                <span className="home-card-title">{track.title}</span>
              </button>
            ))}
      </div>
    </section>
  );
}
