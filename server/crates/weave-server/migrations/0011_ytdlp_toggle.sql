-- Lets an admin turn off the YouTube Music (yt-dlp) provider's search,
-- discovery, and genre-browsing surfaces account-wide — e.g. for a
-- local-library-only deployment. Defaults to 'true' so existing deployments
-- keep today's behavior. Already-added tracks/playlists sourced from
-- YouTube Music still resolve/stream when this is off — this only stops
-- new YouTube content from being surfaced, it doesn't retroactively break
-- anything already in a queue, playlist, or likes list.
INSERT INTO settings (key, value) VALUES ('ytdlp_enabled', 'true');
