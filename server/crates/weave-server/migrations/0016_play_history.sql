CREATE TABLE play_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    title TEXT NOT NULL,
    artist_name TEXT,
    album_name TEXT,
    artwork_url TEXT,
    played_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_play_history_user ON play_history(user_id, played_at);
