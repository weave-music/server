CREATE TABLE cached_tracks (
    provider_id TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    file_path TEXT NOT NULL,
    cached_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider_id, source_ref)
);
