-- Caches embedded audio tags read via lofty (weave-provider-local), keyed
-- by file path with mtime/size so a background scan can tell which files
-- need re-parsing without re-reading every file's tags on every request.
CREATE TABLE local_tag_cache (
    path TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    title TEXT,
    artist_name TEXT,
    album_name TEXT,
    track_number INTEGER,
    duration_secs INTEGER,
    is_lossless INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
