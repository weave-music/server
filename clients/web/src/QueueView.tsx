import { LikeButton } from "./LikeButton";
import { TrackRow } from "./TrackRow";
import type { Track } from "./types";

interface Props {
  queue: Track[];
  currentTrackId: string | null;
  onPlay: (track: Track) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
}

export function QueueView({ queue, currentTrackId, onPlay, onRemove, onMove }: Props) {
  if (queue.length === 0) {
    return (
      <section>
        <p>Queue is empty. Play something from Search to get started.</p>
      </section>
    );
  }

  return (
    <section>
      <ul className="track-list">
        {queue.map((track, i) => (
          <TrackRow key={track.id} track={track} onPlay={() => onPlay(track)} isCurrent={track.id === currentTrackId}>
            <LikeButton track={track} />
            <button onClick={() => onMove(track.id, -1)} disabled={i === 0} title="Move up">
              ↑
            </button>
            <button onClick={() => onMove(track.id, 1)} disabled={i === queue.length - 1} title="Move down">
              ↓
            </button>
            <button onClick={() => onRemove(track.id)} title="Remove from queue">
              ✕
            </button>
          </TrackRow>
        ))}
      </ul>
    </section>
  );
}
