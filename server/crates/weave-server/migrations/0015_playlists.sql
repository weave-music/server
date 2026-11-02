CREATE TABLE playlists (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_playlists_owner ON playlists(owner_id);

CREATE TABLE playlist_tracks (
    id TEXT PRIMARY KEY,
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    provider_id TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    title TEXT NOT NULL,
    artist_name TEXT,
    artist_ref TEXT,
    album_name TEXT,
    album_ref TEXT,
    artwork_url TEXT,
    duration_secs INTEGER,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_playlist_tracks_playlist ON playlist_tracks(playlist_id, position);
