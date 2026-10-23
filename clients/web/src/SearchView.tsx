import { useEffect, useMemo, useRef, useState } from "react";
import { searchTracks } from "./api";
import { Artwork } from "./Artwork";
import type { DetailTarget } from "./DetailView";
import { EntityCard } from "./EntityCard";
import { LikeButton } from "./LikeButton";
import { TrackOverflowMenu } from "./TrackOverflowMenu";
import { TrackRow } from "./TrackRow";
import type { Playlist } from "./usePlaylists";
import type { Track } from "./types";

const SEARCH_HISTORY_KEY = "weave.search-history.v1";
const MAX_SEARCH_HISTORY = 8;

function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

type FilterTab = "all" | "songs" | "artists" | "albums" | "playlists";

interface Props {
  token: string;
  onPlay: (track: Track) => void;
  onPlayAll: (tracks: Track[], startId?: string) => void;
  onPlayNext: (track: Track) => void;
  onEnqueue: (track: Track) => void;
  onRadio: (track: Track) => void;
  onShare: (track: Track) => void | Promise<void>;
  onOpenDetail: (target: DetailTarget) => void;
  playlists: Playlist[];
  onAddToPlaylist: (playlistId: string, track: Track) => void;
  onStartJam: () => void;
  jamActive: boolean;
}

export function SearchView({
  token,
  onPlay,
  onPlayAll,
  onPlayNext,
  onEnqueue,
  onRadio,
  onShare,
  onOpenDetail,
  playlists,
  onAddToPlaylist,
  onStartJam,
  jamActive,
}: Props) {
  const [query, setQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<FilterTab>("all");
  const [searchHistory, setSearchHistory] = useState<string[]>(loadSearchHistory);
  const [searchFocused, setSearchFocused] = useState(false);
  const [liveSuggestions, setLiveSuggestions] = useState<Track[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  // Guards against a slower, earlier request's response landing after a
  // faster, more recent one — only the latest keystroke's result sticks.
  const suggestionRequestRef = useRef(0);

  // Live typeahead: a handful of real track matches as you type, separate
  // from the committed full-results list below (which only updates on
  // Enter/Search). Debounced since every keystroke hitting the ytdlp
  // provider would mean shelling out to yt-dlp on every keystroke.
  useEffect(() => {
    const term = query.trim();
    if (!searchFocused || term.length < 2) {
      setLiveSuggestions([]);
      setSuggesting(false);
      return;
    }
    const requestId = ++suggestionRequestRef.current;
    setSuggesting(true);
    const timer = setTimeout(() => {
      searchTracks(term, token).then((tracks) => {
        if (suggestionRequestRef.current !== requestId) return;
        setLiveSuggestions(tracks.slice(0, 6));
        setSuggesting(false);
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [query, token, searchFocused]);

  const autocompleteHistory = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return searchHistory.filter((term) => !needle || term.toLowerCase().includes(needle));
  }, [query, searchHistory]);

  const autocompletePlaylists = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return playlists.filter((playlist) => !needle || playlist.name.toLowerCase().includes(needle));
  }, [query, playlists]);

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

  async function performSearch(term: string) {
    const cleanTerm = term.trim();
    if (!cleanTerm) return;
    setLoading(true);
    try {
      setResults(await searchTracks(cleanTerm, token));
      setCommittedQuery(cleanTerm);
      setTab("all");
      setSearchHistory((previous) => {
        const next = [cleanTerm, ...previous.filter((entry) => entry.toLowerCase() !== cleanTerm.toLowerCase())].slice(0, MAX_SEARCH_HISTORY);
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
        return next;
      });
    } finally {
      setLoading(false);
    }
  }

  function runSearch(e: React.FormEvent) {
    e.preventDefault();
    void performSearch(query);
  }

  function clearSearchHistory() {
    localStorage.removeItem(SEARCH_HISTORY_KEY);
    setSearchHistory([]);
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
            <LikeButton track={track} />
            <TrackOverflowMenu
              track={track}
              playlists={playlists}
              onPlayNext={onPlayNext}
              onEnqueue={onEnqueue}
              onShare={onShare}
              onRadio={onRadio}
              onAddToPlaylist={onAddToPlaylist}
              onOpenDetail={onOpenDetail}
              onStartJam={onStartJam}
              jamActive={jamActive}
            />
          </TrackRow>
        ))}
      </ul>
    );
  }

  return (
    <section>
      <div className="search-panel">
      <form className="search-form" onSubmit={runSearch}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
          placeholder="Search your library and providers..."
          aria-label="Search your library and providers"
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
      {searchFocused &&
        (liveSuggestions.length > 0 || autocompleteHistory.length > 0 || autocompletePlaylists.length > 0) && (
        <div className="search-history" onMouseDown={(e) => e.preventDefault()}>
          {query.trim().length >= 2 && liveSuggestions.length > 0 && (
            <>
              <div className="search-history-heading"><span>Tracks</span></div>
              {liveSuggestions.map((track) => (
                <button
                  key={track.id}
                  type="button"
                  className="search-suggestion-track"
                  onClick={() => {
                    setSearchFocused(false);
                    onPlay(track);
                  }}
                >
                  <Artwork url={track.artwork_url} size="sm" alt="" />
                  <span className="search-suggestion-text">
                    <span className="search-suggestion-title">{track.title}</span>
                    {track.artist_name && <span className="search-suggestion-artist">{track.artist_name}</span>}
                  </span>
                </button>
              ))}
            </>
          )}
          {autocompleteHistory.length > 0 && (
            <>
              <div className="search-history-heading"><span>{query.trim() ? "Suggestions" : "Recent searches"}</span><button type="button" onClick={clearSearchHistory}>Clear</button></div>
              {autocompleteHistory.map((term) => (
                <button key={`search-${term}`} type="button" onClick={() => { setQuery(term); setSearchFocused(false); void performSearch(term); }}>
                  <span className="search-history-icon">⌕</span>{term}
                </button>
              ))}
            </>
          )}
          {autocompletePlaylists.length > 0 && (
            <>
              <div className="search-history-heading"><span>Playlists</span></div>
              {autocompletePlaylists.slice(0, 6).map((playlist) => (
                <button key={`playlist-${playlist.id}`} type="button" disabled={playlist.tracks.length === 0} onClick={() => { setSearchFocused(false); if (playlist.tracks.length > 0) onPlayAll(playlist.tracks); }}>
                  <span className="search-history-icon">♫</span>{playlist.name}
                  <span className="search-history-meta">{playlist.tracks.length} tracks</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
      </div>

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
