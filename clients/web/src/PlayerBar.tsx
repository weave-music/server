import { Artwork } from "./Artwork";
import { formatTime } from "./format";
import { PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "./icons";
import type { useQueue } from "./useQueue";

interface Props {
  queueApi: ReturnType<typeof useQueue>;
  onExpand: () => void;
}

export function PlayerBar({ queueApi, onExpand }: Props) {
  const { audioRef, currentTrack, isPlaying, currentTime, duration, togglePlay, next, prev, seek } =
    queueApi;

  return (
    <footer className="player-bar">
      <audio ref={audioRef} />
      <button
        className="player-bar-track"
        onClick={onExpand}
        disabled={!currentTrack}
        title={currentTrack ? "Open full player" : undefined}
      >
        {currentTrack ? (
          <>
            <Artwork url={currentTrack.artwork_url} size="md" alt="" />
            <span className="track-title">{currentTrack.title}</span>
          </>
        ) : (
          <span className="track-title">Nothing playing</span>
        )}
      </button>
      <div className="player-bar-controls">
        <button onClick={prev} disabled={!currentTrack} title="Previous">
          <SkipBackIcon />
        </button>
        <button onClick={togglePlay} disabled={!currentTrack} title={isPlaying ? "Pause" : "Play"}>
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button onClick={next} disabled={!currentTrack} title="Next">
          <SkipForwardIcon />
        </button>
      </div>
      <div className="player-bar-seek">
        <span>{formatTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          value={Math.min(currentTime, duration || 0)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={!currentTrack}
        />
        <span>{formatTime(duration)}</span>
      </div>
    </footer>
  );
}
