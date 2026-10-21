import { useMemo, useState } from "react";
import { searchTracks } from "./api";
import { Artwork } from "./Artwork";
import type { DetailTarget } from "./DetailView";
import { EntityCard } from "./EntityCard";
import { RadioIcon } from "./icons";
import { TrackRow } from "./TrackRow";
import type { Playlist } from "./usePlaylists";
import type { Track } from "./types";

type FilterTab = "all" | "songs" | "artists" | "albums" | "playlists";

interface Props {
  token: string;
  onPlay: (track: Track) => void;
  onPlayAll: (tracks: Track[], startId?: string) => void;
  onEnqueue: (track: Track) => void;
  onRadio: (track: Track) => void;
  onOpenDetail: (target: DetailTarget) => void;
  playlists: Playlist[];
  onAddToPlaylist: (playlistId: string, track: Track) => void;
}

export function SearchView({
  token,
  onPlay,
  onPlayAll,
  onEnqueue,
  onRadio,
  onOpenDetail,
  playlists,
  onAddToPlaylist,
}: Props) {
  const [query, setQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<FilterTab>("all");

  // Artist/album browsing is derived from whatever the current result set
  // already carries (artist_ref / album_ref) — no separate search needed,
  // and it naturally only shows up for providers that actually support it
  // (see REQUIREMENTS: yt-dlp has artists, local files have albums).
  const artists = useMemo(() => {
    const seen = new Map<string, Track>();
    for (const t of results) {
      if (t.artist_ref && t.artist_name) seen.set(`${t.sources[0]?.provider_id}:${t.artist_ref}`, t);
    }
    return [...seen.values()];
  }, [results]);

  const albums = useMemo(() => {
    const seen = new Map<string, Track>();
    for (const t of results) {
      if (t.album_ref && t.album_name) seen.set(`${t.sources[0]?.provider_id}:${t.album_ref}`, t);
    }
    return [...seen.values()];
  }, [results]);

  // Playlists aren't server-side searchable (they're local to the browser —
  // see usePlaylists), so this just matches by name against the committed
  // query instead of issuing a separate search.
  const matchingPlaylists = useMemo(() => {
    const needle = committedQuery.trim().toLowerCase();
    if (!needle) return [];
    return playlists.filter((p) => p.name.toLowerCase().includes(needle));
  }, [playlists, committedQuery]);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      setResults(await searchTracks(query, token));
      setCommittedQuery(query);
      setTab("all");
    } finally {
      setLoading(false);
    }
  }

  const hasResults = results.length > 0 || matchingPlaylists.length > 0;

  function playlistButton(key: string, name: string, tracks: Track[]) {
    return (
      <li key={key}>
        <button className="entity-row" onClick={() => tracks.length > 0 && onPlayAll(tracks)} disabled={tracks.length === 0}>
          <div className="home-card-playlist-art">
            {tracks.length > 0 ? (
              tracks.slice(0, 4).map((t, i) => <Artwork key={i} url={t.artwork_url} size="sm" alt="" />)
            ) : (
              <Artwork url={null} alt="" />
            )}
          </div>
          <span className="entity-name">{name}</span>
        </button>
      </li>
    );
  }

  function songRows(tracks: Track[]) {
    return (
      <ul className="track-list">
        {tracks.map((track) => (
          <TrackRow key={track.id} track={track} onPlay={() => onPlay(track)}>
            <button onClick={() => onEnqueue(track)} title="Add to queue">
              + Queue
            </button>
            <button onClick={() => onRadio(track)} title="Start a radio queue from this track">
              <RadioIcon /> Radio
            </button>
            {playlists.length > 0 && (
              <select
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) onAddToPlaylist(e.target.value, track);
                  e.target.value = "";
                }}
              >
                <option value="" disabled>
                  + Playlist
                </option>
                {playlists.map((pl) => (
                  <option key={pl.id} value={pl.id}>
                    {pl.name}
                  </option>
                ))}
              </select>
            )}
          </TrackRow>
        ))}
      </ul>
    );
  }

  return (
    <section>
      <form onSubmit={runSearch}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your library and providers..."
        />
        <button type="submit" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
        {results.length > 0 && (
          <button type="button" onClick={() => onPlayAll(results)}>
            Play all
          </button>
        )}
      </form>

      {hasResults && (
        <div className="filter-tabs">
          <button className={tab === "all" ? "active" : ""} onClick={() => setTab("all")}>
            All
          </button>
          {results.length > 0 && (
            <button className={tab === "songs" ? "active" : ""} onClick={() => setTab("songs")}>
              Songs ({results.length})
            </button>
          )}
          {artists.length > 0 && (
            <button className={tab === "artists" ? "active" : ""} onClick={() => setTab("artists")}>
              Artists ({artists.length})
            </button>
          )}
          {albums.length > 0 && (
            <button className={tab === "albums" ? "active" : ""} onClick={() => setTab("albums")}>
              Albums ({albums.length})
            </button>
          )}
          {matchingPlaylists.length > 0 && (
            <button className={tab === "playlists" ? "active" : ""} onClick={() => setTab("playlists")}>
              Playlists ({matchingPlaylists.length})
            </button>
          )}
        </div>
      )}

      {tab === "all" && (
        <>
          {artists.length > 0 && (
            <section className="home-row">
              <div className="home-row-heading">
                <h3>Artists</h3>
              </div>
              <div className="home-row-scroll">
                {artists.slice(0, 10).map((t) => (
                  <EntityCard
                    key={t.artist_ref}
                    name={t.artist_name!}
                    artworkUrl={t.artwork_url}
                    round
                    onClick={() =>
                      onOpenDetail({
                        type: "artist",
                        providerId: t.sources[0]!.provider_id,
                        ref: t.artist_ref!,
                        name: t.artist_name!,
                      })
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {albums.length > 0 && (
            <section className="home-row">
              <div className="home-row-heading">
                <h3>Albums</h3>
              </div>
              <div className="home-row-scroll">
                {albums.slice(0, 10).map((t) => (
                  <EntityCard
                    key={t.album_ref}
                    name={t.album_name!}
                    artworkUrl={t.artwork_url}
                    onClick={() =>
                      onOpenDetail({
                        type: "album",
                        providerId: t.sources[0]!.provider_id,
                        ref: t.album_ref!,
                        name: t.album_name!,
                      })
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {matchingPlaylists.length > 0 && (
            <section className="home-row">
              <div className="home-row-heading">
                <h3>Playlists</h3>
              </div>
              <ul className="entity-list">
                {matchingPlaylists.map((pl) => playlistButton(pl.id, pl.name, pl.tracks))}
              </ul>
            </section>
          )}

          {results.length > 0 && (
            <section className="home-row">
              <div className="home-row-heading">
                <h3>Songs</h3>
              </div>
              {songRows(results)}
            </section>
          )}
        </>
      )}

      {tab === "songs" && songRows(results)}

      {tab === "artists" && (
        <ul className="entity-list">
          {artists.map((t) => (
            <li key={t.artist_ref}>
              <button
                className="entity-row"
                onClick={() =>
                  onOpenDetail({
                    type: "artist",
                    providerId: t.sources[0]!.provider_id,
                    ref: t.artist_ref!,
                    name: t.artist_name!,
                  })
                }
              >
                <Artwork url={t.artwork_url} alt="" />
                <span className="entity-name">{t.artist_name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {tab === "albums" && (
        <ul className="entity-list">
          {albums.map((t) => (
            <li key={t.album_ref}>
              <button
                className="entity-row"
                onClick={() =>
                  onOpenDetail({
                    type: "album",
                    providerId: t.sources[0]!.provider_id,
                    ref: t.album_ref!,
                    name: t.album_name!,
                  })
                }
              >
                <Artwork url={t.artwork_url} alt="" />
                <span className="entity-name">{t.album_name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {tab === "playlists" && (
        <ul className="entity-list">
          {matchingPlaylists.map((pl) => playlistButton(pl.id, pl.name, pl.tracks))}
        </ul>
      )}
    </section>
  );
}
