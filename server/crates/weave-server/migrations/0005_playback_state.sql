-- One row per user holding whatever track they most recently played, so any
-- device can pick up "now playing" on load, and the live WS broadcast can
-- tell every other open device a new one just took over.
CREATE TABLE playback_state (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    provider_id TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    title TEXT NOT NULL,
    artist_name TEXT,
    album_name TEXT,
    artwork_url TEXT,
    duration_secs INTEGER,
    position_secs REAL NOT NULL DEFAULT 0,
    is_playing INTEGER NOT NULL DEFAULT 0,
    device_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
