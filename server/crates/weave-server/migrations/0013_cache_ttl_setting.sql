-- How long YtDlpProvider's response cache (migrations/0012) keeps a result
-- before treating it as stale, in hours. '0' disables caching entirely —
-- every call always goes straight to YouTube. Defaults to 6 to match the
-- value that was previously hardcoded.
INSERT INTO settings (key, value) VALUES ('provider_cache_ttl_hours', '6');
