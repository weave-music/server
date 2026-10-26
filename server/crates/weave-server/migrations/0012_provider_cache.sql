-- Persists YtDlpProvider's response cache (search, genre playlists, radio,
-- artist/album/playlist browsing) across restarts/deploys, not just within
-- a single process lifetime — see weave-provider-ytdlp. cache_key is the
-- exact process invocation (bridge args or yt-dlp list-spec+limit) that
-- produced the data, so a hit is byte-identical to a fresh call.
CREATE TABLE provider_cache (
    cache_key TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    inserted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
