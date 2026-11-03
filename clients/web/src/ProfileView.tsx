import { useEffect, useState } from "react";
import { fetchLikes, fetchStats, type Stats } from "./api";
import { EmptyState } from "./EmptyState";
import { EntityCard } from "./EntityCard";
import { StatsIcon } from "./icons";
import { Spinner } from "./Spinner";
import { TrackRow } from "./TrackRow";
import type { Track } from "./types";

interface Me {
  username: string;
  is_admin: boolean;
}

interface Props {
  token: string;
  me: Me;
  playlistCount: number;
  onPlay: (tracks: Track[], startId?: string) => void;
  onLogout: () => void;
}

export function ProfileView({ token, me, playlistCount, onPlay, onLogout }: Props) {
  const [likedCount, setLikedCount] = useState<number | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetchLikes(token).then((tracks) => setLikedCount(tracks.length));
    fetchStats(token).then(setStats);
  }, [token]);

  const topTracks = stats?.top_tracks.map((t) => t.track) ?? [];

  return (
    <section>
      <div className="profile-header">
        <div className="profile-avatar">{me.username.slice(0, 1).toUpperCase()}</div>
        <div className="profile-header-text">
          <h2>{me.username}</h2>
          {me.is_admin && <span className="tag">Admin</span>}
        </div>
        <button onClick={onLogout}>Log out</button>
      </div>

      <div className="stats-summary">
        <div className="stats-summary-item">
          <span className="stats-summary-number">{stats?.total_plays ?? "—"}</span>
          <span>plays logged</span>
        </div>
        <div className="stats-summary-item">
          <span className="stats-summary-number">{likedCount ?? "—"}</span>
          <span>liked songs</span>
        </div>
        <div className="stats-summary-item">
          <span className="stats-summary-number">{playlistCount}</span>
          <span>playlists</span>
        </div>
      </div>

      {!stats && (
        <p className="detail-view-note">
          <Spinner /> Loading…
        </p>
      )}

      {stats && stats.top_artists.length > 0 && (
        <section className="home-row">
          <div className="home-row-heading">
            <h3>Top Artists</h3>
          </div>
          <div className="home-row-scroll">
            {stats.top_artists.map((a) => (
              <EntityCard
                key={a.artist_name}
                name={a.artist_name}
                subtitle={`${a.play_count} play${a.play_count === 1 ? "" : "s"}`}
                artworkUrl={null}
                round
                onClick={() => {}}
              />
            ))}
          </div>
        </section>
      )}

      {stats && topTracks.length > 0 && (
        <section className="home-row">
          <div className="home-row-heading">
            <h3>Top Tracks</h3>
          </div>
          <ul className="track-list">
            {topTracks.map((track, i) => (
              <TrackRow key={track.id} track={track} onPlay={() => onPlay(topTracks, track.id)}>
                <span className="jam-room-empty">{stats.top_tracks[i]!.play_count} plays</span>
              </TrackRow>
            ))}
          </ul>
        </section>
      )}

      {stats && stats.total_plays === 0 && (
        <EmptyState
          icon={<StatsIcon />}
          title="Nothing here yet"
          message="Play a few tracks and your stats will show up here."
        />
      )}
    </section>
  );
}
