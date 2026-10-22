import { useState } from "react";
import type { DetailTarget } from "./DetailView";
import type { Playlist } from "./usePlaylists";
import type { Track } from "./types";

interface Props {
  track: Track;
  playlists: Playlist[];
  onPlayNext: (track: Track) => void;
  onEnqueue: (track: Track) => void;
  onShare: (track: Track) => void | Promise<void>;
  onRadio: (track: Track) => void;
  onAddToPlaylist: (playlistId: string, track: Track) => void;
  onOpenDetail: (target: DetailTarget) => void;
  onOpenJam: () => void;
  jamActive: boolean;
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
  onOpenJam,
  jamActive,
}: Props) {
  const [open, setOpen] = useState(false);
  const [choosingPlaylist, setChoosingPlaylist] = useState(false);
  const source = track.sources[0];
  const canViewArtist = Boolean(source && (track.artist_ref || track.artist_name));
  const canViewAlbum = Boolean(source && (track.album_ref || track.album_name || track.title));

  function viewArtist() {
    if (!source) return;
    if (track.artist_ref && track.artist_name) {
      onOpenDetail({ type: "artist", providerId: source.provider_id, ref: track.artist_ref, name: track.artist_name });
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
  }

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
            ) : (
              <>
                <button role="menuitem" onClick={() => act(() => onPlayNext(track))}>Play next</button>
                <button role="menuitem" onClick={() => act(() => onEnqueue(track))}>Add to queue</button>
                <button role="menuitem" onClick={() => act(() => onShare(track))}>Share</button>
                <button role="menuitem" onClick={() => act(() => onRadio(track))}>Start radio</button>
                <button role="menuitem" onClick={() => act(onOpenJam)}>{jamActive ? "Jam" : "Start a Jam"}</button>
                <button role="menuitem" onClick={() => setChoosingPlaylist(true)}>Add to playlist</button>
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
