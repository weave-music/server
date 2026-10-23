-- Marks the one jam_members row that actually created the jam (as opposed
-- to a later device resuming it) — the device that should always stay the
-- real audio source, with every other host-role device acting as a remote.
ALTER TABLE jam_members ADD COLUMN is_source INTEGER NOT NULL DEFAULT 0;
