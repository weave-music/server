import type { ReactNode } from "react";
import { Artwork } from "./Artwork";
import type { Track } from "./types";

interface Props {
  track: Track;
  onPlay: () => void;
  isCurrent?: boolean;
  children?: ReactNode;
  upgradeStatus?: string | null;
}

const UPGRADE_LABELS: Record<string, string> = {
  requested: "upgrading…",
  upgraded: "upgraded",
};

// Split into two inner groups (not one flat row) so narrow screens can wrap
// the action buttons onto their own line below the title instead of
// squeezing everything, or overflowing, on one line.
export function TrackRow({ track, onPlay, isCurrent, children, upgradeStatus }: Props) {
  const source = track.sources[0];
  const upgradeLabel = upgradeStatus ? UPGRADE_LABELS[upgradeStatus] : undefined;
  return (
    <li className={isCurrent ? "current" : ""}>
      <button className="track-main" onClick={onPlay} title="Play now">
        <span className="track-play">
          <Artwork url={track.artwork_url} alt="" />
          <span className="track-play-overlay">{isCurrent ? "♪" : "▶"}</span>
        </span>
        <span className="track-title-col">
          <span className="track-title">{track.title}</span>
          {track.artist_name && <span className="track-subtitle">{track.artist_name}</span>}
        </span>
        {upgradeLabel && <span className="tag tag-upgrade">{upgradeLabel}</span>}
        {source && <span className="tag">{source.is_local ? "local" : "streamed"}</span>}
      </button>
      {children && <div className="track-actions">{children}</div>}
    </li>
  );
}
