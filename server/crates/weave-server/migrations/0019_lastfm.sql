-- Last.fm scrobbling: global API key/secret (admin-set via
-- /api/admin/lastfm-settings), each user links their own account once.
INSERT INTO settings (key, value) VALUES ('lastfm_api_key', '');
INSERT INTO settings (key, value) VALUES ('lastfm_api_secret', '');

CREATE TABLE user_lastfm (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    session_key TEXT NOT NULL,
    lastfm_username TEXT NOT NULL,
    linked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Short-lived state for an in-flight "Connect Last.fm" attempt — same
-- shape/purpose as oidc_requests, but keyed to an already-authenticated
-- user (this is account linking, not login) rather than a login nonce.
-- Needed because Last.fm's own callback redirect carries no way to attach
-- our app's Bearer token, only whatever query params we put in `cb`.
CREATE TABLE lastfm_requests (
    state TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
