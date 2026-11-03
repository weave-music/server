-- Captures the actual audio quality of a cached file (probed via ffprobe
-- right after it lands, since yt-dlp's "bestaudio" download bitrate varies
-- per video and a real Lidarr-sourced file's quality is whatever the
-- grabbed release actually is) so the Library page can show it instead of
-- guessing from the provider alone.
ALTER TABLE cached_tracks ADD COLUMN bitrate_kbps INTEGER;
ALTER TABLE cached_tracks ADD COLUMN is_lossless INTEGER NOT NULL DEFAULT 0;
