import { Artwork } from "./Artwork";

interface Props {
  name: string;
  subtitle?: string;
  artworkUrl: string | null;
  onClick: () => void;
  round?: boolean;
}

// A card for anything that isn't a track — artist, album, or playlist —
// used in horizontally-scrolling rows (Discover's rows, Search's "All"
// overview, an artist page's "Similar artists").
export function EntityCard({ name, subtitle, artworkUrl, onClick, round }: Props) {
  return (
    <button className="home-card" onClick={onClick}>
      <div className={round ? "home-card-art-round" : undefined}>
        <Artwork url={artworkUrl} size="lg" alt="" />
      </div>
      <span className="home-card-title">{name}</span>
      {subtitle && <span className="home-card-subtitle">{subtitle}</span>}
    </button>
  );
}
