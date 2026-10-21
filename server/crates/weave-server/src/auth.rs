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
