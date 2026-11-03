//! Last.fm scrobbling: a global admin-configured API key/secret, and each
//! user links their own Last.fm account once (Last.fm's "desktop
//! application authentication" flow — redirect out, user approves, redirect
//! back with a one-time token, exchanged server-side for a session key).
//!
//! The callback is a plain backend route (like `oidc_callback`), not
//! something the frontend interprets: Last.fm always appends `token=...`
//! to whatever `cb` URL we give it, which would collide with the existing
//! `/?token=...` convention `useAuth.ts` already uses for OIDC login. A
//! `state` param (same shape as `oidc_requests`, but keyed to an
//! already-authenticated user rather than a login nonce) avoids that by
//! keeping the whole exchange server-side.

use axum::extract::{Query, State};
use axum::http::{header::HOST, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::auth::{AdminUser, AuthUser};
use crate::{get_setting, set_setting, AppState};

const API_BASE: &str = "https://ws.audioscrobbler.com/2.0/";

async fn config(db: &SqlitePool) -> Option<(String, String)> {
    let api_key = get_setting(db, "lastfm_api_key").await;
    let api_secret = get_setting(db, "lastfm_api_secret").await;
    if api_key.is_empty() || api_secret.is_empty() {
        return None;
    }
    Some((api_key, api_secret))
}

/// Last.fm's request-signing scheme: every param (excluding `format`)
/// sorted by key, concatenated as `key``value` with no separators, secret
/// appended, then MD5-hex-digested.
fn sign_params(params: &[(&str, &str)], secret: &str) -> String {
    let mut sorted: Vec<&(&str, &str)> = params.iter().collect();
    sorted.sort_by_key(|(k, _)| *k);
    let mut buf = String::new();
    for (k, v) in sorted {
        buf.push_str(k);
        buf.push_str(v);
    }
    buf.push_str(secret);
    format!("{:x}", md5::compute(buf))
}

fn redirect_base(headers: &HeaderMap) -> String {
    let host = headers.get(HOST).and_then(|v| v.to_str().ok()).unwrap_or("localhost");
    let scheme = if host.starts_with("localhost") || host.starts_with("127.0.0.1") { "http" } else { "https" };
    format!("{scheme}://{host}")
}

#[derive(Serialize)]
pub struct LastfmSettingsView {
    api_key: String,
    has_api_secret: bool,
}

pub async fn get_lastfm_settings(State(state): State<AppState>, _admin: AdminUser) -> Json<LastfmSettingsView> {
    let api_key = get_setting(&state.db, "lastfm_api_key").await;
    let api_secret = get_setting(&state.db, "lastfm_api_secret").await;
    Json(LastfmSettingsView { api_key, has_api_secret: !api_secret.is_empty() })
}

#[derive(Deserialize)]
pub struct LastfmSettingsBody {
    api_key: String,
    #[serde(default)]
    api_secret: Option<String>,
}

pub async fn put_lastfm_settings(State(state): State<AppState>, _admin: AdminUser, Json(body): Json<LastfmSettingsBody>) -> Response {
    let _ = set_setting(&state.db, "lastfm_api_key", &body.api_key).await;
    if let Some(secret) = body.api_secret.filter(|s| !s.is_empty()) {
        let _ = set_setting(&state.db, "lastfm_api_secret", &secret).await;
    }
    StatusCode::NO_CONTENT.into_response()
}

pub async fn lastfm_status(State(state): State<AppState>, _user: AuthUser) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "enabled": config(&state.db).await.is_some() }))
}

#[derive(Serialize)]
pub struct LastfmLinkStatus {
    linked: bool,
    username: Option<String>,
}

pub async fn lastfm_link_status(State(state): State<AppState>, user: AuthUser) -> Json<LastfmLinkStatus> {
    let row: Option<(String,)> = sqlx::query_as("SELECT lastfm_username FROM user_lastfm WHERE user_id = ?")
        .bind(&user.id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    match row {
        Some((username,)) => Json(LastfmLinkStatus { linked: true, username: Some(username) }),
        None => Json(LastfmLinkStatus { linked: false, username: None }),
    }
}

pub async fn lastfm_unlink(State(state): State<AppState>, user: AuthUser) -> Response {
    let _ = sqlx::query("DELETE FROM user_lastfm WHERE user_id = ?").bind(&user.id).execute(&state.db).await;
    StatusCode::NO_CONTENT.into_response()
}

pub async fn lastfm_auth_url(State(state): State<AppState>, user: AuthUser, headers: HeaderMap) -> Response {
    let Some((api_key, _)) = config(&state.db).await else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Last.fm is not configured").into_response();
    };
    let state_param = Uuid::new_v4().to_string();
    if sqlx::query("INSERT INTO lastfm_requests (state, user_id) VALUES (?, ?)")
        .bind(&state_param)
        .bind(&user.id)
        .execute(&state.db)
        .await
        .is_err()
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not start Last.fm link").into_response();
    }
    let cb = format!("{}/api/lastfm/callback?state={state_param}", redirect_base(&headers));
    let url = format!("https://www.last.fm/api/auth/?api_key={api_key}&cb={}", urlencoding_encode(&cb));
    Json(serde_json::json!({ "url": url })).into_response()
}

// Last.fm's `cb` param needs URL-encoding and this crate doesn't otherwise
// depend on a general-purpose percent-encoding crate — `url::Url`'s query
// pair setter already does exactly this, so reuse it instead of hand-rolling.
fn urlencoding_encode(value: &str) -> String {
    let mut url = url::Url::parse("https://example.invalid/").unwrap();
    url.query_pairs_mut().append_pair("v", value);
    // query_pairs_mut produces "v=<encoded>" — strip the "v=" prefix.
    url.query().unwrap_or_default().trim_start_matches("v=").to_string()
}

#[derive(Deserialize)]
pub struct LastfmCallbackParams {
    state: Option<String>,
    token: Option<String>,
}

pub async fn lastfm_callback(State(state): State<AppState>, Query(params): Query<LastfmCallbackParams>) -> Response {
    let (Some(state_param), Some(token)) = (params.state, params.token) else {
        return (StatusCode::BAD_REQUEST, "missing state or token").into_response();
    };
    let request_row: Option<(String,)> =
        sqlx::query_as("SELECT user_id FROM lastfm_requests WHERE state = ?").bind(&state_param).fetch_optional(&state.db).await.unwrap_or(None);
    let Some((user_id,)) = request_row else {
        return (StatusCode::BAD_REQUEST, "invalid or expired Last.fm link attempt").into_response();
    };
    let _ = sqlx::query("DELETE FROM lastfm_requests WHERE state = ?").bind(&state_param).execute(&state.db).await;

    let Some((api_key, api_secret)) = config(&state.db).await else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Last.fm is not configured").into_response();
    };
    let sig = sign_params(&[("api_key", api_key.as_str()), ("method", "auth.getSession"), ("token", token.as_str())], &api_secret);
    let res = state
        .http
        .get(API_BASE)
        .query(&[
            ("method", "auth.getSession"),
            ("api_key", api_key.as_str()),
            ("token", token.as_str()),
            ("api_sig", sig.as_str()),
            ("format", "json"),
        ])
        .send()
        .await;
    let Ok(res) = res else {
        return (StatusCode::BAD_GATEWAY, "could not reach Last.fm").into_response();
    };
    if !res.status().is_success() {
        return (StatusCode::BAD_GATEWAY, "Last.fm rejected the link request").into_response();
    }
    let Ok(body) = res.json::<serde_json::Value>().await else {
        return (StatusCode::BAD_GATEWAY, "unexpected response from Last.fm").into_response();
    };
    let session_key = body.get("session").and_then(|s| s.get("key")).and_then(|v| v.as_str());
    let lastfm_username = body.get("session").and_then(|s| s.get("name")).and_then(|v| v.as_str());
    let (Some(session_key), Some(lastfm_username)) = (session_key, lastfm_username) else {
        return (StatusCode::BAD_GATEWAY, "unexpected response from Last.fm").into_response();
    };

    let _ = sqlx::query(
        "INSERT INTO user_lastfm (user_id, session_key, lastfm_username, linked_at) VALUES (?, ?, ?, datetime('now')) \
         ON CONFLICT (user_id) DO UPDATE SET session_key = excluded.session_key, lastfm_username = excluded.lastfm_username, linked_at = excluded.linked_at",
    )
    .bind(&user_id)
    .bind(session_key)
    .bind(lastfm_username)
    .execute(&state.db)
    .await;

    Redirect::to("/").into_response()
}

/// Fire-and-forget: scrobbles a play if the user has linked Last.fm and the
/// server has Last.fm configured. Not fatal either way — same spirit as
/// `maybe_upgrade_via_lidarr`.
pub async fn scrobble(db: SqlitePool, http: reqwest::Client, user_id: String, title: String, artist_name: Option<String>, album_name: Option<String>) {
    let Some(artist) = artist_name.filter(|a| !a.trim().is_empty()) else { return };
    let Some((api_key, api_secret)) = config(&db).await else { return };
    let session_key: Option<(String,)> =
        sqlx::query_as("SELECT session_key FROM user_lastfm WHERE user_id = ?").bind(&user_id).fetch_optional(&db).await.ok().flatten();
    let Some((session_key,)) = session_key else { return };

    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0).to_string();
    let mut params: Vec<(&str, &str)> = vec![
        ("method", "track.scrobble"),
        ("api_key", api_key.as_str()),
        ("sk", session_key.as_str()),
        ("artist", artist.as_str()),
        ("track", title.as_str()),
        ("timestamp", timestamp.as_str()),
    ];
    if let Some(album) = album_name.as_deref().filter(|a| !a.trim().is_empty()) {
        params.push(("album", album));
    }
    let sig = sign_params(&params, &api_secret);

    let mut form: Vec<(&str, &str)> = params;
    form.push(("api_sig", sig.as_str()));
    form.push(("format", "json"));

    if let Err(err) = http.post(API_BASE).form(&form).send().await {
        tracing::warn!(%err, "last.fm scrobble failed");
    }
}
