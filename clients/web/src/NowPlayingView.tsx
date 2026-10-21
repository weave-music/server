import { Artwork } from "./Artwork";
import type { DetailTarget } from "./DetailView";
import { formatTime } from "./format";
import {
  ChevronDownIcon,
  DiscIcon,
  PauseIcon,
  PlayIcon,
  QueueIcon,
  RadioIcon,
  RepeatIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  UserIcon,
} from "./icons";
import type { Track } from "./types";
import type { useQueue } from "./useQueue";

interface Props {
  queueApi: ReturnType<typeof useQueue>;
  onClose: () => void;
  onOpenQueue: () => void;
  onRadio: (track: Track) => void;
  onOpenDetail: (target: DetailTarget) => void;
}

export function NowPlayingView({ queueApi, onClose, onOpenQueue, onRadio, onOpenDetail }: Props) {
  const {
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    shuffle,
    repeat,
    togglePlay,
    next,
    prev,
    seek,
    toggleShuffle,
    cycleRepeat,
  } = queueApi;

  if (!currentTrack) return null;
  const providerId = currentTrack.sources[0]?.provider_id;

  return (
    <div className="now-playing">
      <div className="now-playing-topbar">
        <button onClick={onClose} title="Close">
          <ChevronDownIcon />
        </button>
        <span>Now Playing</span>
        <span className="now-playing-spacer" />
      </div>

      <div className="now-playing-art">
        <Artwork url={currentTrack.artwork_url} size="lg" alt="" />
      </div>

      <div className="now-playing-info">
        <div className="now-playing-title">{currentTrack.title}</div>
        {currentTrack.artist_name && (
          <div className="now-playing-subtitle">{currentTrack.artist_name}</div>
        )}
      </div>

      {(currentTrack.artist_ref || currentTrack.album_ref) && (
        <div className="now-playing-goto">
          {currentTrack.artist_ref && providerId && (
            <button
              onClick={() =>
                onOpenDetail({
                  type: "artist",
                  providerId,
                  ref: currentTrack.artist_ref!,
                  name: currentTrack.artist_name ?? "Artist",
                })
              }
            >
              <UserIcon /> Go to artist
            </button>
          )}
          {currentTrack.album_ref && providerId && (
            <button
              onClick={() =>
                onOpenDetail({
                  type: "album",
                  providerId,
                  ref: currentTrack.album_ref!,
                  name: currentTrack.album_name ?? "Album",
                })
              }
            >
              <DiscIcon /> Go to album
            </button>
          )}
        </div>
      )}

      <div className="now-playing-seek">
        <input
          type="range"
          min={0}
          max={duration || 0}
          value={Math.min(currentTime, duration || 0)}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <div className="now-playing-times">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <div className="now-playing-transport">
        <button className={shuffle ? "active" : ""} onClick={toggleShuffle} title="Shuffle">
          <ShuffleIcon />
        </button>
        <button onClick={prev} title="Previous">
          <SkipBackIcon />
        </button>
        <button className="now-playing-play" onClick={togglePlay} title={isPlaying ? "Pause" : "Play"}>
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button onClick={next} title="Next">
          <SkipForwardIcon />
        </button>
        <button className={repeat !== "off" ? "active" : ""} onClick={cycleRepeat} title="Repeat">
          <RepeatIcon />
          {repeat === "one" && <span className="repeat-one-badge">1</span>}
        </button>
      </div>

      <div className="now-playing-actions">
        <button onClick={onOpenQueue}>
          <QueueIcon /> Queue
        </button>
        <button onClick={() => onRadio(currentTrack)}>
          <RadioIcon /> Radio
        </button>
      </div>
    </div>
  );
}
