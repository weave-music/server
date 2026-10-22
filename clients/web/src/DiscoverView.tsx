import { useEffect, useState } from "react";
import { fetchFeatured, fetchRadio, searchTracks } from "./api";
import { Artwork } from "./Artwork";
import { DiscIcon } from "./icons";
import { Row } from "./Row";
import { useListeningHistory } from "./useListeningHistory";
import type { Playlist } from "./usePlaylists";
import type { Track } from "./types";

const GENRES = ["Pop", "Rock", "Hip Hop", "Country", "R&B", "Electronic", "Jazz", "Punk", "Metal", "Folk"];

interface RowState {
  id: string;
  title: string;
  subtitle?: string;
  tracks: Track[];
  loading: boolean;
}

interface Props {
  token: string;
  onPlay: (tracks: Track[], startId?: string) => void;
  playlists: Playlist[];
}

export function DiscoverView({ token, onPlay, playlists }: Props) {
  const history = useListeningHistory();
  const [rows, setRows] = useState<RowState[]>([]);
  const recentlyPlayed = history.getRecentTracks(10);

  useEffect(() => {
    const recentArtists = history.getRecentArtists(2);
    const initial: RowState[] = [
      { id: "recap", title: "Recap", tracks: [], loading: true },
      ...recentArtists.map((r, i) => ({
        id: `similar-${i}`,
        title: r.artist,
        subtitle: "Similar to",
        tracks: [],
        loading: true,
      })),
      ...GENRES.map((g) => ({ id: `genre-${g}`, title: g, tracks: [], loading: true })),
    ];
    setRows(initial);

    const updateRow = (id: string, tracks: Track[]) =>
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, tracks, loading: false } : r)));

    fetchFeatured(token).then((tracks) => updateRow("recap", tracks));
    recentArtists.forEach((r, i) => {
      fetchRadio(token, r.track).then((tracks) => updateRow(`similar-${i}`, tracks));
    });
    GENRES.forEach((g) => {
      searchTracks(g, token).then((tracks) => updateRow(`genre-${g}`, tracks));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="home-feed">
      {rows.length > 0 && (
        <Row
          title={rows[0].title}
          tracks={rows[0].tracks}
          loading={rows[0].loading}
          onPlay={onPlay}
        />
      )}

      {recentlyPlayed.length > 0 && (
        <Row title="Keep listening" tracks={recentlyPlayed} onPlay={onPlay} />
      )}

      {rows.slice(1).map((row) => (
        <Row
          key={row.id}
          title={row.title}
          subtitle={row.subtitle}
          tracks={row.tracks}
          loading={row.loading}
          onPlay={onPlay}
        />
      ))}

      {playlists.length > 0 && (
        <section className="home-row">
          <div className="home-row-heading">
            <h3>Your playlists</h3>
          </div>
          <div className="home-row-scroll">
            {playlists.map((pl) => (
              <button
                key={pl.id}
                className="home-card"
                disabled={pl.tracks.length === 0}
                onClick={() => onPlay(pl.tracks)}
              >
                <div
                  className={`home-card-playlist-art${pl.tracks.length === 0 ? " home-card-playlist-art-empty" : ""}`}
                >
                  {pl.tracks.length > 0 ? (
                    pl.tracks.slice(0, 4).map((t, i) => <Artwork key={i} url={t.artwork_url} size="sm" alt="" />)
                  ) : (
                    <DiscIcon />
                  )}
                </div>
                <span className="home-card-title">{pl.name}</span>
                <span className="home-card-subtitle">{pl.tracks.length} tracks</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
