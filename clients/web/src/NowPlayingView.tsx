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
import { repeatModeToNumber, type RemoteCommandName } from "./jamApi";
import type { Playlist } from "./usePlaylists";
import type { Track } from "./types";
import { nextRepeatMode, type RepeatMode, type useQueue } from "./useQueue";

interface Props {
  queueApi: ReturnType<typeof useQueue>;
  onClose: () => void;
  onOpenQueue: () => void;
  onRadio: (track: Track) => void;
  onShare: (track: Track) => void | Promise<void>;
  onOpenDetail: (target: DetailTarget) => void;
  playlists: Playlist[];
  onAddToPlaylist: (playlistId: string, track: Track) => void;
  // Plain "go to the jam" — used by the active-jam banner below, which only
  // ever shows once a jam already exists.
  onOpenJam: () => void;
  // Starts a jam immediately (if needed) and skips straight to the room —
  // used by this view's own "..." menu, same as every other track menu.
  onStartJam: () => void;
  jamActive: boolean;
  jamMemberCount: number;
  // Same remote-control plumbing as PlayerBar — see App.tsx.
  isRemote?: boolean;
  onRemoteCommand?: (command: RemoteCommandName, value?: number) => void;
  remoteVolume?: number;
  // See the same-named prop on PlayerBar — the account-wide cross-device
  // sync never mirrors whether the OTHER device is playing, only track/position.
  remoteIsPlaying?: boolean;
  remoteShuffle?: boolean;
  remoteRepeat?: RepeatMode;
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
  onStartJam,
  jamActive,
  jamMemberCount,
  isRemote,
  onRemoteCommand,
  remoteVolume,
  remoteIsPlaying,
  remoteShuffle,
  remoteRepeat,
}: Props) {
  const {
    currentTrack,
    isPlaying: localIsPlaying,
    currentTime,
    duration,
    shuffle: localShuffle,
    repeat: localRepeat,
    togglePlay,
    next,
    prev,
    seek,
    toggleShuffle,
    cycleRepeat,
  } = queueApi;

  const remote = isRemote && onRemoteCommand;
  const isPlaying = remote ? !!remoteIsPlaying : localIsPlaying;
  const shuffle = remote ? !!remoteShuffle : localShuffle;
  const repeat = remote ? remoteRepeat ?? "off" : localRepeat;

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
          onStartJam={onStartJam}
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

      {remote ? (
        <div className="now-playing-seek now-playing-remote-volume">
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
      )}

      <div className="now-playing-transport">
        <button
          className={shuffle ? "active" : ""}
          onClick={() => (remote ? onRemoteCommand("shuffle", shuffle ? 0 : 1) : toggleShuffle())}
          title="Shuffle"
        >
          <ShuffleIcon />
        </button>
        <button onClick={() => (remote ? onRemoteCommand("prev") : prev())} title="Previous">
          <SkipBackIcon />
        </button>
        <button
          className="now-playing-play"
          onClick={() => (remote ? onRemoteCommand(isPlaying ? "pause" : "play") : togglePlay())}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button onClick={() => (remote ? onRemoteCommand("next") : next())} title="Next">
          <SkipForwardIcon />
        </button>
        <button
          className={repeat !== "off" ? "active" : ""}
          onClick={() => (remote ? onRemoteCommand("repeat", repeatModeToNumber(nextRepeatMode(repeat))) : cycleRepeat())}
          title="Repeat"
        >
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
