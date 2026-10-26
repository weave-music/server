import { useEffect, useState } from "react";
import { fetchFeatured, fetchLikes, fetchRadio, searchExternalPlaylists } from "./api";
import { Artwork } from "./Artwork";
import { DiscIcon } from "./icons";
import { Row } from "./Row";
import { EntityCard } from "./EntityCard";
import { useListeningHistory } from "./useListeningHistory";
import type { DetailTarget } from "./DetailView";
import type { Playlist } from "./usePlaylists";
import type { ExternalPlaylist, Track } from "./types";

const GENRES = ["Pop", "Rock", "Hip Hop", "Country", "R&B", "Electronic", "Jazz", "Punk", "Metal", "Folk"];

function sourceKey(track: Track): string | null {
  const s = track.sources[0];
  return s ? `${s.provider_id}:${s.source_ref}` : null;
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

interface RowState {
  id: string;
  title: string;
  subtitle?: string;
  tracks: Track[];
  loading: boolean;
}

interface GenreRowState {
  id: string;
  title: string;
  playlists: ExternalPlaylist[];
  loading: boolean;
}

interface Props {
  token: string;
  onPlay: (tracks: Track[], startId?: string) => void;
  playlists: Playlist[];
  historyVersion: number;
  onOpenDetail?: (target: DetailTarget) => void;
}

export function DiscoverView({ token, onPlay, playlists, historyVersion, onOpenDetail }: Props) {
  const history = useListeningHistory();
  const [rows, setRows] = useState<RowState[]>([]);
  const [genreRows, setGenreRows] = useState<GenreRowState[]>([]);
  const recentlyPlayed = history.getRecentTracks(10);
  const recentArtists = history.getRecentArtists(6);

  useEffect(() => {
    const seedArtists = history.getRecentArtists(2);
    const initial: RowState[] = [
      { id: "recap", title: "For You", tracks: [], loading: true },
      ...seedArtists.map((r, i) => ({
        id: `similar-${i}`,
        title: r.artist,
        subtitle: "Similar to",
        tracks: [],
        loading: true,
      })),
    ];
    setRows(initial);
    setGenreRows(GENRES.map((g) => ({ id: `genre-${g}`, title: g, playlists: [], loading: true })));

    const updateRow = (id: string, tracks: Track[], subtitle?: string) =>
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, tracks, subtitle, loading: false } : r)));
    const updateGenreRow = (id: string, playlists: ExternalPlaylist[]) =>
      setGenreRows((rs) => rs.map((r) => (r.id === id ? { ...r, playlists, loading: false } : r)));

    // Seeded off whatever taste signal exists (liked tracks first — an
    // explicit "I like this" beats an incidental play — then recent plays),
    // via the same radio/mix mechanism "Similar to X" already uses. Falls
    // back to the old randomized sample across providers only when there's
    // truly no signal yet (a brand-new account), since there's nothing to
    // seed a recommendation off of.
    async function loadRecap() {
      const liked = await fetchLikes(token).catch(() => [] as Track[]);
      const recent = history.getRecentTracks(10);
      const seeds: Track[] = [];
      const seedKeys = new Set<string>();
      for (const t of [...liked, ...recent]) {
        const key = sourceKey(t);
        if (!key || seedKeys.has(key)) continue;
        seedKeys.add(key);
        seeds.push(t);
        if (seeds.length >= 4) break;
      }

      if (seeds.length === 0) {
        fetchFeatured(token).then((tracks) => updateRow("recap", tracks));
        return;
      }

      const batches = await Promise.all(seeds.map((t) => fetchRadio(token, t)));
      const merged: Track[] = [];
      const seen = new Set(seedKeys);
      for (const batch of batches) {
        for (const t of batch) {
          const key = sourceKey(t);
          if (key && !seen.has(key)) {
            seen.add(key);
            merged.push(t);
          }
        }
      }
      updateRow("recap", shuffled(merged).slice(0, 20), "Based on what you play and like");
    }
    loadRecap();
    seedArtists.forEach((r, i) => {
      fetchRadio(token, r.track).then((tracks) => updateRow(`similar-${i}`, tracks));
    });
    // Real YouTube Music playlists for each genre, found the same way the
    // Search page finds them (search_playlists) — YT Music's own curated
    // mood/genre browse endpoint (get_mood_playlists) currently errors out
    // on every genre against the installed ytmusicapi version (an upstream
    // parsing bug, not something fixable here), so this reuses the
    // already-working playlist search instead of that broken endpoint.
    GENRES.forEach((g) => {
      searchExternalPlaylists(g, token).then((playlists) => updateGenreRow(`genre-${g}`, playlists));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, historyVersion]);

  return (
    <div className="home-feed">
      {rows.length > 0 && (
        <Row
          title={rows[0].title}
          subtitle={rows[0].subtitle}
          tracks={rows[0].tracks}
          loading={rows[0].loading}
          onPlay={onPlay}
        />
      )}

      {recentlyPlayed.length > 0 && (
        <Row title="Keep listening" tracks={recentlyPlayed} onPlay={onPlay} />
      )}

      {onOpenDetail && recentArtists.length > 0 && (
        <section className="home-row">
          <div className="home-row-heading">
            <h3>Your artists</h3>
            <span className="home-row-subtitle">Based on what you play</span>
          </div>
          <div className="home-row-scroll">
            {recentArtists.map(({ artist, track }) => track.artist_ref && track.sources[0] && (
              <EntityCard
                key={`${track.sources[0].provider_id}:${track.artist_ref}`}
                name={artist}
                artworkUrl={track.artwork_url}
                round
                onClick={() => onOpenDetail({
                  type: "artist",
                  providerId: track.sources[0]!.provider_id,
                  ref: track.artist_ref!,
                  name: artist,
                })}
              />
            ))}
          </div>
        </section>
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

      {onOpenDetail &&
        genreRows.map((row) => {
          if (!row.loading && row.playlists.length === 0) return null;
          return (
            <section key={row.id} className="home-row">
              <div className="home-row-heading">
                <h3>{row.title}</h3>
              </div>
              <div className="home-row-scroll">
                {row.loading && row.playlists.length === 0
                  ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="home-card home-card-skeleton" />)
                  : row.playlists.map((p) => (
                      <EntityCard
                        key={p.id}
                        name={p.title}
                        subtitle={p.track_count != null ? `${p.track_count} songs` : undefined}
                        artworkUrl={p.artwork_url}
                        onClick={() => onOpenDetail({ type: "playlist", providerId: p.provider_id, ref: p.id, name: p.title })}
                      />
                    ))}
              </div>
            </section>
          );
        })}

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
