//! Generic OIDC/SSO login (Authorization Code + PKCE) — works against any
//! standards-compliant provider via discovery, which covers Authelia,
//! Authentik, and Keycloak without provider-specific code.
//!
//! Identity is anchored ONLY to `users.oidc_subject` (the IdP's `sub`
//! claim), never auto-matched by username/email: letting a login
//! auto-attach to an existing differently-created account by username/email
//! match would mean anyone who can get the IdP to assert a given
//! username/email could take over whatever local account already has it.
//! A first-time login from a given `sub` always provisions a brand-new
//! account instead.
//!
//! RS256-only for now — matches the default signing algorithm for all three
//! providers named in REQUIREMENTS.md; providers using EC/other algorithms
//! aren't supported yet.

use axum::extract::{Query, State};
use axum::http::{header::HOST, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::auth::{create_session, hash_password};
use crate::{get_setting, set_setting, AppState};

async fn config(db: &SqlitePool) -> Option<(String, String, String)> {
    let issuer = get_setting(db, "oidc_issuer").await;
    let client_id = get_setting(db, "oidc_client_id").await;
    let client_secret = get_setting(db, "oidc_client_secret").await;
    if issuer.is_empty() || client_id.is_empty() || client_secret.is_empty() {
        return None;
    }
    Some((issuer, client_id, client_secret))
}

#[derive(Serialize)]
pub struct OidcSettingsView {
    issuer: String,
    client_id: String,
    has_client_secret: bool,
}

pub async fn get_oidc_settings(
    State(state): State<AppState>,
    _admin: crate::auth::AdminUser,
) -> Json<OidcSettingsView> {
    let issuer = get_setting(&state.db, "oidc_issuer").await;
    let client_id = get_setting(&state.db, "oidc_client_id").await;
    let client_secret = get_setting(&state.db, "oidc_client_secret").await;
    Json(OidcSettingsView { issuer, client_id, has_client_secret: !client_secret.is_empty() })
}

#[derive(Deserialize)]
pub struct OidcSettingsBody {
    issuer: String,
    client_id: String,
    // Omitted/empty keeps whatever secret is already saved.
    #[serde(default)]
    client_secret: Option<String>,
}

pub async fn put_oidc_settings(
    State(state): State<AppState>,
    _admin: crate::auth::AdminUser,
    Json(body): Json<OidcSettingsBody>,
) -> Response {
    let _ = set_setting(&state.db, "oidc_issuer", &body.issuer).await;
    let _ = set_setting(&state.db, "oidc_client_id", &body.client_id).await;
    if let Some(secret) = body.client_secret.filter(|s| !s.is_empty()) {
        let _ = set_setting(&state.db, "oidc_client_secret", &secret).await;
    }
    StatusCode::NO_CONTENT.into_response()
}

pub async fn oidc_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "enabled": config(&state.db).await.is_some() }))
}

#[derive(Deserialize)]
struct Discovery {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
}

async fn fetch_discovery(http: &reqwest::Client, issuer: &str) -> Result<Discovery, ()> {
    let url = format!("{}/.well-known/openid-configuration", issuer.trim_end_matches('/'));
    http.get(&url).send().await.map_err(|_| ())?.json::<Discovery>().await.map_err(|_| ())
}

/// Must build byte-for-byte the same string the login redirect used — OIDC
/// requires the authorization and token requests send an identical
/// `redirect_uri`. Derived from the live request's Host header rather than
/// a separate admin setting, so this doesn't need re-configuring if the
/// public domain ever changes.
fn redirect_uri(headers: &HeaderMap) -> String {
    let host = headers.get(HOST).and_then(|v| v.to_str().ok()).unwrap_or("localhost");
    let scheme = if host.starts_with("localhost") || host.starts_with("127.0.0.1") { "http" } else { "https" };
    format!("{scheme}://{host}/api/auth/oidc/callback")
}

fn random_url_safe_string(len_bytes: usize) -> String {
    let mut bytes = vec![0u8; len_bytes];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

pub async fn oidc_login(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some((issuer, client_id, _)) = config(&state.db).await else {
        return (StatusCode::NOT_FOUND, "SSO is not configured").into_response();
    };
    let Ok(discovery) = fetch_discovery(&state.http, &issuer).await else {
        return (StatusCode::BAD_GATEWAY, "could not reach the SSO provider").into_response();
    };

    let verifier = random_url_safe_string(64);
    let challenge = pkce_challenge(&verifier);
    let state_param = random_url_safe_string(24);
    let nonce = random_url_safe_string(24);

    if sqlx::query("INSERT INTO oidc_requests (state, nonce, pkce_verifier) VALUES (?, ?, ?)")
        .bind(&state_param)
        .bind(&nonce)
        .bind(&verifier)
        .execute(&state.db)
        .await
        .is_err()
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not start SSO login").into_response();
    }

    let Ok(mut auth_url) = url::Url::parse(&discovery.authorization_endpoint) else {
        return (StatusCode::BAD_GATEWAY, "invalid authorization endpoint from SSO provider").into_response();
    };
    auth_url
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect_uri(&headers))
        .append_pair("scope", "openid profile email")
        .append_pair("state", &state_param)
        .append_pair("nonce", &nonce)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");

    Redirect::to(auth_url.as_str()).into_response()
}

#[derive(Deserialize)]
pub struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponseBody {
    id_token: String,
}

#[derive(Deserialize)]
struct JwkKey {
    kid: String,
    kty: String,
    #[serde(default)]
    n: Option<String>,
    #[serde(default)]
    e: Option<String>,
}

#[derive(Deserialize)]
struct Jwks {
    keys: Vec<JwkKey>,
}

#[derive(Deserialize)]
struct IdTokenClaims {
    sub: String,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    preferred_username: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

async fn unique_username(db: &SqlitePool, base: &str) -> String {
    let sanitized: String = base.chars().filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == '.').collect();
    let sanitized = if sanitized.is_empty() { "user".to_string() } else { sanitized };
    let mut candidate = sanitized.clone();
    let mut suffix = 1;
    loop {
        let taken: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM users WHERE username = ?").bind(&candidate).fetch_optional(db).await.unwrap_or(None);
        if taken.is_none() {
            return candidate;
        }
        suffix += 1;
        candidate = format!("{sanitized}{suffix}");
    }
}

pub async fn oidc_callback(State(state): State<AppState>, headers: HeaderMap, Query(params): Query<CallbackParams>) -> Response {
    if let Some(err) = params.error {
        return (StatusCode::BAD_REQUEST, format!("SSO login failed: {err}")).into_response();
    }
    let (Some(code), Some(state_param)) = (params.code, params.state) else {
        return (StatusCode::BAD_REQUEST, "missing code or state").into_response();
    };

    let request_row: Option<(String, String)> =
        sqlx::query_as("SELECT nonce, pkce_verifier FROM oidc_requests WHERE state = ?")
            .bind(&state_param)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None);
    let Some((nonce, verifier)) = request_row else {
        return (StatusCode::BAD_REQUEST, "invalid or expired login attempt").into_response();
    };
    // Consume immediately — a login attempt (and its PKCE verifier) must
    // only ever be usable once, whether this callback succeeds or not.
    let _ = sqlx::query("DELETE FROM oidc_requests WHERE state = ?").bind(&state_param).execute(&state.db).await;

    let Some((issuer, client_id, client_secret)) = config(&state.db).await else {
        return (StatusCode::NOT_FOUND, "SSO is not configured").into_response();
    };
    let Ok(discovery) = fetch_discovery(&state.http, &issuer).await else {
        return (StatusCode::BAD_GATEWAY, "could not reach the SSO provider").into_response();
    };

    let redirect = redirect_uri(&headers);
    let token_res = state
        .http
        .post(&discovery.token_endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await;
    let Ok(token_res) = token_res else {
        return (StatusCode::BAD_GATEWAY, "could not reach the SSO provider's token endpoint").into_response();
    };
    if !token_res.status().is_success() {
        return (StatusCode::BAD_GATEWAY, "the SSO provider rejected the login").into_response();
    }
    let Ok(token_body) = token_res.json::<TokenResponseBody>().await else {
        return (StatusCode::BAD_GATEWAY, "unexpected response from the SSO provider").into_response();
    };

    let Ok(jwks_res) = state.http.get(&discovery.jwks_uri).send().await else {
        return (StatusCode::BAD_GATEWAY, "could not fetch SSO signing keys").into_response();
    };
    let Ok(jwks) = jwks_res.json::<Jwks>().await else {
        return (StatusCode::BAD_GATEWAY, "unexpected signing-key response from the SSO provider").into_response();
    };

    let Ok(header) = jsonwebtoken::decode_header(&token_body.id_token) else {
        return (StatusCode::BAD_GATEWAY, "could not read SSO token header").into_response();
    };
    let Some(kid) = header.kid else {
        return (StatusCode::BAD_GATEWAY, "SSO token is missing a key id").into_response();
    };
    let Some(key) = jwks.keys.iter().find(|k| k.kid == kid && k.kty == "RSA") else {
        return (StatusCode::BAD_GATEWAY, "SSO token was signed with an unsupported key type").into_response();
    };
    let (Some(n), Some(e)) = (&key.n, &key.e) else {
        return (StatusCode::BAD_GATEWAY, "SSO signing key is missing RSA components").into_response();
    };
    let Ok(decoding_key) = jsonwebtoken::DecodingKey::from_rsa_components(n, e) else {
        return (StatusCode::BAD_GATEWAY, "could not parse SSO signing key").into_response();
    };

    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&[&client_id]);
    validation.set_issuer(&[&issuer]);
    let Ok(decoded) = jsonwebtoken::decode::<IdTokenClaims>(&token_body.id_token, &decoding_key, &validation) else {
        return (StatusCode::UNAUTHORIZED, "SSO token failed verification").into_response();
    };
    let claims = decoded.claims;
    if claims.nonce.as_deref() != Some(nonce.as_str()) {
        return (StatusCode::UNAUTHORIZED, "SSO token nonce mismatch").into_response();
    }

    let existing_user_id: Option<String> =
        sqlx::query_scalar("SELECT id FROM users WHERE oidc_subject = ?").bind(&claims.sub).fetch_optional(&state.db).await.unwrap_or(None);

    let user_id = match existing_user_id {
        Some(id) => id,
        None => {
            let base_username = claims
                .preferred_username
                .or(claims.name)
                .or(claims.email.map(|e| e.split('@').next().unwrap_or("user").to_string()))
                .unwrap_or_else(|| "user".to_string());
            let username = unique_username(&state.db, &base_username).await;
            let id = Uuid::new_v4().to_string();
            // No local password for an SSO-provisioned account — hash a
            // random value so the NOT NULL constraint is satisfied without
            // this being a usable (or guessable) password for anyone.
            let Ok(unusable_hash) = hash_password(&Uuid::new_v4().to_string()) else {
                return (StatusCode::INTERNAL_SERVER_ERROR, "could not provision account").into_response();
            };
            if sqlx::query("INSERT INTO users (id, username, password_hash, is_admin, oidc_subject) VALUES (?, ?, ?, 0, ?)")
                .bind(&id)
                .bind(&username)
                .bind(&unusable_hash)
                .bind(&claims.sub)
                .execute(&state.db)
                .await
                .is_err()
            {
                return (StatusCode::INTERNAL_SERVER_ERROR, "could not provision account").into_response();
            }
            id
        }
    };

    match create_session(&state.db, &user_id).await {
        Ok(token) => Redirect::to(&format!("/?token={token}")).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not create session").into_response(),
    }
}
