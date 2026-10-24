use argon2::password_hash::{rand_core::OsRng as PwOsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use async_trait::async_trait;
use axum::extract::{FromRequestParts, Query};
use axum::http::{header, request::Parts, StatusCode};
use rand::RngCore;
use serde::Deserialize;
use sqlx::SqlitePool;

pub fn hash_password(password: &str) -> Result<String, argon2::password_hash::Error> {
    let salt = SaltString::generate(&mut PwOsRng);
    Ok(Argon2::default().hash_password(password.as_bytes(), &salt)?.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok(),
        Err(_) => false,
    }
}

pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A user authenticated via a valid session token, extracted on routes that
/// require login. Accepts the token either as a Bearer header (normal API
/// calls) or a `?token=` query param — the query param exists because
/// `<audio src>`/`<video src>` requests can't set custom headers, the same
/// reason Subsonic-style APIs put auth in the URL for streaming.
pub struct AuthUser {
    pub id: String,
    pub username: String,
    pub is_admin: bool,
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

async fn extract_token<S: Send + Sync>(parts: &mut Parts, state: &S) -> Option<String> {
    if let Some(value) = parts.headers.get(header::AUTHORIZATION) {
        if let Ok(s) = value.to_str() {
            if let Some(token) = s.strip_prefix("Bearer ") {
                return Some(token.to_string());
            }
        }
    }
    Query::<TokenQuery>::from_request_parts(parts, state).await.ok()?.0.token
}

#[async_trait]
impl FromRequestParts<crate::AppState> for AuthUser {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, state: &crate::AppState) -> Result<Self, Self::Rejection> {
        let token = extract_token(parts, state).await.ok_or((StatusCode::UNAUTHORIZED, "missing token"))?;

        let row: (String, String, bool) = sqlx::query_as(
            "SELECT users.id, users.username, users.is_admin \
             FROM sessions JOIN users ON users.id = sessions.user_id \
             WHERE sessions.token = ?",
        )
        .bind(&token)
        .fetch_optional(&state.db)
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "db error"))?
        .ok_or((StatusCode::UNAUTHORIZED, "invalid or expired token"))?;

        Ok(AuthUser { id: row.0, username: row.1, is_admin: row.2 })
    }
}

/// Same as `AuthUser` but rejects non-admins; used for account management
/// routes (creating new users).
#[allow(dead_code)]
pub struct AdminUser(pub AuthUser);

#[async_trait]
impl FromRequestParts<crate::AppState> for AdminUser {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, state: &crate::AppState) -> Result<Self, Self::Rejection> {
        let user = AuthUser::from_request_parts(parts, state).await?;
        if !user.is_admin {
            return Err((StatusCode::FORBIDDEN, "admin only"));
        }
        Ok(AdminUser(user))
    }
}

pub async fn create_session(db: &SqlitePool, user_id: &str) -> Result<String, sqlx::Error> {
    let token = generate_token();
    sqlx::query("INSERT INTO sessions (token, user_id) VALUES (?, ?)")
        .bind(&token)
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(token)
}

/// A participant in a Weave Jam session, authenticated via a jam-scoped
/// token (`jam_members.token`) rather than a real account — this is what
/// lets guests join via QR code without creating a login. Deliberately a
/// separate extractor/table from `AuthUser`/`sessions`: a jam token only
/// ever authenticates jam routes, never `/api/me`, `/api/search`, etc.
pub struct JamMember {
    pub token: String,
    pub jam_id: String,
    pub name: String,
    pub is_host: bool,
    // The account that started this jam — needed to look up that account's
    // jam_settings (guest permissions) regardless of whether THIS member is
    // the host or a guest.
    pub host_user_id: String,
}

#[async_trait]
impl FromRequestParts<crate::AppState> for JamMember {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, state: &crate::AppState) -> Result<Self, Self::Rejection> {
        let token = extract_token(parts, state).await.ok_or((StatusCode::UNAUTHORIZED, "missing token"))?;

        let row: (String, String, bool, String) = sqlx::query_as(
            "SELECT jam_members.jam_id, jam_members.name, jam_members.is_host, jam_sessions.host_user_id \
             FROM jam_members JOIN jam_sessions ON jam_sessions.id = jam_members.jam_id \
             WHERE jam_members.token = ? AND jam_sessions.ended_at IS NULL",
        )
        .bind(&token)
        .fetch_optional(&state.db)
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "db error"))?
        .ok_or((StatusCode::UNAUTHORIZED, "invalid token or jam has ended"))?;

        Ok(JamMember { token, jam_id: row.0, name: row.1, is_host: row.2, host_user_id: row.3 })
    }
}

/// Accepts either a real account session or a jam-scoped token — used only
/// by the search route, so jam guests can find tracks to add to the queue
/// without needing a real account. Every other account action (likes,
/// playlists, settings, admin) still requires `AuthUser` specifically, so
/// this doesn't widen what a guest token can do anywhere else.
pub enum Searcher {
    Account(#[allow(dead_code)] AuthUser),
    Guest(#[allow(dead_code)] JamMember),
}

#[async_trait]
impl FromRequestParts<crate::AppState> for Searcher {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, state: &crate::AppState) -> Result<Self, Self::Rejection> {
        let token = extract_token(parts, state).await.ok_or((StatusCode::UNAUTHORIZED, "missing token"))?;

        let account_row: Option<(String, String, bool)> = sqlx::query_as(
            "SELECT users.id, users.username, users.is_admin \
             FROM sessions JOIN users ON users.id = sessions.user_id \
             WHERE sessions.token = ?",
        )
        .bind(&token)
        .fetch_optional(&state.db)
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "db error"))?;
        if let Some(row) = account_row {
            return Ok(Searcher::Account(AuthUser { id: row.0, username: row.1, is_admin: row.2 }));
        }

        let guest_row: Option<(String, String, bool, String)> = sqlx::query_as(
            "SELECT jam_members.jam_id, jam_members.name, jam_members.is_host, jam_sessions.host_user_id \
             FROM jam_members JOIN jam_sessions ON jam_sessions.id = jam_members.jam_id \
             WHERE jam_members.token = ? AND jam_sessions.ended_at IS NULL",
        )
        .bind(&token)
        .fetch_optional(&state.db)
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "db error"))?;
        if let Some(row) = guest_row {
            return Ok(Searcher::Guest(JamMember {
                token,
                jam_id: row.0,
                name: row.1,
                is_host: row.2,
                host_user_id: row.3,
            }));
        }

        Err((StatusCode::UNAUTHORIZED, "invalid or expired token"))
    }
}
