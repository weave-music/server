import { useEffect, useState } from "react";
import { AdminView } from "./AdminView";
import { AuthView } from "./AuthView";
import { DetailView, type DetailTarget } from "./DetailView";
import { DiscoverView } from "./DiscoverView";
import { fetchRadio } from "./api";
import { ChevronDownIcon, JamIcon } from "./icons";
import { JamRoom } from "./JamRoom";
import { dedupeMembers } from "./jamApi";
import { LikesProvider } from "./LikesContext";
import { NavTabs } from "./NavTabs";
import { NowPlayingView } from "./NowPlayingView";
import { PlayerBar } from "./PlayerBar";
import { PlaylistsView } from "./PlaylistsView";
import { QueueView } from "./QueueView";
import { SearchView } from "./SearchView";
import { Toast } from "./Toast";
import { useAuth } from "./useAuth";
import { useJam } from "./useJam";
import { useLikes } from "./useLikes";
import { useListeningHistory } from "./useListeningHistory";
import { useQueue } from "./useQueue";
import { usePlaylists } from "./usePlaylists";
import type { Track } from "./types";

type Tab = "search" | "discover" | "queue" | "playlists" | "admin";

export default function App() {
  const { token, me, checking, login, setup, register, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("discover");
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [jamPanelOpen, setJamPanelOpen] = useState(false);
  const queueApi = useQueue(token);
  const jamApi = useJam(token, queueApi);
  const playlistApi = usePlaylists();
  const history = useListeningHistory();
  const likes = useLikes(token);

  // Every change of "current track" counts as a play, regardless of which
  // view started it (search, discover, a playlist, radio...) — this is what
  // backs the Discover page's "Keep listening" / "similar to" rows.
  useEffect(() => {
    if (queueApi.currentTrack) history.recordPlay(queueApi.currentTrack);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueApi.currentTrack?.id]);

  if (checking) return null;
  if (!token || !me) return <AuthView onLogin={login} onSetup={setup} onRegister={register} />;

  // Both close whatever other full-screen overlay is open first — jam-room
  // sits below Now Playing/Detail in z-index (so the player bar can show
  // through it), so leaving one of those open would otherwise hide the
  // jam panel this is meant to bring to the front.
  function openJamPanel() {
    setNowPlayingOpen(false);
    setDetail(null);
    setJamPanelOpen(true);
  }

  async function startJamFromMenu() {
    setNowPlayingOpen(false);
    setDetail(null);
    if (!jamApi.jam) await jamApi.startJam();
    setJamPanelOpen(true);
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
          <span className="app-user">
            {me.username} <button onClick={logout}>Log out</button>
          </span>
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
              onAddToPlaylist={playlistApi.addTrackToPlaylist}
              onStartJam={startJamFromMenu}
              jamActive={!!jamApi.jam}
            />
          )}
          {tab === "discover" && (
            <DiscoverView token={token} onPlay={queueApi.playTracks} playlists={playlistApi.playlists} historyVersion={history.version} onOpenDetail={(target) => setDetail(target)} />
          )}
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
              playlists={playlistApi.playlists}
              onCreate={playlistApi.createPlaylist}
              onDelete={playlistApi.deletePlaylist}
              onRemoveTrack={playlistApi.removeTrackFromPlaylist}
              onPlay={queueApi.playTracks}
            />
          )}
          {tab === "admin" && me.is_admin && <AdminView token={token} selfId={me.id} />}
        </main>

        <PlayerBar queueApi={queueApi} onExpand={() => setNowPlayingOpen(true)} />

        <nav className="app-nav-mobile">
          <NavTabs tab={tab} setTab={setTab} queueCount={queueApi.queue.length} isAdmin={me.is_admin} />
        </nav>

        {nowPlayingOpen && (
          <NowPlayingView
            queueApi={queueApi}
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
            playlists={playlistApi.playlists}
            onAddToPlaylist={playlistApi.addTrackToPlaylist}
            onOpenJam={openJamPanel}
            onStartJam={startJamFromMenu}
            jamActive={!!jamApi.jam}
            jamMemberCount={dedupeMembers(jamApi.members).length}
          />
        )}

        {detail && (
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
            playlists={playlistApi.playlists}
            onAddToPlaylist={playlistApi.addTrackToPlaylist}
            onCreatePlaylist={playlistApi.createPlaylist}
            onStartJam={startJamFromMenu}
            jamActive={!!jamApi.jam}
          />
        )}

        {jamPanelOpen && (
          jamApi.jam ? (
            <JamRoom
              searchToken={token}
              members={jamApi.members}
              queueLog={jamApi.queueLog}
              live={jamApi.live}
              recommendations={jamApi.recommendations}
              ended={jamApi.ended}
              onAddTrack={jamApi.addTrack}
              isHost
              onSkip={queueApi.sendSkipCommand}
              joinUrl={jamApi.joinUrl}
              onEndJam={() => {
                jamApi.endJam();
                setJamPanelOpen(false);
              }}
              onClose={() => setJamPanelOpen(false)}
            />
          ) : (
            <div className="jam-start-cta">
              <button onClick={() => setJamPanelOpen(false)} title="Close" className="jam-start-cta-close">
                <ChevronDownIcon />
              </button>
              <h2>Start a Jam</h2>
              <p>Invite people to add songs to your queue from their own phones.</p>
              <button
                className="jam-start-cta-button"
                onClick={async () => {
                  await jamApi.startJam();
                }}
              >
                Start Jam
              </button>
            </div>
          )
        )}

        {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
      </div>
    </LikesProvider>
  );
}
