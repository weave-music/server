//! Integration with a self-hosted Lidarr instance for "can't find it? request
//! it" — NOT a `MediaProvider`: Lidarr has no playable tracks of its own
//! (it just tells its own download clients/indexers what to fetch), so it
//! doesn't fit search/resolve/stream at all. This is deliberately a thin,
//! separate set of routes that proxy Lidarr's own REST API, gated by
//! whichever admin-configured URL/API key is on file.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::auth::{AdminUser, AuthUser};
use crate::{get_setting, set_setting, AppState};

pub struct LidarrConfig {
    pub url: String,
    pub api_key: String,
    pub root_folder: String,
    pub quality_profile_id: i64,
}

/// `None` unless every field has actually been set — half-configured
/// Lidarr settings should behave exactly like "not configured" everywhere
/// that checks this, rather than firing off requests with an empty API key.
pub async fn load_config(db: &SqlitePool) -> Option<LidarrConfig> {
    let url = get_setting(db, "lidarr_url").await;
    let api_key = get_setting(db, "lidarr_api_key").await;
    let root_folder = get_setting(db, "lidarr_root_folder").await;
    let quality_profile_id = get_setting(db, "lidarr_quality_profile_id").await;
    if url.is_empty() || api_key.is_empty() || root_folder.is_empty() || quality_profile_id.is_empty() {
        return None;
    }
    Some(LidarrConfig { url, api_key, root_folder, quality_profile_id: quality_profile_id.parse().ok()? })
}

#[derive(Serialize)]
pub struct LidarrSettingsView {
    url: String,
    has_api_key: bool,
    root_folder: String,
    quality_profile_id: Option<i64>,
}

pub async fn get_lidarr_settings(State(state): State<AppState>, _admin: AdminUser) -> Json<LidarrSettingsView> {
    let url = get_setting(&state.db, "lidarr_url").await;
    let api_key = get_setting(&state.db, "lidarr_api_key").await;
    let root_folder = get_setting(&state.db, "lidarr_root_folder").await;
    let quality_profile_id = get_setting(&state.db, "lidarr_quality_profile_id").await.parse().ok();
    Json(LidarrSettingsView { url, has_api_key: !api_key.is_empty(), root_folder, quality_profile_id })
}

#[derive(Deserialize)]
pub struct LidarrSettingsBody {
    url: String,
    // Omitted/empty keeps whatever API key is already saved, so the admin
    // UI never has to re-display (or the admin re-enter) the secret just to
    // change the URL or root folder.
    #[serde(default)]
    api_key: Option<String>,
    root_folder: String,
    quality_profile_id: Option<i64>,
}

pub async fn put_lidarr_settings(
    State(state): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<LidarrSettingsBody>,
) -> Response {
    let _ = set_setting(&state.db, "lidarr_url", &body.url).await;
    if let Some(key) = body.api_key.filter(|k| !k.is_empty()) {
        let _ = set_setting(&state.db, "lidarr_api_key", &key).await;
    }
    let _ = set_setting(&state.db, "lidarr_root_folder", &body.root_folder).await;
    let qp = body.quality_profile_id.map(|v| v.to_string()).unwrap_or_default();
    let _ = set_setting(&state.db, "lidarr_quality_profile_id", &qp).await;
    StatusCode::NO_CONTENT.into_response()
}

/// Populates the admin UI's root-folder/quality-profile pickers — reads
/// whatever URL/API key are already SAVED (not whatever's mid-edit in the
/// form), so the admin has to save those two fields once before the
/// dropdowns can populate.
async fn proxy_lidarr_get(state: &AppState, path: &str) -> Response {
    let url = get_setting(&state.db, "lidarr_url").await;
    let api_key = get_setting(&state.db, "lidarr_api_key").await;
    if url.is_empty() || api_key.is_empty() {
        return (StatusCode::BAD_REQUEST, "set the Lidarr URL and API key first").into_response();
    }
    match state.http.get(format!("{}{path}", url.trim_end_matches('/'))).header("X-Api-Key", &api_key).send().await {
        Ok(res) if res.status().is_success() => match res.json::<serde_json::Value>().await {
            Ok(body) => Json(body).into_response(),
            Err(_) => (StatusCode::BAD_GATEWAY, "unexpected response from Lidarr").into_response(),
        },
        _ => (StatusCode::BAD_GATEWAY, "could not reach Lidarr").into_response(),
    }
}

pub async fn lidarr_root_folders(State(state): State<AppState>, _admin: AdminUser) -> Response {
    proxy_lidarr_get(&state, "/api/v1/rootfolder").await
}

pub async fn lidarr_quality_profiles(State(state): State<AppState>, _admin: AdminUser) -> Response {
    proxy_lidarr_get(&state, "/api/v1/qualityprofile").await
}

pub async fn lidarr_status(State(state): State<AppState>, _user: AuthUser) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "enabled": load_config(&state.db).await.is_some() }))
}

#[derive(Deserialize)]
pub struct LidarrSearchParams {
    q: String,
}

/// Any logged-in user can search/request — the server acts with its own
/// admin-configured Lidarr credentials, so this doesn't need the caller to
/// be an admin themselves (same shape as e.g. a Jellyseerr request button).
pub async fn lidarr_search(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<LidarrSearchParams>,
) -> Response {
    let Some(cfg) = load_config(&state.db).await else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Lidarr is not configured").into_response();
    };
    let url = format!("{}/api/v1/artist/lookup", cfg.url.trim_end_matches('/'));
    match state.http.get(&url).header("X-Api-Key", &cfg.api_key).query(&[("term", &params.q)]).send().await {
        Ok(res) if res.status().is_success() => match res.json::<serde_json::Value>().await {
            Ok(body) => Json(body).into_response(),
            Err(_) => (StatusCode::BAD_GATEWAY, "unexpected response from Lidarr").into_response(),
        },
        _ => (StatusCode::BAD_GATEWAY, "could not reach Lidarr").into_response(),
    }
}

#[derive(Deserialize)]
pub struct LidarrRequestBody {
    foreign_artist_id: String,
    artist_name: String,
}

pub async fn lidarr_request_artist(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(body): Json<LidarrRequestBody>,
) -> Response {
    let Some(cfg) = load_config(&state.db).await else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Lidarr is not configured").into_response();
    };
    let payload = serde_json::json!({
        "artistName": body.artist_name,
        "foreignArtistId": body.foreign_artist_id,
        "qualityProfileId": cfg.quality_profile_id,
        "rootFolderPath": cfg.root_folder,
        "monitored": true,
        // Lidarr kicks off the actual download search itself once the
        // artist is added with this set — no separate /api/v1/command call.
        "addOptions": { "monitor": "all", "searchForMissingAlbums": true },
    });
    let res = state
        .http
        .post(format!("{}/api/v1/artist", cfg.url.trim_end_matches('/')))
        .header("X-Api-Key", &cfg.api_key)
        .json(&payload)
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => StatusCode::NO_CONTENT.into_response(),
        Ok(r) => {
            let status = r.status();
            let text = r.text().await.unwrap_or_default();
            tracing::warn!("lidarr artist add failed: {status} {text}");
            (StatusCode::BAD_GATEWAY, "Lidarr rejected the request").into_response()
        }
        Err(_) => (StatusCode::BAD_GATEWAY, "could not reach Lidarr").into_response(),
    }
}
