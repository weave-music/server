CREATE TABLE liked_tracks (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    title TEXT NOT NULL,
    artist_name TEXT,
    album_name TEXT,
    artwork_url TEXT,
    duration_secs INTEGER,
    liked_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, provider_id, source_ref)
);
