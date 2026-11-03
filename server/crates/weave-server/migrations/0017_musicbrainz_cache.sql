-- Caches MusicBrainz recording lookups (server/src/musicbrainz.rs) so
-- repeated likes of the same artist/track don't re-hit the public API,
-- which is rate-limited to ~1 request/second for anonymous clients.
CREATE TABLE musicbrainz_cache (
    query_key TEXT PRIMARY KEY,
    recording_mbid TEXT,
    artist_mbid TEXT,
    release_group_mbid TEXT,
    canonical_artist TEXT,
    canonical_title TEXT,
    canonical_album TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
