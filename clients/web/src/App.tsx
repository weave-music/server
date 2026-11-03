import { lazy, Suspense, useEffect, useState } from "react";
import type { DetailTarget } from "./DetailView";
import { DiscoverView } from "./DiscoverView";
import { fetchArtistReleases, fetchArtistTracks, fetchRadio, getCacheTtlHours, recordPlay as recordServerPlay } from "./api";
import { JamIcon } from "./icons";
import { dedupeMembers } from "./jamApi";
import { LikesProvider } from "./LikesContext";
import { NavTabs } from "./NavTabs";
import { NowPlayingView } from "./NowPlayingView";
import { PlayerBar } from "./PlayerBar";
import { SearchView } from "./SearchView";
import { Toast } from "./Toast";
import { useAuth } from "./useAuth";
import { useJam } from "./useJam";
import { useLikes } from "./useLikes";
import { useListeningHistory } from "./useListeningHistory";
import { useQueue } from "./useQueue";
import { useSleepTimer } from "./useSleepTimer";
import { usePlaylists } from "./usePlaylists";
import type { Track } from "./types";

// Lazy-loaded: not needed on first paint (AuthView only shows before a
// session restores; the rest are opened on demand), so logged-in users
// browsing the default Discover tab don't pay for this code upfront.
const AuthView = lazy(() => import("./AuthView").then((m) => ({ default: m.AuthView })));
const AdminView = lazy(() => import("./AdminView").then((m) => ({ default: m.AdminView })));
const DetailView = lazy(() => import("./DetailView").then((m) => ({ default: m.DetailView })));
const JamRoom = lazy(() => import("./JamRoom").then((m) => ({ default: m.JamRoom })));
const PlaylistsView = lazy(() => import("./PlaylistsView").then((m) => ({ default: m.PlaylistsView })));
const QueueView = lazy(() => import("./QueueView").then((m) => ({ default: m.QueueView })));
const ProfileView = lazy(() => import("./ProfileView").then((m) => ({ default: m.ProfileView })));

type Tab = "search" | "discover" | "queue" | "playlists" | "profile" | "admin";

export default function App() {
  const { token, me, checking, login, setup, register, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("discover");
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [jamPanelOpen, setJamPanelOpen] = useState(false);
  const queueApi = useQueue(token);
  const sleepTimer = useSleepTimer(queueApi.pause, queueApi.currentTrack?.id ?? null);
  const jamApi = useJam(token, queueApi);
  // This device is a host-role member of an active jam but didn't start it
  // — the regular player (not just the Jam panel's own controls) should
  // drive the actual source device instead of this device's own queue.
  const isRemote = !!jamApi.jam && !jamApi.isSource;
  const playlistApi = usePlaylists(token);
  const history = useListeningHistory();
  const likes = useLikes(token);
  // Mirrors the admin "Cache YouTube Music results for" setting — pointless
  // to fire the background artist pre-warm below if caching itself is off,
  // since there'd be nothing for it to warm.
  const [cachingEnabled, setCachingEnabled] = useState(true);
  useEffect(() => {
    if (!token) return;
    getCacheTtlHours(token).then((hours) => setCachingEnabled(hours !== 0));
  }, [token]);

  // Global playback shortcuts — ignored while typing in a text field so
  // e.g. hitting space in the search box still types a space instead of
  // toggling playback.
  useEffect(() => {
    function isTextInput(el: Element | null): boolean {
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (isTextInput(document.activeElement)) return;
      switch (e.code) {
        case "Space":
          e.preventDefault();
          queueApi.togglePlay();
          break;
        case "ArrowUp":
          e.preventDefault();
          queueApi.setVolume(Math.min(1, queueApi.volume + 0.05));
          break;
        case "ArrowDown":
          e.preventDefault();
          queueApi.setVolume(Math.max(0, queueApi.volume - 0.05));
          break;
        case "ArrowLeft":
          e.preventDefault();
          queueApi.prev();
          break;
        case "ArrowRight":
          e.preventDefault();
          queueApi.next();
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [queueApi]);

  // Every change of "current track" counts as a play, regardless of which
  // view started it (search, discover, a playlist, radio...) — this is what
  // backs the Discover page's "Keep listening" / "similar to" rows.
  useEffect(() => {
    if (!queueApi.currentTrack) return;
    history.recordPlay(queueApi.currentTrack);
    // Separate, server-side, real play-count log — backs the Stats page's
    // "top artists/tracks" (ranked by frequency); the client-local history
    // above stays untouched, it still backs Discover's "Your artists" row.
    if (token) recordServerPlay(token, queueApi.currentTrack);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueApi.currentTrack?.id]);

  // Warms the server's response cache for this track's artist page while it
  // plays — tapping through to "more from this artist" is a very common
  // next move, and this way that page is already fast by the time anyone
  // asks for it instead of paying the full external-API latency right when
  // they're waiting on it. Fire-and-forget: nothing here is rendered.
  useEffect(() => {
    const track = queueApi.currentTrack;
    const providerId = track?.sources[0]?.provider_id;
    const artistRef = track?.artist_ref;
    if (!token || !providerId || !artistRef || !cachingEnabled) return;
    fetchArtistTracks(token, providerId, artistRef).catch(() => {});
    fetchArtistReleases(token, providerId, artistRef).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueApi.currentTrack?.artist_ref, token, cachingEnabled]);

  if (checking) return null;
  if (!token || !me) {
    return (
      <Suspense fallback={null}>
        <AuthView onLogin={login} onSetup={setup} onRegister={register} />
      </Suspense>
    );
  }

  // Both close whatever other full-screen overlay is open first — jam-room
  // sits below Now Playing/Detail in z-index (so the player bar can show
  // through it), so leaving one of those open would otherwise hide the
  // jam panel this is meant to bring to the front.
  // Starts a jam immediately if one isn't already running, rather than
  // showing a confirmation screen first — there's nothing to confirm, the
  // worst case is an accidental jam that "End Jam" closes right back out of.
  async function openJamPanel() {
    setNowPlayingOpen(false);
    setDetail(null);
    if (!jamApi.jam) await jamApi.startJam();
    setJamPanelOpen(true);
  }

  const startJamFromMenu = openJamPanel;

  // While acting as a jam remote, this device has nothing real to play
  // locally — tapping a track in Discover should queue it on the actual
  // source device instead of starting (nonexistent) local playback.
  function playFromDiscover(tracks: Track[], startId?: string) {
    if (isRemote) {
      const track = (startId && tracks.find((t) => t.id === startId)) || tracks[0];
      if (track) {
        jamApi.addTrack(track);
        setToast(`Added "${track.title}" to the jam queue`);
      }
      return;
    }
    queueApi.playTracks(tracks, startId);
  }

  async function startRadio(track: Track) {
    const more = await fetchRadio(token!, track);
    queueApi.playTracks([track, ...more]);
    setToast(`Started radio from "${track.title}"`);
  }

  async function shareTrack(track: Track) {
    const source = track.sources[0];
    const url = source?.provider_id === "ytdlp"
      ? `https://music.youtube.com/watch?v=${encodeURIComponent(source.source_ref)}`
      : `https://music.youtube.com/search?q=${encodeURIComponent([track.title, track.artist_name].filter(Boolean).join(" "))}`;
    const shareData = { title: track.title, text: track.artist_name ?? track.title, url };
    const nativeShare = (navigator as { share?: (data: typeof shareData) => Promise<void> }).share;

    try {
      if (nativeShare) await nativeShare.call(navigator, shareData);
      else await navigator.clipboard.writeText(url);
      setToast(nativeShare ? "Share sheet opened" : "YouTube Music link copied");
    } catch (error) {
      // Closing a native share sheet is not an error the user needs to see.
      if ((error as DOMException).name !== "AbortError") setToast("Could not share this track");
    }
  }

  async function shareAlbum(album: DetailTarget, artistName?: string | null) {
    const url = album.providerId === "ytdlp"
      ? `https://music.youtube.com/browse/${encodeURIComponent(album.ref)}`
      : `https://music.youtube.com/search?q=${encodeURIComponent([album.name, artistName].filter(Boolean).join(" "))}`;
    const shareData = { title: album.name, text: artistName ?? album.name, url };
    const nativeShare = (navigator as { share?: (data: typeof shareData) => Promise<void> }).share;

    try {
      if (nativeShare) await nativeShare.call(navigator, shareData);
      else await navigator.clipboard.writeText(url);
      setToast(nativeShare ? "Share sheet opened" : "YouTube Music link copied");
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") setToast("Could not share this album");
    }
  }

  async function shareArtist(artist: DetailTarget) {
    const url = artist.providerId === "ytdlp"
      ? `https://music.youtube.com/channel/${encodeURIComponent(artist.ref)}`
      : `https://music.youtube.com/search?q=${encodeURIComponent(artist.name)}`;
    const shareData = { title: artist.name, text: artist.name, url };
    const nativeShare = (navigator as { share?: (data: typeof shareData) => Promise<void> }).share;

    try {
      if (nativeShare) await nativeShare.call(navigator, shareData);
      else await navigator.clipboard.writeText(url);
      setToast(nativeShare ? "Share sheet opened" : "YouTube Music link copied");
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") setToast("Could not share this artist");
    }
  }

  return (
    <LikesProvider value={likes}>
      <div className="app">
        <header className="app-header">
          <h1>Weave</h1>
          <nav className="app-nav-desktop">
            <NavTabs tab={tab} setTab={setTab} queueCount={queueApi.queue.length} isAdmin={me.is_admin} />
          </nav>
          <button className="app-jam-button" onClick={openJamPanel} title="Weave Jam">
            <JamIcon /> {jamApi.jam ? "Jam" : "Start a Jam"}
          </button>
        </header>

        <main>
          {tab === "search" && (
            <SearchView
              token={token}
              onPlay={queueApi.playTrack}
              onPlayAll={queueApi.playTracks}
              onPlayNext={queueApi.enqueueNext}
              onEnqueue={queueApi.enqueue}
              onRadio={startRadio}
              onShare={shareTrack}
              onOpenDetail={setDetail}
              playlists={playlistApi.playlists}
              addablePlaylists={playlistApi.addablePlaylists}
              onAddToPlaylist={playlistApi.addTrackToPlaylist}
              onStartJam={startJamFromMenu}
              jamActive={!!jamApi.jam}
            />
          )}
          {tab === "discover" && (
            <DiscoverView token={token} onPlay={playFromDiscover} playlists={playlistApi.playlists} historyVersion={history.version} onOpenDetail={(target) => setDetail(target)} />
          )}
          <Suspense fallback={null}>
            {tab === "queue" && (
              <QueueView
                queue={queueApi.queue}
                currentTrackId={queueApi.currentTrack?.id ?? null}
                onPlay={queueApi.playTrack}
                onRemove={queueApi.removeFromQueue}
                onMove={queueApi.moveInQueue}
              />
            )}
            {tab === "playlists" && (
              <PlaylistsView
                token={token}
                selfId={me.id}
                playlists={playlistApi.playlists}
                allPlaylists={playlistApi.allPlaylists}
                onCreate={playlistApi.createPlaylist}
                onDelete={playlistApi.deletePlaylist}
                onRemoveTrack={playlistApi.removeTrackFromPlaylist}
                onPlay={queueApi.playTracks}
              />
            )}
            {tab === "profile" && (
              <ProfileView token={token} me={me} playlistCount={playlistApi.playlists.length} onPlay={queueApi.playTracks} onLogout={logout} />
            )}
            {tab === "admin" && me.is_admin && <AdminView token={token} selfId={me.id} />}
          </Suspense>
        </main>

        <PlayerBar
          queueApi={queueApi}
          onExpand={() => setNowPlayingOpen(true)}
          isRemote={isRemote}
          onRemoteCommand={jamApi.sendCommand}
          remoteVolume={jamApi.live?.volume}
          remoteIsPlaying={jamApi.live?.is_playing}
        />

        <nav className="app-nav-mobile">
          <NavTabs tab={tab} setTab={setTab} queueCount={queueApi.queue.length} isAdmin={me.is_admin} />
        </nav>

        {nowPlayingOpen && (
          <NowPlayingView
            token={token}
            queueApi={queueApi}
            sleepTimer={sleepTimer}
            onClose={() => setNowPlayingOpen(false)}
            onOpenQueue={() => {
              setTab("queue");
              setNowPlayingOpen(false);
            }}
            onRadio={startRadio}
            onShare={shareTrack}
            onOpenDetail={(target) => {
              setDetail(target);
              setNowPlayingOpen(false);
            }}
            playlists={playlistApi.addablePlaylists}
            onAddToPlaylist={playlistApi.addTrackToPlaylist}
            onOpenJam={openJamPanel}
            onStartJam={startJamFromMenu}
            jamActive={!!jamApi.jam}
            jamMemberCount={dedupeMembers(jamApi.members).length}
            isRemote={isRemote}
            onRemoteCommand={jamApi.sendCommand}
            remoteVolume={jamApi.live?.volume}
            remoteIsPlaying={jamApi.live?.is_playing}
            remoteShuffle={jamApi.live?.shuffle}
            remoteRepeat={jamApi.live?.repeat}
          />
        )}

        {detail && (
          <Suspense fallback={null}>
            <DetailView
              target={detail}
              token={token}
              onClose={() => setDetail(null)}
              onPlay={queueApi.playTracks}
              onPlayNext={queueApi.enqueueNext}
              onEnqueue={queueApi.enqueue}
              onRadio={(track) => {
                startRadio(track);
                setDetail(null);
              }}
              onShare={shareTrack}
              onShareAlbum={shareAlbum}
              onShareArtist={shareArtist}
              onOpenDetail={setDetail}
              playlists={playlistApi.addablePlaylists}
              onAddToPlaylist={playlistApi.addTrackToPlaylist}
              onCreatePlaylist={playlistApi.createPlaylist}
              onStartJam={startJamFromMenu}
              jamActive={!!jamApi.jam}
            />
          </Suspense>
        )}

        {jamPanelOpen && jamApi.jam && (
          <Suspense fallback={null}>
            <JamRoom
              searchToken={token}
              members={jamApi.members}
              queueLog={jamApi.queueLog}
              live={jamApi.live}
              recommendations={jamApi.recommendations}
              ended={jamApi.ended}
              onAddTrack={jamApi.addTrack}
              isHost
              onCommand={jamApi.sendCommand}
              isSource={jamApi.isSource}
              settings={jamApi.settings}
              onUpdateSettings={jamApi.updateSettings}
              joinUrl={jamApi.joinUrl}
              onEndJam={() => {
                jamApi.endJam();
                setJamPanelOpen(false);
              }}
              onClose={() => setJamPanelOpen(false)}
            />
          </Suspense>
        )}

        {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
      </div>
    </LikesProvider>
  );
}
