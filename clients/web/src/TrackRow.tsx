import type { ReactNode } from "react";
import { Artwork } from "./Artwork";
import type { Track } from "./types";

interface Props {
  track: Track;
  onPlay: () => void;
  isCurrent?: boolean;
  children?: ReactNode;
}

// Split into two inner groups (not one flat row) so narrow screens can wrap
// the action buttons onto their own line below the title instead of
// squeezing everything, or overflowing, on one line.
export function TrackRow({ track, onPlay, isCurrent, children }: Props) {
  const source = track.sources[0];
  return (
    <li className={isCurrent ? "current" : ""}>
      <div className="track-main">
        <button className="track-play" onClick={onPlay} title="Play now">
          <Artwork url={track.artwork_url} alt="" />
          <span className="track-play-overlay">{isCurrent ? "♪" : "▶"}</span>
        </button>
        <span className="track-title">{track.title}</span>
        {source && <span className="tag">{source.is_local ? "local" : "streamed"}</span>}
      </div>
      {children && <div className="track-actions">{children}</div>}
    </li>
  );
}
