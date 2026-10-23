import { Artwork } from "./Artwork";
import { formatTime } from "./format";
import { PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "./icons";
import type { RemoteCommandName } from "./jamApi";
import type { useQueue } from "./useQueue";

interface Props {
  queueApi: ReturnType<typeof useQueue>;
  onExpand: () => void;
  // When this device is a jam member but NOT the jam's audio source, the
  // bar controls the source device remotely instead of this device's own
  // (empty) local playback — see the isRemote plumbing in App.tsx.
  isRemote?: boolean;
  onRemoteCommand?: (command: RemoteCommandName, value?: number) => void;
  remoteVolume?: number;
  // The account-wide cross-device sync (queueApi.isPlaying) only mirrors
  // track/position, never whether the OTHER device is actually playing —
  // so a remote has to read that from the jam's own live state instead.
  remoteIsPlaying?: boolean;
}

export function PlayerBar({
  queueApi,
  onExpand,
  isRemote,
  onRemoteCommand,
  remoteVolume,
  remoteIsPlaying,
}: Props) {
  const { audioRef, currentTrack, isPlaying: localIsPlaying, currentTime, duration, togglePlay, next, prev, seek } =
    queueApi;

  const remote = isRemote && onRemoteCommand;
  const isPlaying = remote ? !!remoteIsPlaying : localIsPlaying;

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
            {remote && <span className="tag">remote</span>}
          </>
        ) : (
          <span className="track-title">Nothing playing</span>
        )}
      </button>
      <div className="player-bar-controls">
        <button onClick={() => (remote ? onRemoteCommand("prev") : prev())} disabled={!currentTrack} title="Previous">
          <SkipBackIcon />
        </button>
        <button
          onClick={() => (remote ? onRemoteCommand(isPlaying ? "pause" : "play") : togglePlay())}
          disabled={!currentTrack}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button onClick={() => (remote ? onRemoteCommand("next") : next())} disabled={!currentTrack} title="Next">
          <SkipForwardIcon />
        </button>
      </div>
      {remote ? (
        <div className="player-bar-seek player-bar-remote-volume">
          <span>Volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={remoteVolume ?? 1}
            onChange={(e) => onRemoteCommand("volume", Number(e.target.value))}
          />
        </div>
      ) : (
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
      )}
    </footer>
  );
}
