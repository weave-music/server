-- Per-account defaults for what guests (joined via QR/link, not the
-- account's own devices) are allowed to do in any jam this account starts.
-- Keyed by user_id (not jam_id) so a choice persists across jams — the
-- account's own devices are never restricted by this, only guests.
CREATE TABLE jam_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    guests_can_add_queue INTEGER NOT NULL DEFAULT 1,
    guests_can_control_playback INTEGER NOT NULL DEFAULT 0,
    guests_can_shuffle_repeat INTEGER NOT NULL DEFAULT 0
);
