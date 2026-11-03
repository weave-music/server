-- Tracks the state of an auto-triggered Lidarr "upgrade" for a liked,
-- ytdlp-sourced track — global (not per-user), same scope as cached_tracks,
-- since the underlying cached/upgraded file is shared across users.
CREATE TABLE track_upgrades (
    provider_id TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    status TEXT NOT NULL, -- 'requested' | 'upgraded' | 'no_match'
    lidarr_artist_id INTEGER,
    lidarr_album_id INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider_id, source_ref)
);
