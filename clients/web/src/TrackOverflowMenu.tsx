import { useState } from "react";
import type { DetailTarget } from "./DetailView";
import type { Track } from "./types";
import { useBackHandler } from "./useBackHandler";
import type { useSleepTimer } from "./useSleepTimer";

interface Props {
  track: Track;
  // Collaborative by default — every playlist on the server, not just the
  // caller's own (see usePlaylists.ts's `addablePlaylists`).
  playlists: { id: string; name: string }[];
  onPlayNext: (track: Track) => void;
  onEnqueue: (track: Track) => void;
  onShare: (track: Track) => void | Promise<void>;
  onRadio: (track: Track) => void;
  onAddToPlaylist: (playlistId: string, track: Track) => void;
  onOpenDetail: (target: DetailTarget) => void;
  // Starts a jam immediately (if one isn't already running) and goes
  // straight into the room — unlike the header's "Start a Jam" button,
  // this skips the landing/CTA screen entirely.
  onStartJam: () => void;
  jamActive: boolean;
  // Only passed by NowPlayingView's own "..." menu — every other call
  // site (search results, detail pages, etc.) omits it, so the "Sleep
  // timer" item only shows up where it actually makes sense.
  sleepTimer?: ReturnType<typeof useSleepTimer>;
}

export function TrackOverflowMenu({
  track,
  playlists,
  onPlayNext,
  onEnqueue,
  onShare,
  onRadio,
  onAddToPlaylist,
  onOpenDetail,
  onStartJam,
  jamActive,
  sleepTimer,
}: Props) {
  const [open, setOpen] = useState(false);
  const [choosingPlaylist, setChoosingPlaylist] = useState(false);
  const [choosingSleepTimer, setChoosingSleepTimer] = useState(false);
  const source = track.sources[0];
  const canViewArtist = Boolean(source && (track.artist_ref || track.artist_name));
  const canViewAlbum = Boolean(source && (track.album_ref || track.album_name || track.title));

  function viewArtist() {
    if (!source) return;
    if (track.artist_ref && track.artist_name) {
      onOpenDetail({ type: "artist", providerId: source.provider_id, ref: track.artist_ref, name: track.artist_name, artworkUrl: track.artwork_url });
      return;
    }
    window.open(`https://music.youtube.com/search?q=${encodeURIComponent(track.artist_name ?? track.title)}`, "_blank", "noopener,noreferrer");
  }

  function viewAlbum() {
    if (!source) return;
    if (track.album_ref && track.album_name) {
      onOpenDetail({ type: "album", providerId: source.provider_id, ref: track.album_ref, name: track.album_name });
      return;
    }
    window.open(`https://music.youtube.com/search?q=${encodeURIComponent([track.album_name ?? track.title, track.artist_name].filter(Boolean).join(" "))}`, "_blank", "noopener,noreferrer");
  }

  function close() {
    setOpen(false);
    setChoosingPlaylist(false);
    setChoosingSleepTimer(false);
  }

  useBackHandler(open, close);

  const sleepTimerLabel =
    sleepTimer?.mode?.kind === "duration"
      ? `Sleep timer: ${sleepTimer.minutesLeft}m left`
      : sleepTimer?.mode?.kind === "end-of-track"
        ? "Sleep timer: end of track"
        : "Sleep timer";

  function act(action: () => void | Promise<void>) {
    close();
    void action();
  }

  return (
    <div className="track-overflow">
      <button
        className="track-overflow-trigger"
        aria-label={`More options for ${track.title}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="More options"
      >
        •••
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <div className="track-overflow-menu" role="menu" aria-label={`Options for ${track.title}`}>
            {choosingPlaylist ? (
              <>
                <button role="menuitem" onClick={() => setChoosingPlaylist(false)}>‹ Back</button>
                <div className="track-overflow-heading">Add to playlist</div>
                {playlists.length === 0 ? (
                  <p className="track-overflow-empty">No playlists yet</p>
                ) : (
                  playlists.map((playlist) => (
                    <button key={playlist.id} role="menuitem" onClick={() => act(() => onAddToPlaylist(playlist.id, track))}>
                      {playlist.name}
                    </button>
                  ))
                )}
              </>
            ) : choosingSleepTimer && sleepTimer ? (
              <>
                <button role="menuitem" onClick={() => setChoosingSleepTimer(false)}>‹ Back</button>
                <div className="track-overflow-heading">Sleep timer</div>
                {[15, 30, 45, 60].map((minutes) => (
                  <button key={minutes} role="menuitem" onClick={() => act(() => sleepTimer.setDurationTimer(minutes))}>
                    {minutes} minutes
                  </button>
                ))}
                <button role="menuitem" onClick={() => act(() => sleepTimer.setEndOfTrackTimer())}>
                  End of current track
                </button>
                {sleepTimer.mode && (
                  <button role="menuitem" onClick={() => act(() => sleepTimer.cancelTimer())}>
                    Turn off
                  </button>
                )}
              </>
            ) : (
              <>
                <button role="menuitem" onClick={() => act(() => onPlayNext(track))}>Play next</button>
                <button role="menuitem" onClick={() => act(() => onEnqueue(track))}>Add to queue</button>
                <button role="menuitem" onClick={() => act(() => onShare(track))}>Share</button>
                <button role="menuitem" onClick={() => act(() => onRadio(track))}>Start radio</button>
                <button role="menuitem" onClick={() => act(onStartJam)}>{jamActive ? "Jam" : "Start a Jam"}</button>
                <button role="menuitem" onClick={() => setChoosingPlaylist(true)}>Add to playlist</button>
                {sleepTimer && (
                  <button role="menuitem" onClick={() => setChoosingSleepTimer(true)}>
                    {sleepTimerLabel}
                  </button>
                )}
                {canViewArtist && (
                  <button
                    role="menuitem"
                    onClick={() => act(viewArtist)}
                  >
                    View artist
                  </button>
                )}
                {canViewAlbum && (
                  <button
                    role="menuitem"
                    onClick={() => act(viewAlbum)}
                  >
                    View album
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
