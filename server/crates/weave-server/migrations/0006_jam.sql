-- "Weave Jam": a host-started collaborative listening session. Guests join
-- via a short code/QR link and get a jam-scoped token (jam_members) rather
-- than a real account — that token only ever authenticates jam routes.
CREATE TABLE jam_sessions (
    id TEXT PRIMARY KEY,
    host_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
);

CREATE TABLE jam_members (
    token TEXT PRIMARY KEY,
    jam_id TEXT NOT NULL REFERENCES jam_sessions(id),
    name TEXT NOT NULL,
    is_host INTEGER NOT NULL DEFAULT 0,
    joined_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only log of who added what — doubles as the recommendation seed
-- (most recently added track) and the dedupe list for recommendations.
CREATE TABLE jam_queue_log (
    id TEXT PRIMARY KEY,
    jam_id TEXT NOT NULL REFERENCES jam_sessions(id),
    track_json TEXT NOT NULL,
    added_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_jam_queue_log_jam ON jam_queue_log(jam_id, created_at);
