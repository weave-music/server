import { useEffect, useState } from "react";
import { AdminView } from "./AdminView";
import { AuthView } from "./AuthView";
import { DetailView, type DetailTarget } from "./DetailView";
import { DiscoverView } from "./DiscoverView";
import { fetchRadio } from "./api";
import { NavTabs } from "./NavTabs";
import { NowPlayingView } from "./NowPlayingView";
import { PlayerBar } from "./PlayerBar";
import { PlaylistsView } from "./PlaylistsView";
import { QueueView } from "./QueueView";
import { SearchView } from "./SearchView";
import { useAuth } from "./useAuth";
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
  const queueApi = useQueue(token);
  const playlistApi = usePlaylists();
  const history = useListeningHistory();

  // Every change of "current track" counts as a play, regardless of which
  // view started it (search, discover, a playlist, radio...) — this is what
  // backs the Discover page's "Keep listening" / "similar to" rows.
  useEffect(() => {
    if (queueApi.currentTrack) history.recordPlay(queueApi.currentTrack);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueApi.currentTrack?.id]);

  if (checking) return null;
  if (!token || !me) return <AuthView onLogin={login} onSetup={setup} onRegister={register} />;

  async function startRadio(track: Track) {
    const more = await fetchRadio(token!, track);
    queueApi.playTracks([track, ...more]);
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Weave</h1>
        <nav className="app-nav-desktop">
          <NavTabs tab={tab} setTab={setTab} queueCount={queueApi.queue.length} isAdmin={me.is_admin} />
        </nav>
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
            onEnqueue={queueApi.enqueue}
            onRadio={startRadio}
            onOpenDetail={setDetail}
            playlists={playlistApi.playlists}
            onAddToPlaylist={playlistApi.addTrackToPlaylist}
          />
        )}
        {tab === "discover" && (
          <DiscoverView token={token} onPlay={queueApi.playTracks} playlists={playlistApi.playlists} />
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
          onRadio={(track) => {
            startRadio(track);
            setNowPlayingOpen(false);
          }}
          onOpenDetail={(target) => {
            setDetail(target);
            setNowPlayingOpen(false);
          }}
        />
      )}

      {detail && (
        <DetailView
          target={detail}
          token={token}
          onClose={() => setDetail(null)}
          onPlay={queueApi.playTracks}
          onRadio={(track) => {
            startRadio(track);
            setDetail(null);
          }}
          onOpenDetail={setDetail}
        />
      )}
    </div>
  );
}
