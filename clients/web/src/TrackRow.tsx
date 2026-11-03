import type { ReactNode } from "react";
import { Artwork } from "./Artwork";
import type { Track } from "./types";

interface Props {
  track: Track;
  onPlay: () => void;
  isCurrent?: boolean;
  children?: ReactNode;
  // Only ever set from Liked Songs — elsewhere this is undefined and the
  // row falls back to the plain local/streamed tag from the source itself.
  downloadStatus?: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  streaming: "streaming",
  downloaded: "downloaded",
  upgrading: "upgrading…",
  upgraded: "upgraded",
};

function qualityLabel(source: Track["sources"][number] | undefined): string | undefined {
  if (!source) return undefined;
  if (source.is_lossless) return "lossless";
  if (source.bitrate_kbps) return `${source.bitrate_kbps}kbps`;
  return undefined;
}

// Split into two inner groups (not one flat row) so narrow screens can wrap
// the action buttons onto their own line below the title instead of
// squeezing everything, or overflowing, on one line.
export function TrackRow({ track, onPlay, isCurrent, children, downloadStatus }: Props) {
  const source = track.sources[0];
  const statusLabel = downloadStatus ? STATUS_LABELS[downloadStatus] : undefined;
  const quality = qualityLabel(source);
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
        {quality && <span className="tag tag-quality">{quality}</span>}
        {statusLabel ? (
          <span className={`tag ${downloadStatus === "upgrading" ? "tag-upgrade" : ""}`}>{statusLabel}</span>
        ) : (
          source && <span className="tag">{source.is_local ? "local" : "streamed"}</span>
        )}
      </button>
      {children && <div className="track-actions">{children}</div>}
    </li>
  );
}
