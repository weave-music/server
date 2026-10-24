-- Per-account: automatically end a jam after this many minutes with no
-- activity (0 = never). Lives in jam_settings alongside the guest
-- permissions since it's the same "things the jam creator controls,
-- persisted per account" concept.
ALTER TABLE jam_settings ADD COLUMN inactivity_timeout_minutes INTEGER NOT NULL DEFAULT 60;

-- Last time anything happened in a jam (join, queue add, remote command,
-- or an is_playing=true heartbeat) — compared against the setting above by
-- a periodic sweep to auto-end idle jams. No default expression here since
-- SQLite's ALTER TABLE ADD COLUMN rejects non-constant defaults like
-- datetime('now'); existing rows are backfilled from created_at instead,
-- and every INSERT from here on sets it explicitly.
ALTER TABLE jam_sessions ADD COLUMN last_active_at TEXT;
UPDATE jam_sessions SET last_active_at = created_at WHERE last_active_at IS NULL;
