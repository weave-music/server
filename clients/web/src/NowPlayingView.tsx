import { Artwork } from "./Artwork";
import type { DetailTarget } from "./DetailView";
import { formatTime } from "./format";
import {
  ChevronDownIcon,
  DiscIcon,
  JamIcon,
  PauseIcon,
  PlayIcon,
  QueueIcon,
  RepeatIcon,
  ShareIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  UserIcon,
} from "./icons";
import { LikeButton } from "./LikeButton";
import { TrackOverflowMenu } from "./TrackOverflowMenu";
import type { Playlist } from "./usePlaylists";
import type { Track } from "./types";
import type { useQueue } from "./useQueue";

interface Props {
  queueApi: ReturnType<typeof useQueue>;
  onClose: () => void;
  onOpenQueue: () => void;
  onRadio: (track: Track) => void;
  onShare: (track: Track) => void | Promise<void>;
  onOpenDetail: (target: DetailTarget) => void;
  playlists: Playlist[];
  onAddToPlaylist: (playlistId: string, track: Track) => void;
  onOpenJam: () => void;
  jamActive: boolean;
  jamMemberCount: number;
}

export function NowPlayingView({
  queueApi,
  onClose,
  onOpenQueue,
  onRadio,
  onShare,
  onOpenDetail,
  playlists,
  onAddToPlaylist,
  onOpenJam,
  jamActive,
  jamMemberCount,
}: Props) {
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
  const artistUrl = `https://music.youtube.com/search?q=${encodeURIComponent(currentTrack.artist_name ?? currentTrack.title)}`;
  const albumUrl = `https://music.youtube.com/search?q=${encodeURIComponent([currentTrack.album_name ?? currentTrack.title, currentTrack.artist_name].filter(Boolean).join(" "))}`;

  return (
    <div className="now-playing">
      <div className="now-playing-topbar">
        <button onClick={onClose} title="Close">
          <ChevronDownIcon />
        </button>
        <span>Now Playing</span>
        <TrackOverflowMenu
          track={currentTrack}
          playlists={playlists}
          onPlayNext={queueApi.enqueueNext}
          onEnqueue={queueApi.enqueue}
          onShare={onShare}
          onRadio={onRadio}
          onAddToPlaylist={onAddToPlaylist}
          onOpenDetail={onOpenDetail}
          onOpenJam={onOpenJam}
          jamActive={jamActive}
        />
      </div>

      {jamActive && (
        <button className="now-playing-jam-banner" onClick={onOpenJam}>
          <JamIcon />
          Jam active — {jamMemberCount} {jamMemberCount === 1 ? "person" : "people"}
        </button>
      )}

      <div className="now-playing-art">
        <Artwork url={currentTrack.artwork_url} size="lg" alt="" />
      </div>

      <div className="now-playing-info">
        <div className="now-playing-info-text">
          <div className="now-playing-title">{currentTrack.title}</div>
          {currentTrack.artist_name && (
            <div className="now-playing-subtitle">{currentTrack.artist_name}</div>
          )}
        </div>
        <LikeButton track={currentTrack} />
      </div>

      <div className="now-playing-goto">
          {providerId && (
            <button
              onClick={() => currentTrack.artist_ref
                ? onOpenDetail({ type: "artist", providerId, ref: currentTrack.artist_ref, name: currentTrack.artist_name ?? "Artist" })
                : window.open(artistUrl, "_blank", "noopener,noreferrer")}
            >
              <UserIcon /> Go to artist
            </button>
          )}
          {providerId && (
            <button
              onClick={() => currentTrack.album_ref
                ? onOpenDetail({ type: "album", providerId, ref: currentTrack.album_ref, name: currentTrack.album_name ?? "Album" })
                : window.open(albumUrl, "_blank", "noopener,noreferrer")}
            >
              <DiscIcon /> Go to album
            </button>
          )}
        </div>

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
        <button onClick={() => onShare(currentTrack)}>
          <ShareIcon /> Share
        </button>
      </div>
    </div>
  );
}
