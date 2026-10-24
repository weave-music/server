-- Lidarr integration config (admin-set via /api/admin/lidarr-settings).
INSERT INTO settings (key, value) VALUES ('lidarr_url', '');
INSERT INTO settings (key, value) VALUES ('lidarr_api_key', '');
INSERT INTO settings (key, value) VALUES ('lidarr_root_folder', '');
INSERT INTO settings (key, value) VALUES ('lidarr_quality_profile_id', '');

-- OIDC/SSO config (admin-set via /api/admin/oidc-settings).
INSERT INTO settings (key, value) VALUES ('oidc_issuer', '');
INSERT INTO settings (key, value) VALUES ('oidc_client_id', '');
INSERT INTO settings (key, value) VALUES ('oidc_client_secret', '');

-- Links a local account to an OIDC identity provider's subject claim —
-- nullable so built-in accounts are untouched; uniqueness enforced via the
-- index below instead of an inline UNIQUE constraint, since SQLite's
-- ALTER TABLE ADD COLUMN rejects UNIQUE on the new column directly.
ALTER TABLE users ADD COLUMN oidc_subject TEXT;
CREATE UNIQUE INDEX idx_users_oidc_subject ON users(oidc_subject) WHERE oidc_subject IS NOT NULL;

-- Short-lived state for an in-flight OIDC login (authorization code flow +
-- PKCE) — a row per browser that clicked "Log in with SSO", deleted once
-- the callback consumes it. A DB table (not an in-memory map) survives a
-- server restart mid-flow and needs no extra locking since sqlx serializes
-- access to the single sqlite connection pool already.
CREATE TABLE oidc_requests (
    state TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    pkce_verifier TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
