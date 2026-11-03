mod auth;
mod lastfm;
mod lidarr;
mod musicbrainz;
mod oidc;

use std::collections::{HashMap, HashSet};
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use auth::{create_session, generate_token, hash_password, verify_password, AdminUser, AuthUser, JamMember, Searcher};
use axum::{
    body::Body,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{Path, Query, Request, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
    routing::{delete, get, post},
    Json, Router,
};
use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;
use tokio::sync::broadcast;
use tower::ServiceExt;
use tower_http::services::ServeFile;
use uuid::Uuid;
use weave_core::{MediaProvider, SearchQuery, Track, TrackSource};
use weave_provider_local::LocalFilesystemProvider;
use weave_provider_ytdlp::YtDlpProvider;

#[derive(Clone)]
struct AppState {
    providers: Vec<Arc<dyn MediaProvider>>,
    db: SqlitePool,
    cache_dir: PathBuf,
    /// Fans out playback updates (track/position/play-state) to every other
    /// device the same account has connected via `/api/playback/ws`, so
    /// starting a song on one device can pause/sync it on the rest in real
    /// time — a single process-wide channel filtered by user id per
    /// connection, since a self-hosted install doesn't need per-user channels.
    playback_tx: broadcast::Sender<PlaybackEvent>,
    /// Same fan-out pattern as `playback_tx`, filtered by jam id instead of
    /// user id, for Weave Jam's live queue/now-playing updates.
    jam_tx: broadcast::Sender<JamEvent>,
    /// Ephemeral "what's actually playing right now" mirror per active jam,
    /// pushed by the host's client. Not persisted — a jam only means
    /// anything while the host's browser (which owns the real queue) is
    /// open, so there's nothing worth surviving a server restart for.
    jam_live: Arc<Mutex<HashMap<String, JamLive>>>,
    /// Shared, reused for every outbound call this server makes to another
    /// HTTP service (Lidarr, an OIDC provider's discovery/token/JWKS
    /// endpoints) — a fresh `reqwest::Client` per request would rebuild
    /// its connection pool and TLS config every time for no benefit.
    http: reqwest::Client,
    /// Gates outbound MusicBrainz lookups (`musicbrainz.rs`) to roughly one
    /// request/second, per their anonymous-client API policy.
    mb_last_call: Arc<Mutex<Instant>>,
}

/// Generic `settings` key/value store (see migrations/0002_settings.sql) —
/// shared by the registration toggle, Lidarr config, and OIDC config.
/// Every key this reads from must already have a row (seeded by a
/// migration), since this returns `""` rather than erroring on a missing
/// key — callers treat an empty string as "not configured".
pub(crate) async fn get_setting(db: &SqlitePool, key: &str) -> String {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
}

pub(crate) async fn set_setting(db: &SqlitePool, key: &str, value: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE settings SET value = ? WHERE key = ?").bind(value).bind(key).execute(db).await?;
    Ok(())
}

impl AppState {
    fn provider(&self, id: &str) -> Option<&Arc<dyn MediaProvider>> {
        self.providers.iter().find(|p| p.id() == id)
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let db_path = std::env::var("WEAVE_DB_PATH").unwrap_or_else(|_| "/config/weave.db".to_string());
    // WAL mode lets readers (the overwhelming majority of queries) proceed
    // without waiting on whatever write is in flight — cache inserts on
    // every uncached search, likes, playback-state updates, jam queue/log
    // writes — instead of the default rollback-journal mode where they'd
    // all serialize behind a single exclusive lock.
    let connect_options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal);
    let db = SqlitePoolOptions::new()
        .max_connections(16)
        .connect_with(connect_options)
        .await
        .unwrap_or_else(|e| panic!("failed to open database at {db_path}: {e}"));
    sqlx::migrate!().run(&db).await.expect("database migrations failed");

    let music_dir = std::env::var("WEAVE_LIBRARY_PATH").unwrap_or_else(|_| "/music".to_string());
    let local_provider = Arc::new(LocalFilesystemProvider::new("local", music_dir));
    let ytdlp_provider = Arc::new(YtDlpProvider::new("ytdlp", db.clone()));

    let cache_dir = PathBuf::from(std::env::var("WEAVE_CACHE_PATH").unwrap_or_else(|_| "/config/cache".to_string()));
    std::fs::create_dir_all(&cache_dir).expect("failed to create cache directory");

    let (playback_tx, _) = broadcast::channel(32);
    let (jam_tx, _) = broadcast::channel(32);
    let jam_live: Arc<Mutex<HashMap<String, JamLive>>> = Arc::new(Mutex::new(HashMap::new()));
    let state = AppState {
        providers: vec![local_provider, ytdlp_provider],
        db,
        cache_dir,
        playback_tx,
        jam_tx,
        jam_live,
        http: reqwest::Client::new(),
        mb_last_call: Arc::new(Mutex::new(Instant::now() - std::time::Duration::from_secs(2))),
    };

    {
        let sweep_state = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                interval.tick().await;
                sweep_inactive_jams(&sweep_state).await;
            }
        });
    }

    {
        let sweep_state = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
            loop {
                interval.tick().await;
                sweep_track_upgrades(&sweep_state).await;
            }
        });
    }

    let app = Router::new()
        .route("/health", get(health))
        .route("/rest/ping.view", get(subsonic_ping))
        .route("/api/auth/setup", get(setup_status).post(setup))
        .route("/api/auth/login", post(login))
        .route("/api/auth/register", post(register))
        .route("/api/auth/oidc/status", get(oidc::oidc_status))
        .route("/api/auth/oidc/login", get(oidc::oidc_login))
        .route("/api/auth/oidc/callback", get(oidc::oidc_callback))
        .route("/api/admin/oidc-settings", get(oidc::get_oidc_settings).put(oidc::put_oidc_settings))
        .route("/api/admin/lidarr-settings", get(lidarr::get_lidarr_settings).put(lidarr::put_lidarr_settings))
        .route("/api/admin/lidarr/root-folders", get(lidarr::lidarr_root_folders))
        .route("/api/admin/lidarr/quality-profiles", get(lidarr::lidarr_quality_profiles))
        .route("/api/lidarr/status", get(lidarr::lidarr_status))
        .route("/api/lidarr/search", get(lidarr::lidarr_search))
        .route("/api/lidarr/request", post(lidarr::lidarr_request_artist))
        .route("/api/admin/lastfm-settings", get(lastfm::get_lastfm_settings).put(lastfm::put_lastfm_settings))
        .route("/api/lastfm/status", get(lastfm::lastfm_status))
        .route("/api/lastfm/link-status", get(lastfm::lastfm_link_status))
        .route("/api/lastfm/auth-url", get(lastfm::lastfm_auth_url))
        .route("/api/lastfm/callback", get(lastfm::lastfm_callback))
        .route("/api/lastfm/unlink", post(lastfm::lastfm_unlink))
        .route("/api/settings/registration", get(get_registration_setting).put(set_registration_setting))
        .route("/api/settings/ytdlp", get(get_ytdlp_setting).put(set_ytdlp_setting))
        .route("/api/settings/cache", get(get_cache_setting).put(set_cache_setting))
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/:id", delete(delete_user))
        .route("/api/me", get(me))
        .route("/api/search", get(search))
        .route("/api/search/playlists", get(search_playlists))
        .route("/api/featured", get(featured))
        .route("/api/library/local", get(library_local))
        .route("/api/radio", get(radio))
        .route("/api/lyrics", get(lyrics))
        .route("/api/artist", get(artist_tracks))
        .route("/api/artist/releases", get(artist_releases))
        .route("/api/album", get(album_tracks))
        .route("/api/playlist", get(playlist_tracks))
        .route("/api/likes", get(list_likes).post(like_track).delete(unlike_track))
        .route("/api/plays", post(record_play))
        .route("/api/stats", get(get_stats))
        .route("/api/playlists", get(list_playlists).post(create_playlist))
        .route("/api/playlists/mine", get(list_my_playlists))
        .route("/api/playlists/:id", get(get_playlist).delete(delete_playlist))
        .route("/api/playlists/:id/tracks", post(add_playlist_track))
        .route("/api/playlists/:id/tracks/:track_id", delete(remove_playlist_track))
        .route("/api/stream", get(stream))
        .route("/api/playback", get(get_playback).post(update_playback))
        .route("/api/playback/ws", get(playback_ws))
        .route("/api/jam-settings", get(get_jam_settings).put(update_jam_settings))
        .route("/api/jam", post(create_jam))
        .route("/api/jam/mine", get(my_active_jam))
        .route("/api/jam/:id/join", post(join_jam))
        .route("/api/jam/:id/state", get(jam_state))
        .route("/api/jam/:id/queue", post(add_jam_queue))
        .route("/api/jam/:id/playback", post(jam_playback))
        .route("/api/jam/:id/command", post(jam_command))
        .route("/api/jam/:id/end", post(end_jam))
        .route("/api/jam/:id/recommendations", get(jam_recommendations))
        .route("/api/jam/:id/ws", get(jam_ws))
        .with_state(state);

    let addr = "0.0.0.0:4533";
    tracing::info!("weave-server listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health() -> &'static str {
    "ok"
}

/// Smallest possible Subsonic-API-compatible response, so existing
/// Subsonic clients can confirm connectivity against this server.
#[derive(Serialize)]
struct SubsonicResponse {
    #[serde(rename = "subsonic-response")]
    subsonic_response: SubsonicPing,
}

#[derive(Serialize)]
struct SubsonicPing {
    status: &'static str,
    version: &'static str,
}

async fn subsonic_ping() -> Json<SubsonicResponse> {
    Json(SubsonicResponse {
        subsonic_response: SubsonicPing { status: "ok", version: "1.16.1" },
    })
}

#[derive(Deserialize)]
struct Credentials {
    username: String,
    password: String,
}

#[derive(Serialize)]
struct TokenResponse {
    token: String,
}

async fn user_count(db: &SqlitePool) -> i64 {
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users").fetch_one(db).await.unwrap();
    count.0
}

#[derive(Serialize)]
struct SetupStatus {
    setup_complete: bool,
}

/// Public (unauthenticated) — lets the login page know whether to offer
/// "first time? set up the admin account" at all, instead of always
/// showing it and relying on the 409 from POST to tell the user it's moot.
async fn setup_status(State(state): State<AppState>) -> Json<SetupStatus> {
    Json(SetupStatus { setup_complete: user_count(&state.db).await > 0 })
}

/// First-run setup: only works while the users table is empty, and the
/// account it creates is always an admin. Mirrors the setup-wizard pattern
/// used by Jellyfin/Immich rather than allowing open self-registration on a
/// self-hosted box with no invite system yet.
async fn setup(State(state): State<AppState>, Json(creds): Json<Credentials>) -> Response {
    if user_count(&state.db).await > 0 {
        return (StatusCode::CONFLICT, "setup already completed").into_response();
    }

    let Ok(hash) = hash_password(&creds.password) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not hash password").into_response();
    };
    let user_id = Uuid::new_v4().to_string();
    if sqlx::query("INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 1)")
        .bind(&user_id)
        .bind(&creds.username)
        .bind(&hash)
        .execute(&state.db)
        .await
        .is_err()
    {
        return (StatusCode::BAD_REQUEST, "could not create user").into_response();
    }

    match create_session(&state.db, &user_id).await {
        Ok(token) => Json(TokenResponse { token }).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not create session").into_response(),
    }
}

async fn login(State(state): State<AppState>, Json(creds): Json<Credentials>) -> Response {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT id, password_hash FROM users WHERE username = ?")
            .bind(&creds.username)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None);

    let Some((user_id, password_hash)) = row else {
        return (StatusCode::UNAUTHORIZED, "invalid username or password").into_response();
    };
    if !verify_password(&creds.password, &password_hash) {
        return (StatusCode::UNAUTHORIZED, "invalid username or password").into_response();
    }

    match create_session(&state.db, &user_id).await {
        Ok(token) => Json(TokenResponse { token }).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not create session").into_response(),
    }
}

async fn registration_allowed(db: &SqlitePool) -> bool {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'allow_registration'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .as_deref()
        == Some("true")
}

#[derive(Serialize, Deserialize)]
struct RegistrationSetting {
    allow_registration: bool,
}

async fn get_registration_setting(State(state): State<AppState>) -> Json<RegistrationSetting> {
    Json(RegistrationSetting { allow_registration: registration_allowed(&state.db).await })
}

async fn set_registration_setting(
    State(state): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<RegistrationSetting>,
) -> Response {
    let value = if body.allow_registration { "true" } else { "false" };
    match sqlx::query("UPDATE settings SET value = ? WHERE key = 'allow_registration'")
        .bind(value)
        .execute(&state.db)
        .await
    {
        Ok(_) => Json(body).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not update setting").into_response(),
    }
}

/// Admin-controlled kill switch for the YouTube Music (yt-dlp) provider's
/// search/discovery/genre-browsing surfaces (see migrations/0011). Checked
/// by every handler below that proactively surfaces new YouTube content;
/// deliberately NOT checked by `stream`/`resolve` or by per-item browse
/// continuations (artist/album/playlist tracks) — a track, album, or
/// playlist already referenced from a queue/playlist/likes list still
/// works, this only stops new YouTube content from being surfaced.
async fn ytdlp_search_enabled(db: &SqlitePool) -> bool {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'ytdlp_enabled'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .as_deref()
        != Some("false")
}

#[derive(Serialize, Deserialize)]
struct YtdlpSetting {
    ytdlp_enabled: bool,
}

async fn get_ytdlp_setting(State(state): State<AppState>, _user: AuthUser) -> Json<YtdlpSetting> {
    Json(YtdlpSetting { ytdlp_enabled: ytdlp_search_enabled(&state.db).await })
}

async fn set_ytdlp_setting(
    State(state): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<YtdlpSetting>,
) -> Response {
    let value = if body.ytdlp_enabled { "true" } else { "false" };
    match sqlx::query("UPDATE settings SET value = ? WHERE key = 'ytdlp_enabled'")
        .bind(value)
        .execute(&state.db)
        .await
    {
        Ok(_) => Json(body).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not update setting").into_response(),
    }
}

/// How long YtDlpProvider caches a response for, in hours (0 = disabled —
/// see migrations/0013). Read directly by the provider itself via the same
/// `settings` table; this struct/route pair is just the admin-facing view
/// onto that one value.
#[derive(Serialize, Deserialize)]
struct CacheSetting {
    cache_ttl_hours: i64,
}

async fn get_cache_setting(State(state): State<AppState>, _user: AuthUser) -> Json<CacheSetting> {
    let hours = get_setting(&state.db, "provider_cache_ttl_hours").await.parse().unwrap_or(6);
    Json(CacheSetting { cache_ttl_hours: hours })
}

async fn set_cache_setting(
    State(state): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<CacheSetting>,
) -> Response {
    // -1 is the sentinel for "never expire" (see weave-provider-ytdlp's
    // cache_ttl()); any other negative value collapses to that same
    // sentinel rather than silently clamping to 0 ("disabled"), which is a
    // very different meaning.
    let hours = if body.cache_ttl_hours < 0 { -1 } else { body.cache_ttl_hours };
    match set_setting(&state.db, "provider_cache_ttl_hours", &hours.to_string()).await {
        Ok(_) => Json(CacheSetting { cache_ttl_hours: hours }).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not update setting").into_response(),
    }
}

/// Public self-registration, gated behind the admin-controlled toggle above.
/// Always creates a non-admin account — promoting someone to admin is a
/// separate, admin-only action via `POST /api/users`.
async fn register(State(state): State<AppState>, Json(creds): Json<Credentials>) -> Response {
    if !registration_allowed(&state.db).await {
        return (StatusCode::FORBIDDEN, "registration is disabled").into_response();
    }

    let Ok(hash) = hash_password(&creds.password) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not hash password").into_response();
    };
    let user_id = Uuid::new_v4().to_string();
    if sqlx::query("INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 0)")
        .bind(&user_id)
        .bind(&creds.username)
        .bind(&hash)
        .execute(&state.db)
        .await
        .is_err()
    {
        return (StatusCode::BAD_REQUEST, "username already taken").into_response();
    }

    match create_session(&state.db, &user_id).await {
        Ok(token) => Json(TokenResponse { token }).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not create session").into_response(),
    }
}

#[derive(Deserialize)]
struct NewUser {
    username: String,
    password: String,
    #[serde(default)]
    is_admin: bool,
}

#[derive(Serialize, sqlx::FromRow)]
struct UserInfo {
    id: String,
    username: String,
    is_admin: bool,
    created_at: String,
    liked_count: i64,
}

async fn create_user(State(state): State<AppState>, _admin: AdminUser, Json(new_user): Json<NewUser>) -> Response {
    let Ok(hash) = hash_password(&new_user.password) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not hash password").into_response();
    };
    let user_id = Uuid::new_v4().to_string();
    if sqlx::query("INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)")
        .bind(&user_id)
        .bind(&new_user.username)
        .bind(&hash)
        .bind(new_user.is_admin)
        .execute(&state.db)
        .await
        .is_err()
    {
        return (StatusCode::BAD_REQUEST, "username already taken").into_response();
    }

    match sqlx::query_as::<_, UserInfo>("SELECT id, username, is_admin, created_at FROM users WHERE id = ?")
        .bind(&user_id)
        .fetch_one(&state.db)
        .await
    {
        Ok(user) => (StatusCode::CREATED, Json(user)).into_response(),
        Err(_) => StatusCode::CREATED.into_response(),
    }
}

async fn list_users(State(state): State<AppState>, _admin: AdminUser) -> Response {
    match sqlx::query_as::<_, UserInfo>(
        "SELECT u.id, u.username, u.is_admin, u.created_at, COALESCE(l.cnt, 0) AS liked_count \
         FROM users u \
         LEFT JOIN (SELECT user_id, COUNT(*) AS cnt FROM liked_tracks GROUP BY user_id) l ON l.user_id = u.id \
         ORDER BY u.created_at",
    )
    .fetch_all(&state.db)
    .await
    {
        Ok(users) => Json(users).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not list users").into_response(),
    }
}

async fn delete_user(State(state): State<AppState>, admin: AdminUser, Path(id): Path<String>) -> Response {
    if id == admin.0.id {
        return (StatusCode::BAD_REQUEST, "cannot delete your own account").into_response();
    }
    match sqlx::query("DELETE FROM users WHERE id = ?").bind(&id).execute(&state.db).await {
        Ok(result) if result.rows_affected() > 0 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not delete user").into_response(),
    }
}

#[derive(Serialize)]
struct MeResponse {
    id: String,
    username: String,
    is_admin: bool,
}

async fn me(user: AuthUser) -> Json<MeResponse> {
    Json(MeResponse { id: user.id, username: user.username, is_admin: user.is_admin })
}

#[derive(Deserialize)]
struct SearchParams {
    q: String,
}

async fn search(
    State(state): State<AppState>,
    _user: Searcher,
    Query(params): Query<SearchParams>,
) -> Json<serde_json::Value> {
    let query = SearchQuery { text: params.q, limit: 25 };
    let ytdlp_enabled = ytdlp_search_enabled(&state.db).await;

    // Unified search across every configured provider (REQUIREMENTS.md §6),
    // fanned out concurrently so latency is the slowest provider's, not the
    // sum of all of them.
    let calls = state.providers.iter().filter(|p| p.id() != "ytdlp" || ytdlp_enabled).map(|provider| {
        let query = &query;
        async move { (provider.id(), provider.search(query).await) }
    });
    let mut results = Vec::new();
    for (provider_id, result) in futures::future::join_all(calls).await {
        match result {
            Ok(tracks) => results.extend(tracks),
            Err(err) => tracing::warn!(provider = provider_id, %err, "provider search failed"),
        }
    }

    Json(serde_json::json!({ "results": results }))
}

/// Playlists matching a search term, across every provider that has a real
/// playlist concept (today: yt-dlp, via YouTube Music — see
/// `MediaProvider::search_playlists`). Kept separate from `search` (which
/// only ever returns tracks) rather than folded into its response, so
/// every existing `search` caller is unaffected and a track-only search
/// doesn't pay for a playlist lookup it doesn't want.
async fn search_playlists(
    State(state): State<AppState>,
    _user: Searcher,
    Query(params): Query<SearchParams>,
) -> Json<serde_json::Value> {
    let query = SearchQuery { text: params.q, limit: 15 };
    let ytdlp_enabled = ytdlp_search_enabled(&state.db).await;

    let calls = state.providers.iter().filter(|p| p.id() != "ytdlp" || ytdlp_enabled).map(|provider| {
        let query = &query;
        async move { (provider.id(), provider.search_playlists(query).await) }
    });
    let mut results = Vec::new();
    for (provider_id, result) in futures::future::join_all(calls).await {
        match result {
            Ok(playlists) => results.extend(playlists),
            Err(err) => tracing::warn!(provider = provider_id, %err, "provider search_playlists failed"),
        }
    }

    Json(serde_json::json!({ "playlists": results }))
}

/// "Featured" tracks: a shuffled sample pulled live from every provider's
/// `browse()`. There's no listening history or taste profile yet (see
/// REQUIREMENTS.md §13), so this is honestly just randomized discovery, not
/// personalized recommendations — framed that way in the UI too.
async fn featured(State(state): State<AppState>, _user: AuthUser) -> Json<serde_json::Value> {
    let ytdlp_enabled = ytdlp_search_enabled(&state.db).await;
    let calls = state
        .providers
        .iter()
        .filter(|p| p.id() != "ytdlp" || ytdlp_enabled)
        .map(|provider| async move { (provider.id(), provider.browse(8).await) });
    let mut results = Vec::new();
    for (provider_id, result) in futures::future::join_all(calls).await {
        match result {
            Ok(tracks) => results.extend(tracks),
            Err(err) => tracing::warn!(provider = provider_id, %err, "provider browse failed"),
        }
    }
    results.shuffle(&mut rand::thread_rng());
    Json(serde_json::json!({ "results": results }))
}

#[derive(Deserialize)]
struct LibraryLocalParams {
    limit: Option<usize>,
}

/// A shuffled sample of the local filesystem provider's tracks, for the
/// Library page's "Your Music Library" section. Reuses the same
/// `browse()` the local provider already implements for `/api/featured`
/// — no grouping by artist/album, since the provider derives tracks from
/// filename/folder only (see weave-provider-local's own doc comment) and
/// doesn't have a notion of artists/albums to group by yet.
async fn library_local(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<LibraryLocalParams>,
) -> Response {
    let Some(provider) = state.provider("local") else {
        return Json(serde_json::json!({ "results": [] })).into_response();
    };
    match provider.browse(params.limit.unwrap_or(60)).await {
        Ok(tracks) => Json(serde_json::json!({ "results": tracks })).into_response(),
        Err(err) => {
            tracing::warn!(%err, "local library browse failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "could not browse local library").into_response()
        }
    }
}

#[derive(Deserialize)]
struct RadioParams {
    provider: String,
    #[serde(rename = "ref")]
    source_ref: String,
}

/// A "radio" queue seeded off one track, via whatever continuation
/// mechanism its owning provider supports (e.g. YouTube's own mix
/// playlists for the yt-dlp provider).
async fn radio(State(state): State<AppState>, _user: AuthUser, Query(params): Query<RadioParams>) -> Response {
    let Some(provider) = state.provider(&params.provider) else {
        return (StatusCode::NOT_FOUND, "unknown provider").into_response();
    };
    match provider.radio(&params.source_ref, 20).await {
        Ok(results) => Json(serde_json::json!({ "results": results })).into_response(),
        Err(err) => {
            tracing::warn!(provider = params.provider, %err, "radio failed");
            (StatusCode::NOT_FOUND, "could not build radio queue").into_response()
        }
    }
}

#[derive(Deserialize)]
struct LyricsParams {
    provider: String,
    #[serde(rename = "ref")]
    source_ref: String,
}

/// Lyrics for one track, when the provider has a lookup for it (see
/// `MediaProvider::lyrics`). No lyrics found is a normal result (common —
/// instrumentals, local files), not an error, so this always returns 200
/// with `{"lyrics": null}` rather than a 404.
async fn lyrics(State(state): State<AppState>, _user: AuthUser, Query(params): Query<LyricsParams>) -> Response {
    let Some(provider) = state.provider(&params.provider) else {
        return Json(serde_json::json!({ "lyrics": null })).into_response();
    };
    match provider.lyrics(&params.source_ref).await {
        Ok(lyrics) => Json(serde_json::json!({ "lyrics": lyrics })).into_response(),
        Err(err) => {
            tracing::warn!(provider = params.provider, %err, "lyrics lookup failed");
            Json(serde_json::json!({ "lyrics": null })).into_response()
        }
    }
}

#[derive(Deserialize)]
struct ArtistAlbumParams {
    provider: String,
    #[serde(rename = "ref")]
    item_ref: String,
}

/// More tracks from one artist (see `MediaProvider::artist_tracks` — the
/// yt-dlp provider backs this with YouTube Music's real "top songs", with a
/// channel-videos fallback; local files have no artist concept).
async fn artist_tracks(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<ArtistAlbumParams>,
) -> Response {
    let Some(provider) = state.provider(&params.provider) else {
        return (StatusCode::NOT_FOUND, "unknown provider").into_response();
    };
    match provider.artist_tracks(&params.item_ref, 50).await {
        Ok(results) => Json(serde_json::json!({ "results": results })).into_response(),
        Err(err) => {
            tracing::warn!(provider = params.provider, %err, "artist_tracks failed");
            (StatusCode::NOT_FOUND, "could not load artist").into_response()
        }
    }
}

/// An album's tracks (see `MediaProvider::album_tracks` — yt-dlp via
/// YouTube Music, local files via the containing folder).
async fn album_tracks(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<ArtistAlbumParams>,
) -> Response {
    let Some(provider) = state.provider(&params.provider) else {
        return (StatusCode::NOT_FOUND, "unknown provider").into_response();
    };
    match provider.album_tracks(&params.item_ref, 200).await {
        Ok(results) => Json(serde_json::json!({ "results": results })).into_response(),
        Err(err) => {
            tracing::warn!(provider = params.provider, %err, "album_tracks failed");
            (StatusCode::NOT_FOUND, "could not load album").into_response()
        }
    }
}

/// A playlist's tracks (see `MediaProvider::playlist_tracks` — yt-dlp via
/// YouTube Music; `item_ref` is the playlistId a `/api/search/playlists`
/// result came back with).
async fn playlist_tracks(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<ArtistAlbumParams>,
) -> Response {
    let Some(provider) = state.provider(&params.provider) else {
        return (StatusCode::NOT_FOUND, "unknown provider").into_response();
    };
    match provider.playlist_tracks(&params.item_ref, 300).await {
        Ok(results) => Json(serde_json::json!({ "results": results })).into_response(),
        Err(err) => {
            tracing::warn!(provider = params.provider, %err, "playlist_tracks failed");
            (StatusCode::NOT_FOUND, "could not load playlist").into_response()
        }
    }
}

/// An artist's Albums/Singles catalog (see `MediaProvider::artist_releases`
/// — yt-dlp only, via YouTube Music; empty for providers without one).
async fn artist_releases(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<ArtistAlbumParams>,
) -> Response {
    let Some(provider) = state.provider(&params.provider) else {
        return (StatusCode::NOT_FOUND, "unknown provider").into_response();
    };
    match provider.artist_releases(&params.item_ref).await {
        Ok(profile) => {
            Json(serde_json::json!({ "releases": profile.releases, "artwork_url": profile.artwork_url }))
                .into_response()
        }
        Err(err) => {
            tracing::warn!(provider = params.provider, %err, "artist_releases failed");
            (StatusCode::NOT_FOUND, "could not load releases").into_response()
        }
    }
}

#[derive(Deserialize)]
struct StreamParams {
    provider: String,
    #[serde(rename = "ref")]
    source_ref: String,
}

/// Looks up a previously-downloaded copy of a track in the `cached_tracks`
/// table. A hit here lets `stream` skip the provider entirely and serve the
/// local file instead of streaming/redirecting.
async fn cached_path(db: &SqlitePool, provider_id: &str, source_ref: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT file_path FROM cached_tracks WHERE provider_id = ? AND source_ref = ?",
    )
    .bind(provider_id)
    .bind(source_ref)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
}

/// `source_ref`s are opaque provider identifiers (e.g. YouTube video ids)
/// that are already filesystem-safe in practice, but we strip anything odd
/// defensively since they end up directly in a path on disk.
fn safe_cache_stem(provider_id: &str, source_ref: &str) -> String {
    let safe_ref: String = source_ref
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    format!("{provider_id}_{safe_ref}")
}

/// Probes a downloaded/cached audio file's actual bitrate and whether its
/// codec is lossless, via ffprobe (already present alongside yt-dlp's
/// ffmpeg dependency). yt-dlp's "bestaudio" pick varies in bitrate per
/// video, and a Lidarr-sourced file's quality is whatever the grabbed
/// release actually is — neither is knowable without asking the file
/// itself. `None` on any failure; quality display is a nice-to-have, not
/// something worth failing a download/upgrade over.
async fn probe_quality(path: &FsPath) -> Option<(Option<i64>, bool)> {
    let output = tokio::process::Command::new("ffprobe")
        .args(["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let data: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let bitrate_kbps = data
        .get("format")
        .and_then(|f| f.get("bit_rate"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<i64>().ok())
        .map(|bps| bps / 1000);
    let is_lossless = data
        .get("streams")
        .and_then(|s| s.as_array())
        .and_then(|streams| streams.iter().find(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("audio")))
        .and_then(|s| s.get("codec_name"))
        .and_then(|v| v.as_str())
        .map(|codec| matches!(codec, "flac" | "alac") || codec.starts_with("pcm_"))
        .unwrap_or(false);
    Some((bitrate_kbps, is_lossless))
}

/// Shells out to yt-dlp to pull down a liked track's audio so future plays
/// can be served from disk instead of re-streaming from the provider. Fire-
/// and-forget: runs on a spawned task kicked off from `like_track`, so a like
/// always succeeds immediately even if the download is slow or fails.
async fn download_track_in_background(
    db: SqlitePool,
    cache_dir: PathBuf,
    provider_id: String,
    source_ref: String,
) {
    // Local files are already on disk; only the ytdlp provider needs caching.
    if provider_id != "ytdlp" {
        return;
    }
    if cached_path(&db, &provider_id, &source_ref).await.is_some() {
        return;
    }

    let stem = safe_cache_stem(&provider_id, &source_ref);
    let output_template = cache_dir.join(format!("{stem}.%(ext)s"));
    let dest = cache_dir.join(format!("{stem}.opus"));
    let url = format!("https://www.youtube.com/watch?v={source_ref}");

    let output = tokio::process::Command::new("yt-dlp")
        .args([
            "-f",
            "bestaudio",
            "--extract-audio",
            "--audio-format",
            "opus",
            "--no-warnings",
            "-o",
            &output_template.to_string_lossy(),
            &url,
        ])
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() && dest.exists() => {
            let (bitrate_kbps, is_lossless) = probe_quality(&dest).await.unwrap_or((None, false));
            let insert = sqlx::query(
                "INSERT OR REPLACE INTO cached_tracks (provider_id, source_ref, file_path, bitrate_kbps, is_lossless) \
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&provider_id)
            .bind(&source_ref)
            .bind(dest.to_string_lossy().as_ref())
            .bind(bitrate_kbps)
            .bind(is_lossless)
            .execute(&db)
            .await;
            if let Err(err) = insert {
                tracing::warn!(provider_id, source_ref, %err, "failed to record cached track");
            } else {
                tracing::info!(provider_id, source_ref, ?bitrate_kbps, "cached track downloaded");
            }
        }
        Ok(out) => tracing::warn!(
            provider_id,
            source_ref,
            stderr = %String::from_utf8_lossy(&out.stderr),
            "background download failed"
        ),
        Err(err) => tracing::warn!(provider_id, source_ref, %err, "background download spawn failed"),
    }
}

/// Resolves a track source through its owning provider, then either serves
/// the file directly (local, with Range support for seeking) or redirects
/// the player at a remote stream URL. This is the seam where downloaded and
/// streamed audio become interchangeable to the client (REQUIREMENTS.md §7).
/// A liked track that has finished downloading (see `download_track_in_background`)
/// is served straight from the cache, bypassing the provider entirely.
async fn stream(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<StreamParams>,
    req: Request,
) -> Response {
    if let Some(cached) = cached_path(&state.db, &params.provider, &params.source_ref).await {
        if FsPath::new(&cached).exists() {
            return match ServeFile::new(cached).oneshot(req).await {
                Ok(res) => res.map(Body::new).into_response(),
                Err(err) => match err {},
            };
        }
    }

    let Some(provider) = state.provider(&params.provider) else {
        return (StatusCode::NOT_FOUND, "unknown provider").into_response();
    };

    match provider.resolve(&params.source_ref).await {
        Ok(target) if target.starts_with("http://") || target.starts_with("https://") => {
            Redirect::temporary(&target).into_response()
        }
        Ok(path) => match ServeFile::new(path).oneshot(req).await {
            Ok(res) => res.map(Body::new).into_response(),
            Err(err) => match err {},
        },
        Err(err) => {
            tracing::warn!(provider = params.provider, %err, "resolve failed");
            (StatusCode::NOT_FOUND, "could not resolve track").into_response()
        }
    }
}

/// Likes are per-account, not per-browser (unlike playlists/history, which
/// are still a client-side-only stopgap) — a track's `sources[0]` is its
/// stable identity here, since `Track::id` is a fresh random uuid on every
/// search/fetch.
async fn like_track(State(state): State<AppState>, user: AuthUser, Json(track): Json<Track>) -> Response {
    let Some(source) = track.sources.first() else {
        return (StatusCode::BAD_REQUEST, "track has no source").into_response();
    };
    let result = sqlx::query(
        "INSERT INTO liked_tracks (user_id, provider_id, source_ref, title, artist_name, album_name, artwork_url, duration_secs) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (user_id, provider_id, source_ref) DO NOTHING",
    )
    .bind(&user.id)
    .bind(&source.provider_id)
    .bind(&source.source_ref)
    .bind(&track.title)
    .bind(&track.artist_name)
    .bind(&track.album_name)
    .bind(&track.artwork_url)
    .bind(track.duration_secs.map(|d| d as i64))
    .execute(&state.db)
    .await;

    match result {
        Ok(_) => {
            tokio::spawn(download_track_in_background(
                state.db.clone(),
                state.cache_dir.clone(),
                source.provider_id.clone(),
                source.source_ref.clone(),
            ));
            tokio::spawn(maybe_upgrade_via_lidarr(
                state.db.clone(),
                state.http.clone(),
                state.mb_last_call.clone(),
                source.provider_id.clone(),
                source.source_ref.clone(),
                track.title.clone(),
                track.artist_name.clone(),
                track.album_name.clone(),
            ));
            StatusCode::NO_CONTENT.into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not like track").into_response(),
    }
}

async fn upsert_track_upgrade(
    db: &SqlitePool,
    provider_id: &str,
    source_ref: &str,
    status: &str,
    lidarr_artist_id: Option<i64>,
    lidarr_album_id: Option<i64>,
) {
    let _ = sqlx::query(
        "INSERT INTO track_upgrades (provider_id, source_ref, status, lidarr_artist_id, lidarr_album_id, updated_at) \
         VALUES (?, ?, ?, ?, ?, datetime('now')) \
         ON CONFLICT (provider_id, source_ref) DO UPDATE SET \
         status = excluded.status, lidarr_artist_id = excluded.lidarr_artist_id, \
         lidarr_album_id = excluded.lidarr_album_id, updated_at = excluded.updated_at",
    )
    .bind(provider_id)
    .bind(source_ref)
    .bind(status)
    .bind(lidarr_artist_id)
    .bind(lidarr_album_id)
    .execute(db)
    .await;
}

fn normalize_title(title: &str) -> String {
    title.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Fire-and-forget companion to `download_track_in_background`: if Lidarr
/// is configured, finds the liked track's matching album in Lidarr (adding
/// the artist first if needed) and requests just that one album — not the
/// whole discography — rather than relying on the user to notice and use
/// the existing manual "Request artist" search flow.
async fn maybe_upgrade_via_lidarr(
    db: SqlitePool,
    http: reqwest::Client,
    mb_last_call: Arc<Mutex<Instant>>,
    provider_id: String,
    source_ref: String,
    title: String,
    artist_name: Option<String>,
    album_name: Option<String>,
) {
    // Already-local tracks don't need upgrading, and Lidarr requests are
    // artist/album-shaped — nothing sensible to look up without an artist.
    if provider_id != "ytdlp" {
        return;
    }
    let Some(artist) = artist_name.filter(|a| !a.trim().is_empty()) else { return };
    let Some(cfg) = lidarr::load_config(&db).await else { return };

    let mb = musicbrainz::lookup_recording(&db, &http, &mb_last_call, &artist, &title).await;
    let release_group_mbid = mb.as_ref().and_then(|r| r.release_group_mbid.clone());
    let Some(album_title) = mb.as_ref().and_then(|r| r.canonical_album.clone()).or(album_name) else {
        upsert_track_upgrade(&db, &provider_id, &source_ref, "no_match", None, None).await;
        return;
    };

    let Some(found) = lidarr::lookup_artist(&http, &cfg, &artist).await else {
        upsert_track_upgrade(&db, &provider_id, &source_ref, "no_match", None, None).await;
        return;
    };
    let existing_id = found.get("id").and_then(|v| v.as_i64()).filter(|&id| id != 0);
    let lidarr_artist_id = match existing_id {
        Some(id) => id,
        None => {
            let foreign_artist_id = found.get("foreignArtistId").and_then(|v| v.as_str()).unwrap_or_default();
            let artist_name = found.get("artistName").and_then(|v| v.as_str()).unwrap_or(&artist);
            if foreign_artist_id.is_empty() {
                upsert_track_upgrade(&db, &provider_id, &source_ref, "no_match", None, None).await;
                return;
            }
            match lidarr::add_artist_targeted(&http, &cfg, foreign_artist_id, artist_name).await {
                Some(created) => match created.get("id").and_then(|v| v.as_i64()) {
                    Some(id) => id,
                    None => {
                        upsert_track_upgrade(&db, &provider_id, &source_ref, "no_match", None, None).await;
                        return;
                    }
                },
                None => {
                    upsert_track_upgrade(&db, &provider_id, &source_ref, "no_match", None, None).await;
                    return;
                }
            }
        }
    };

    // A freshly-added artist may not have its album catalog synced from
    // MusicBrainz yet — retry with backoff before giving up.
    let mut albums = Vec::new();
    for attempt in 0..5u32 {
        albums = lidarr::artist_albums(&http, &cfg, lidarr_artist_id).await;
        if !albums.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(3 * (attempt as u64 + 1))).await;
    }

    let normalized_target = normalize_title(&album_title);
    let matched = release_group_mbid
        .as_deref()
        .and_then(|rg| albums.iter().find(|a| a.get("foreignAlbumId").and_then(|v| v.as_str()) == Some(rg)))
        .or_else(|| {
            albums
                .iter()
                .find(|a| a.get("title").and_then(|v| v.as_str()).map(normalize_title).as_deref() == Some(normalized_target.as_str()))
        });

    let Some(album) = matched else {
        upsert_track_upgrade(&db, &provider_id, &source_ref, "no_match", Some(lidarr_artist_id), None).await;
        return;
    };
    let Some(album_id) = album.get("id").and_then(|v| v.as_i64()) else {
        upsert_track_upgrade(&db, &provider_id, &source_ref, "no_match", Some(lidarr_artist_id), None).await;
        return;
    };

    if lidarr::set_album_monitored(&http, &cfg, album.clone()).await.is_err() {
        upsert_track_upgrade(&db, &provider_id, &source_ref, "no_match", Some(lidarr_artist_id), Some(album_id)).await;
        return;
    }
    let _ = lidarr::trigger_album_search(&http, &cfg, album_id).await;
    upsert_track_upgrade(&db, &provider_id, &source_ref, "requested", Some(lidarr_artist_id), Some(album_id)).await;
}

/// Periodic check for `track_upgrades` rows still `'requested'`: once
/// Lidarr's own download lands in the local library, this detects it (via
/// the local provider's existing `search()`, fuzzy-matched by title — no
/// MBID-exact matching yet since the local provider doesn't read tags) and
/// swaps `cached_tracks` to point at the local file. `stream()` already
/// checks `cached_tracks` first, so no change there is needed — the swap
/// to serving the better file is automatic.
async fn sweep_track_upgrades(state: &AppState) {
    let Some(local) = state.provider("local").cloned() else { return };
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT provider_id, source_ref FROM track_upgrades WHERE status = 'requested'")
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();

    for (provider_id, source_ref) in rows {
        let meta: Option<(String, Option<String>)> =
            sqlx::query_as("SELECT title, artist_name FROM liked_tracks WHERE provider_id = ? AND source_ref = ? LIMIT 1")
                .bind(&provider_id)
                .bind(&source_ref)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten();
        let Some((title, artist_name)) = meta else { continue };
        let query_text = match &artist_name {
            Some(a) => format!("{a} {title}"),
            None => title.clone(),
        };
        let Ok(results) = local.search(&SearchQuery { text: query_text, limit: 5 }).await else { continue };
        let normalized_title = normalize_title(&title);
        let Some(matched) = results.iter().find(|t| normalize_title(&t.title) == normalized_title) else { continue };
        let Some(source) = matched.sources.first() else { continue };

        let (bitrate_kbps, is_lossless) = probe_quality(FsPath::new(&source.source_ref)).await.unwrap_or((None, false));
        let _ = sqlx::query(
            "INSERT OR REPLACE INTO cached_tracks (provider_id, source_ref, file_path, bitrate_kbps, is_lossless) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&provider_id)
        .bind(&source_ref)
        .bind(&source.source_ref)
        .bind(bitrate_kbps)
        .bind(is_lossless)
        .execute(&state.db)
        .await;
        let _ = sqlx::query("UPDATE track_upgrades SET status = 'upgraded', updated_at = datetime('now') WHERE provider_id = ? AND source_ref = ?")
            .bind(&provider_id)
            .bind(&source_ref)
            .execute(&state.db)
            .await;
    }
}

#[derive(Deserialize)]
struct LikeParams {
    provider: String,
    #[serde(rename = "ref")]
    source_ref: String,
}

async fn unlike_track(State(state): State<AppState>, user: AuthUser, Query(params): Query<LikeParams>) -> Response {
    match sqlx::query("DELETE FROM liked_tracks WHERE user_id = ? AND provider_id = ? AND source_ref = ?")
        .bind(&user.id)
        .bind(&params.provider)
        .bind(&params.source_ref)
        .execute(&state.db)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not unlike track").into_response(),
    }
}

#[derive(sqlx::FromRow)]
struct LikedRow {
    provider_id: String,
    source_ref: String,
    title: String,
    artist_name: Option<String>,
    album_name: Option<String>,
    artwork_url: Option<String>,
    duration_secs: Option<i64>,
    download_status: Option<String>,
    cached: bool,
    bitrate_kbps: Option<i64>,
    is_lossless: bool,
}

/// "streaming" (served live from the provider, nothing local yet),
/// "downloaded" (yt-dlp's own background download landed), "upgrading"
/// (Lidarr album request in flight), or "upgraded" (Lidarr's download
/// landed and `stream()` is now serving that file instead) — this is a
/// read model over `cached_tracks`/`track_upgrades`, not a stored value.
fn download_status(cached: bool, download_status: Option<&str>) -> &'static str {
    match download_status {
        Some("upgraded") => "upgraded",
        Some("requested") => "upgrading",
        _ if cached => "downloaded",
        _ => "streaming",
    }
}

async fn list_likes(State(state): State<AppState>, user: AuthUser) -> Response {
    let rows: Result<Vec<LikedRow>, _> = sqlx::query_as(
        "SELECT l.provider_id, l.source_ref, l.title, l.artist_name, l.album_name, l.artwork_url, l.duration_secs, \
                u.status AS download_status, \
                (c.file_path IS NOT NULL) AS cached, c.bitrate_kbps, COALESCE(c.is_lossless, 0) AS is_lossless \
         FROM liked_tracks l \
         LEFT JOIN track_upgrades u ON u.provider_id = l.provider_id AND u.source_ref = l.source_ref \
         LEFT JOIN cached_tracks c ON c.provider_id = l.provider_id AND c.source_ref = l.source_ref \
         WHERE l.user_id = ? ORDER BY l.liked_at DESC",
    )
    .bind(&user.id)
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(rows) => {
            let tracks: Vec<Track> = rows
                .into_iter()
                .map(|r| {
                    let status = download_status(r.cached, r.download_status.as_deref());
                    Track {
                        id: Uuid::new_v4(),
                        title: r.title,
                        duration_secs: r.duration_secs.map(|d| d as u32),
                        track_number: None,
                        sources: vec![TrackSource {
                            is_local: r.cached || r.provider_id == "local",
                            provider_id: r.provider_id,
                            source_ref: r.source_ref,
                            bitrate_kbps: r.bitrate_kbps.map(|b| b as u32),
                            is_lossless: r.is_lossless,
                        }],
                        artwork_url: r.artwork_url,
                        artist_name: r.artist_name,
                        artist_ref: None,
                        album_name: r.album_name,
                        album_ref: None,
                        download_status: Some(status.to_string()),
                    }
                })
                .collect();
            Json(serde_json::json!({ "results": tracks })).into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not list likes").into_response(),
    }
}

/// One row per play — an event log, not an upsert-counter, so "top
/// artists/tracks" can be computed by grouping/counting rather than
/// needing separate increment logic, and it supports future time-ranged
/// questions ("plays this week") for free. Fire-and-forget from the
/// client whenever the current track changes (see `recordServerPlay` in
/// App.tsx) — same spirit as the client-local `useListeningHistory`,
/// which this doesn't replace (Discover's "Your artists" row still reads
/// from that).
async fn record_play(State(state): State<AppState>, user: AuthUser, Json(track): Json<Track>) -> Response {
    let Some(source) = track.sources.first() else {
        return (StatusCode::BAD_REQUEST, "track has no source").into_response();
    };
    let result = sqlx::query(
        "INSERT INTO play_history (id, user_id, provider_id, source_ref, title, artist_name, album_name, artwork_url) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&user.id)
    .bind(&source.provider_id)
    .bind(&source.source_ref)
    .bind(&track.title)
    .bind(&track.artist_name)
    .bind(&track.album_name)
    .bind(&track.artwork_url)
    .execute(&state.db)
    .await;

    match result {
        Ok(_) => {
            tokio::spawn(lastfm::scrobble(
                state.db.clone(),
                state.http.clone(),
                user.id.clone(),
                track.title.clone(),
                track.artist_name.clone(),
                track.album_name.clone(),
            ));
            StatusCode::NO_CONTENT.into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not record play").into_response(),
    }
}

#[derive(Serialize, sqlx::FromRow)]
struct TopArtist {
    artist_name: String,
    play_count: i64,
}

#[derive(sqlx::FromRow)]
struct TopTrackRow {
    provider_id: String,
    source_ref: String,
    title: String,
    artist_name: Option<String>,
    album_name: Option<String>,
    artwork_url: Option<String>,
    play_count: i64,
}

#[derive(Serialize)]
struct TopTrack {
    track: Track,
    play_count: i64,
}

async fn get_stats(State(state): State<AppState>, user: AuthUser) -> Response {
    let top_artists: Result<Vec<TopArtist>, _> = sqlx::query_as(
        "SELECT artist_name, COUNT(*) AS play_count FROM play_history \
         WHERE user_id = ? AND artist_name IS NOT NULL \
         GROUP BY artist_name ORDER BY play_count DESC LIMIT 10",
    )
    .bind(&user.id)
    .fetch_all(&state.db)
    .await;

    let top_tracks: Result<Vec<TopTrackRow>, _> = sqlx::query_as(
        "SELECT provider_id, source_ref, title, artist_name, album_name, artwork_url, COUNT(*) AS play_count \
         FROM play_history WHERE user_id = ? \
         GROUP BY provider_id, source_ref ORDER BY play_count DESC LIMIT 10",
    )
    .bind(&user.id)
    .fetch_all(&state.db)
    .await;

    let total_plays: Result<i64, _> = sqlx::query_scalar("SELECT COUNT(*) FROM play_history WHERE user_id = ?")
        .bind(&user.id)
        .fetch_one(&state.db)
        .await;

    match (top_artists, top_tracks, total_plays) {
        (Ok(top_artists), Ok(top_tracks), Ok(total_plays)) => {
            let top_tracks: Vec<TopTrack> = top_tracks
                .into_iter()
                .map(|r| TopTrack {
                    play_count: r.play_count,
                    track: Track {
                        id: Uuid::new_v4(),
                        title: r.title,
                        duration_secs: None,
                        track_number: None,
                        sources: vec![TrackSource {
                            is_local: r.provider_id == "local",
                            provider_id: r.provider_id,
                            source_ref: r.source_ref,
                            bitrate_kbps: None,
                            is_lossless: false,
                        }],
                        artwork_url: r.artwork_url,
                        artist_name: r.artist_name,
                        artist_ref: None,
                        album_name: r.album_name,
                        album_ref: None,
                        download_status: None,
                    },
                })
                .collect();
            Json(serde_json::json!({
                "top_artists": top_artists,
                "top_tracks": top_tracks,
                "total_plays": total_plays,
            }))
            .into_response()
        }
        _ => (StatusCode::INTERNAL_SERVER_ERROR, "could not load stats").into_response(),
    }
}

/// User-created playlists (distinct from `/api/playlist`, which browses an
/// external provider's own playlists). Every playlist on the server is
/// visible to every logged-in user — there's no private/public flag, by
/// design (self-hosted, trusted household) — but only the owner can modify
/// or delete one. `playlist_owner_id` backs that check in the three
/// mutating routes below.
async fn playlist_owner_id(db: &SqlitePool, playlist_id: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT owner_id FROM playlists WHERE id = ?")
        .bind(playlist_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
}

#[derive(Deserialize)]
struct CreatePlaylistBody {
    name: String,
}

#[derive(Serialize, sqlx::FromRow)]
struct UserPlaylistSummary {
    id: String,
    name: String,
    owner_id: String,
    owner_username: String,
    track_count: i64,
}

async fn create_playlist(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreatePlaylistBody>,
) -> Response {
    let id = Uuid::new_v4().to_string();
    match sqlx::query("INSERT INTO playlists (id, owner_id, name) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(&user.id)
        .bind(&body.name)
        .execute(&state.db)
        .await
    {
        Ok(_) => Json(UserPlaylistSummary {
            id,
            name: body.name,
            owner_id: user.id,
            owner_username: user.username,
            track_count: 0,
        })
        .into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not create playlist").into_response(),
    }
}

/// Every playlist on the server, not just the caller's — the frontend
/// splits "your playlists" vs "everyone else's" by comparing `owner_id`
/// client-side rather than this needing two separate endpoints.
async fn list_playlists(State(state): State<AppState>, _user: AuthUser) -> Response {
    let rows: Result<Vec<UserPlaylistSummary>, _> = sqlx::query_as(
        "SELECT p.id, p.name, p.owner_id, u.username AS owner_username, \
         (SELECT COUNT(*) FROM playlist_tracks t WHERE t.playlist_id = p.id) AS track_count \
         FROM playlists p JOIN users u ON u.id = p.owner_id \
         ORDER BY p.created_at",
    )
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(rows) => Json(rows).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not list playlists").into_response(),
    }
}

#[derive(sqlx::FromRow)]
struct PlaylistTrackRow {
    id: String,
    provider_id: String,
    source_ref: String,
    title: String,
    artist_name: Option<String>,
    artist_ref: Option<String>,
    album_name: Option<String>,
    album_ref: Option<String>,
    artwork_url: Option<String>,
    duration_secs: Option<i64>,
}

fn playlist_track_to_track(r: PlaylistTrackRow) -> Track {
    Track {
        // Unlike `list_likes`'s fresh uuid per fetch, this needs to stay
        // stable across fetches so the frontend's "remove this track"
        // button (keyed by `Track.id`) keeps pointing at the right row.
        id: Uuid::parse_str(&r.id).unwrap_or_else(|_| Uuid::new_v4()),
        title: r.title,
        duration_secs: r.duration_secs.map(|d| d as u32),
        track_number: None,
        sources: vec![TrackSource {
            is_local: r.provider_id == "local",
            provider_id: r.provider_id,
            source_ref: r.source_ref,
            bitrate_kbps: None,
            is_lossless: false,
        }],
        artwork_url: r.artwork_url,
        artist_name: r.artist_name,
        artist_ref: r.artist_ref,
        album_name: r.album_name,
        album_ref: r.album_ref,
        download_status: None,
    }
}

#[derive(Serialize)]
struct PlaylistDetail {
    id: String,
    name: String,
    owner_id: String,
    owner_username: String,
    tracks: Vec<Track>,
}

async fn load_playlist_tracks(db: &SqlitePool, playlist_id: &str) -> Result<Vec<Track>, sqlx::Error> {
    let rows: Vec<PlaylistTrackRow> = sqlx::query_as(
        "SELECT id, provider_id, source_ref, title, artist_name, artist_ref, album_name, album_ref, \
         artwork_url, duration_secs FROM playlist_tracks WHERE playlist_id = ? ORDER BY position",
    )
    .bind(playlist_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(playlist_track_to_track).collect())
}

async fn get_playlist(State(state): State<AppState>, _user: AuthUser, Path(id): Path<String>) -> Response {
    let header = sqlx::query_as::<_, (String, String, String)>(
        "SELECT p.name, p.owner_id, u.username FROM playlists p JOIN users u ON u.id = p.owner_id WHERE p.id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await;

    let Ok(Some((name, owner_id, owner_username))) = header else {
        return (StatusCode::NOT_FOUND, "playlist not found").into_response();
    };

    match load_playlist_tracks(&state.db, &id).await {
        Ok(tracks) => Json(PlaylistDetail { id, name, owner_id, owner_username, tracks }).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not load playlist").into_response(),
    }
}

/// Full detail (tracks included) for just the caller's own playlists in one
/// call, so the client can show "your playlists" with their track lists
/// already populated without an N-request fan-out of `GET /api/playlists/:id`.
async fn list_my_playlists(State(state): State<AppState>, user: AuthUser) -> Response {
    let headers: Result<Vec<(String, String)>, _> =
        sqlx::query_as("SELECT id, name FROM playlists WHERE owner_id = ? ORDER BY created_at")
            .bind(&user.id)
            .fetch_all(&state.db)
            .await;

    let Ok(headers) = headers else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not list your playlists").into_response();
    };

    let mut playlists = Vec::with_capacity(headers.len());
    for (id, name) in headers {
        match load_playlist_tracks(&state.db, &id).await {
            Ok(tracks) => playlists.push(PlaylistDetail {
                id,
                name,
                owner_id: user.id.clone(),
                owner_username: user.username.clone(),
                tracks,
            }),
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "could not load your playlists").into_response(),
        }
    }
    Json(playlists).into_response()
}

async fn delete_playlist(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> Response {
    match playlist_owner_id(&state.db, &id).await {
        None => (StatusCode::NOT_FOUND, "playlist not found").into_response(),
        Some(owner_id) if owner_id != user.id => {
            (StatusCode::FORBIDDEN, "not your playlist").into_response()
        }
        Some(_) => match sqlx::query("DELETE FROM playlists WHERE id = ?").bind(&id).execute(&state.db).await {
            Ok(_) => StatusCode::NO_CONTENT.into_response(),
            Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not delete playlist").into_response(),
        },
    }
}

// Collaborative by default — any logged-in user can add/remove tracks on
// any playlist (matches the already-open "everyone can see everyone's
// playlists" visibility model), not just the owner. Only delete/rename
// stay owner-only (see `delete_playlist`).
async fn add_playlist_track(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
    Json(track): Json<Track>,
) -> Response {
    if playlist_owner_id(&state.db, &id).await.is_none() {
        return (StatusCode::NOT_FOUND, "playlist not found").into_response();
    }
    let Some(source) = track.sources.first() else {
        return (StatusCode::BAD_REQUEST, "track has no source").into_response();
    };

    let next_position: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_tracks WHERE playlist_id = ?",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let row_id = Uuid::new_v4().to_string();
    let result = sqlx::query(
        "INSERT INTO playlist_tracks (id, playlist_id, position, provider_id, source_ref, title, \
         artist_name, artist_ref, album_name, album_ref, artwork_url, duration_secs) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&row_id)
    .bind(&id)
    .bind(next_position)
    .bind(&source.provider_id)
    .bind(&source.source_ref)
    .bind(&track.title)
    .bind(&track.artist_name)
    .bind(&track.artist_ref)
    .bind(&track.album_name)
    .bind(&track.album_ref)
    .bind(&track.artwork_url)
    .bind(track.duration_secs.map(|d| d as i64))
    .execute(&state.db)
    .await;

    match result {
        Ok(_) => Json(playlist_track_to_track(PlaylistTrackRow {
            id: row_id,
            provider_id: source.provider_id.clone(),
            source_ref: source.source_ref.clone(),
            title: track.title,
            artist_name: track.artist_name,
            artist_ref: track.artist_ref,
            album_name: track.album_name,
            album_ref: track.album_ref,
            artwork_url: track.artwork_url,
            duration_secs: track.duration_secs.map(|d| d as i64),
        }))
        .into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not add track").into_response(),
    }
}

async fn remove_playlist_track(
    State(state): State<AppState>,
    _user: AuthUser,
    Path((id, track_id)): Path<(String, String)>,
) -> Response {
    if playlist_owner_id(&state.db, &id).await.is_none() {
        return (StatusCode::NOT_FOUND, "playlist not found").into_response();
    }
    match sqlx::query("DELETE FROM playlist_tracks WHERE id = ? AND playlist_id = ?")
        .bind(&track_id)
        .bind(&id)
        .execute(&state.db)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not remove track").into_response(),
    }
}

/// Broadcast over `/api/playback/ws` whenever any device updates playback
/// state. `device_id` lets a receiving client tell "this is an update I
/// just sent myself" apart from "another device changed something", which
/// is what lets it decide whether to pause itself or sync its displayed
/// track. Jam remote-control commands (play/pause/skip/volume) travel over
/// the jam-scoped ws instead — see RemoteCommand — since "who should act on
/// this" is a jam concept (the designated source device) there, not a
/// per-device heuristic.
#[derive(Clone, Serialize)]
struct PlaybackEvent {
    user_id: String,
    device_id: String,
    track: Track,
    position_secs: f64,
    is_playing: bool,
}

#[derive(Deserialize)]
struct PlaybackUpdate {
    device_id: String,
    track: Track,
    position_secs: f64,
    is_playing: bool,
}

/// Cross-device playback sync (REQUIREMENTS: starting a track on one device
/// should pause/sync the others). Devices POST here on every play/pause/seek
/// and periodically while playing; the row is a single upsert per user (last
/// writer wins) so `GET /api/playback` always has something to hydrate a
/// freshly-opened device with, and every connected device also gets the
/// update live via the broadcast channel.
async fn update_playback(State(state): State<AppState>, user: AuthUser, Json(body): Json<PlaybackUpdate>) -> Response {
    let Some(source) = body.track.sources.first() else {
        return (StatusCode::BAD_REQUEST, "track has no source").into_response();
    };

    let result = sqlx::query(
        "INSERT INTO playback_state \
         (user_id, provider_id, source_ref, title, artist_name, album_name, artwork_url, duration_secs, position_secs, is_playing, device_id, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) \
         ON CONFLICT (user_id) DO UPDATE SET \
           provider_id = excluded.provider_id, source_ref = excluded.source_ref, title = excluded.title, \
           artist_name = excluded.artist_name, album_name = excluded.album_name, artwork_url = excluded.artwork_url, \
           duration_secs = excluded.duration_secs, position_secs = excluded.position_secs, \
           is_playing = excluded.is_playing, device_id = excluded.device_id, updated_at = datetime('now')",
    )
    .bind(&user.id)
    .bind(&source.provider_id)
    .bind(&source.source_ref)
    .bind(&body.track.title)
    .bind(&body.track.artist_name)
    .bind(&body.track.album_name)
    .bind(&body.track.artwork_url)
    .bind(body.track.duration_secs.map(|d| d as i64))
    .bind(body.position_secs)
    .bind(body.is_playing)
    .bind(&body.device_id)
    .execute(&state.db)
    .await;

    if result.is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not update playback state").into_response();
    }

    // Best-effort: no subscribers (nobody else has this account open) is a
    // normal, non-error outcome, not something to report back to the caller.
    let _ = state.playback_tx.send(PlaybackEvent {
        user_id: user.id,
        device_id: body.device_id,
        track: body.track,
        position_secs: body.position_secs,
        is_playing: body.is_playing,
    });

    StatusCode::NO_CONTENT.into_response()
}

#[derive(sqlx::FromRow)]
struct PlaybackRow {
    provider_id: String,
    source_ref: String,
    title: String,
    artist_name: Option<String>,
    album_name: Option<String>,
    artwork_url: Option<String>,
    duration_secs: Option<i64>,
    position_secs: f64,
    is_playing: bool,
    device_id: String,
}

/// Hydrates a freshly-opened device with whatever was last playing anywhere
/// on the account — 204 if the user has never played anything yet.
async fn get_playback(State(state): State<AppState>, user: AuthUser) -> Response {
    let row: Option<PlaybackRow> = sqlx::query_as(
        "SELECT provider_id, source_ref, title, artist_name, album_name, artwork_url, duration_secs, \
                position_secs, is_playing, device_id \
         FROM playback_state WHERE user_id = ?",
    )
    .bind(&user.id)
    .fetch_optional(&state.db)
    .await
    .unwrap_or(None);

    let Some(row) = row else {
        return StatusCode::NO_CONTENT.into_response();
    };

    let track = Track {
        id: Uuid::new_v4(),
        title: row.title,
        duration_secs: row.duration_secs.map(|d| d as u32),
        track_number: None,
        sources: vec![TrackSource {
            is_local: row.provider_id == "local",
            provider_id: row.provider_id,
            source_ref: row.source_ref,
            bitrate_kbps: None,
            is_lossless: false,
        }],
        artwork_url: row.artwork_url,
        artist_name: row.artist_name,
        artist_ref: None,
        album_name: row.album_name,
        album_ref: None,
        download_status: None,
    };

    Json(serde_json::json!({
        "track": track,
        "position_secs": row.position_secs,
        "is_playing": row.is_playing,
        "device_id": row.device_id,
    }))
    .into_response()
}

/// Live push side of playback sync. Auth travels as `?token=` (same as
/// `/api/stream`) since the browser WebSocket API can't set an Authorization
/// header. Every event for this user's account gets forwarded, including
/// ones this same connection's own device sent — the client filters those
/// out itself by comparing `device_id`, so it can also use "my own echo" as
/// confirmation a push round-tripped if that's ever useful.
async fn playback_ws(State(state): State<AppState>, user: AuthUser, ws: WebSocketUpgrade) -> Response {
    let rx = state.playback_tx.subscribe();
    ws.on_upgrade(move |socket| handle_playback_ws(socket, rx, user.id))
}

async fn handle_playback_ws(mut socket: WebSocket, mut rx: broadcast::Receiver<PlaybackEvent>, user_id: String) {
    loop {
        let event = match rx.recv().await {
            Ok(event) => event,
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        };
        if event.user_id != user_id {
            continue;
        }
        let Ok(json) = serde_json::to_string(&event) else { continue };
        if socket.send(Message::Text(json)).await.is_err() {
            break;
        }
    }
}

// --- Weave Jam ----------------------------------------------------------
// A host-started collaborative session: guests join via a short code/QR
// link (see `JamMember` in auth.rs) and add tracks to the host's real
// queue. The host's own `useQueue` stays the single source of truth for
// playback order — this layer only logs attribution, mirrors "now playing"
// for guests to watch, and fans out the resulting events.

/// Ephemeral "what's actually playing" snapshot for one jam, kept in
/// `AppState::jam_live` and pushed by the host's client roughly on the same
/// cadence as its own cross-device heartbeat (see `jam_playback`).
#[derive(Clone, Serialize, Default)]
struct JamLive {
    now_playing: Option<Track>,
    position_secs: f64,
    is_playing: bool,
    upcoming: Vec<Track>,
    volume: f64,
    shuffle: bool,
    repeat: String,
}

/// Per-account defaults for what guests (not the account's own devices) may
/// do in any jam this account starts — persisted so a choice sticks across
/// jams, not just for the one currently running. The account's own devices
/// (`JamMember::is_host`) are never subject to this; it only ever gates
/// guest-initiated requests.
#[derive(Clone, Copy, Serialize, Deserialize)]
struct JamSettings {
    guests_can_add_queue: bool,
    guests_can_control_playback: bool,
    guests_can_shuffle_repeat: bool,
    /// Auto-end a jam after this many minutes with no activity — 0 means
    /// never. Checked by `sweep_inactive_jams` against `jam_sessions.last_active_at`.
    inactivity_timeout_minutes: i64,
}

// This default (60) is duplicated in the COALESCE in sweep_inactive_jams'
// query, for accounts that have never saved a jam_settings row at all —
// keep both in sync if this ever changes.
impl Default for JamSettings {
    fn default() -> Self {
        // Matches the jam feature's original behavior before settings
        // existed: guests could add songs, nothing else.
        Self {
            guests_can_add_queue: true,
            guests_can_control_playback: false,
            guests_can_shuffle_repeat: false,
            inactivity_timeout_minutes: 60,
        }
    }
}

async fn fetch_jam_settings(db: &SqlitePool, user_id: &str) -> JamSettings {
    sqlx::query_as::<_, (bool, bool, bool, i64)>(
        "SELECT guests_can_add_queue, guests_can_control_playback, guests_can_shuffle_repeat, inactivity_timeout_minutes \
         FROM jam_settings WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .map(|(guests_can_add_queue, guests_can_control_playback, guests_can_shuffle_repeat, inactivity_timeout_minutes)| {
        JamSettings { guests_can_add_queue, guests_can_control_playback, guests_can_shuffle_repeat, inactivity_timeout_minutes }
    })
    .unwrap_or_default()
}

async fn get_jam_settings(State(state): State<AppState>, user: AuthUser) -> Response {
    Json(fetch_jam_settings(&state.db, &user.id).await).into_response()
}

async fn update_jam_settings(State(state): State<AppState>, user: AuthUser, Json(body): Json<JamSettings>) -> Response {
    let result = sqlx::query(
        "INSERT INTO jam_settings (user_id, guests_can_add_queue, guests_can_control_playback, guests_can_shuffle_repeat, inactivity_timeout_minutes) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(user_id) DO UPDATE SET \
           guests_can_add_queue = excluded.guests_can_add_queue, \
           guests_can_control_playback = excluded.guests_can_control_playback, \
           guests_can_shuffle_repeat = excluded.guests_can_shuffle_repeat, \
           inactivity_timeout_minutes = excluded.inactivity_timeout_minutes",
    )
    .bind(&user.id)
    .bind(body.guests_can_add_queue)
    .bind(body.guests_can_control_playback)
    .bind(body.guests_can_shuffle_repeat)
    .bind(body.inactivity_timeout_minutes)
    .execute(&state.db)
    .await;

    if result.is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not save jam settings").into_response();
    }
    Json(body).into_response()
}

/// Marks a jam as having just seen real activity (join, queue add, remote
/// command, or actual playback) — compared against the account's
/// `inactivity_timeout_minutes` by the periodic sweep below. Deliberately
/// NOT touched by every heartbeat: a paused jam left open shouldn't look
/// "active" forever just because the source tab is still sending its
/// regular `is_playing: false` heartbeat.
async fn touch_jam_activity(db: &SqlitePool, jam_id: &str) {
    let _ = sqlx::query("UPDATE jam_sessions SET last_active_at = datetime('now') WHERE id = ?").bind(jam_id).execute(db).await;
}

/// Ends any jam whose account-configured inactivity window has elapsed
/// since its last real activity. Runs on a fixed interval from `main()`
/// rather than per-request, since "is this jam idle" isn't something any
/// single request is well-placed to check.
async fn sweep_inactive_jams(state: &AppState) {
    let jam_ids: Vec<String> = sqlx::query_scalar(
        "SELECT jam_sessions.id FROM jam_sessions \
         LEFT JOIN jam_settings ON jam_settings.user_id = jam_sessions.host_user_id \
         WHERE jam_sessions.ended_at IS NULL \
           AND COALESCE(jam_settings.inactivity_timeout_minutes, 60) > 0 \
           AND jam_sessions.last_active_at IS NOT NULL \
           AND jam_sessions.last_active_at <= datetime('now', '-' || COALESCE(jam_settings.inactivity_timeout_minutes, 60) || ' minutes')",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    for jam_id in jam_ids {
        let _ = sqlx::query("UPDATE jam_sessions SET ended_at = datetime('now') WHERE id = ?").bind(&jam_id).execute(&state.db).await;
        state.jam_live.lock().unwrap().remove(&jam_id);
        let _ = state.jam_tx.send(JamEvent::Ended { jam_id });
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "type")]
enum JamEvent {
    MemberJoined { jam_id: String, name: String },
    QueueAdded { jam_id: String, id: String, track: Track, added_by_name: String },
    PlaybackUpdated { jam_id: String, live: JamLive },
    // Play/Pause/Next/Prev/Volume from a remote (any host-role device other
    // than the source). Every host-role device receives this over the jam
    // ws, but only the source device acts on it — same "the client decides
    // for itself" pattern as the cross-device playback Command, just
    // jam-scoped instead of account-scoped.
    RemoteCommand { jam_id: String, command: String, value: Option<f64> },
    Ended { jam_id: String },
}

impl JamEvent {
    fn jam_id(&self) -> &str {
        match self {
            JamEvent::MemberJoined { jam_id, .. } => jam_id,
            JamEvent::QueueAdded { jam_id, .. } => jam_id,
            JamEvent::PlaybackUpdated { jam_id, .. } => jam_id,
            JamEvent::RemoteCommand { jam_id, .. } => jam_id,
            JamEvent::Ended { jam_id } => jam_id,
        }
    }
}

/// 6-char join code. Excludes visually-ambiguous characters (0/O, 1/I)
/// since people retype these by hand as often as they scan the QR.
fn generate_jam_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..6).map(|_| *ALPHABET.choose(&mut rng).unwrap() as char).collect()
}

/// Starts a jam for the calling account — or, if this account already has
/// one running (e.g. started from another device), resumes it by handing
/// this device its own host token for the *existing* jam instead of ending
/// it out from under whichever device actually started it. That's what
/// used to happen here (unconditionally ending any prior jam first), which
/// meant opening the app on a second device and tapping "Start a Jam"
/// would silently kill the jam already running on the first one.
async fn create_jam(State(state): State<AppState>, user: AuthUser) -> Response {
    let existing_jam_id: Option<String> =
        sqlx::query_scalar("SELECT id FROM jam_sessions WHERE host_user_id = ? AND ended_at IS NULL")
            .bind(&user.id)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None);

    // Only the device whose call actually creates the jam_sessions row (as
    // opposed to resuming one that already exists) is the source — every
    // other host-role device, including ones that join later via this same
    // endpoint, is a remote for the session's whole lifetime.
    let (jam_id, is_source) = match existing_jam_id {
        Some(id) => (id, false),
        None => {
            let mut id = generate_jam_code();
            for _ in 0..5 {
                let taken: Option<i64> = sqlx::query_scalar("SELECT 1 FROM jam_sessions WHERE id = ?")
                    .bind(&id)
                    .fetch_optional(&state.db)
                    .await
                    .unwrap_or(None);
                if taken.is_none() {
                    break;
                }
                id = generate_jam_code();
            }
            if sqlx::query("INSERT INTO jam_sessions (id, host_user_id, last_active_at) VALUES (?, ?, datetime('now'))")
                .bind(&id)
                .bind(&user.id)
                .execute(&state.db)
                .await
                .is_err()
            {
                return (StatusCode::INTERNAL_SERVER_ERROR, "could not create jam").into_response();
            }
            (id, true)
        }
    };
    touch_jam_activity(&state.db, &jam_id).await;

    let token = generate_token();
    if sqlx::query("INSERT INTO jam_members (token, jam_id, name, is_host, is_source) VALUES (?, ?, ?, 1, ?)")
        .bind(&token)
        .bind(&jam_id)
        .bind(&user.username)
        .bind(is_source)
        .execute(&state.db)
        .await
        .is_err()
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not create jam").into_response();
    }

    Json(serde_json::json!({ "jam_id": jam_id, "token": token, "is_source": is_source })).into_response()
}

/// Lightweight presence check — does this account already have a jam
/// running right now? Used by every device's client on load so a second
/// device can hydrate into an already-running jam instead of only finding
/// out about it by trying (and silently taking over) via `create_jam`.
async fn my_active_jam(State(state): State<AppState>, user: AuthUser) -> Response {
    let jam_id: Option<String> =
        sqlx::query_scalar("SELECT id FROM jam_sessions WHERE host_user_id = ? AND ended_at IS NULL")
            .bind(&user.id)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None);

    match jam_id {
        Some(jam_id) => Json(serde_json::json!({ "jam_id": jam_id })).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

#[derive(Deserialize)]
struct JoinJamBody {
    name: String,
}

/// Public — no login required, this is exactly the "scan a QR, pick a name"
/// path. Rejects jams that don't exist or have already ended.
async fn join_jam(State(state): State<AppState>, Path(jam_id): Path<String>, Json(body): Json<JoinJamBody>) -> Response {
    let active: Option<i64> = sqlx::query_scalar("SELECT 1 FROM jam_sessions WHERE id = ? AND ended_at IS NULL")
        .bind(&jam_id)
        .fetch_optional(&state.db)
        .await
        .unwrap_or(None);
    if active.is_none() {
        return (StatusCode::NOT_FOUND, "jam not found or has ended").into_response();
    }

    let name = body.name.trim();
    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, "name is required").into_response();
    }

    let token = generate_token();
    if sqlx::query("INSERT INTO jam_members (token, jam_id, name, is_host) VALUES (?, ?, ?, 0)")
        .bind(&token)
        .bind(&jam_id)
        .bind(name)
        .execute(&state.db)
        .await
        .is_err()
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not join jam").into_response();
    }

    touch_jam_activity(&state.db, &jam_id).await;
    let _ = state.jam_tx.send(JamEvent::MemberJoined { jam_id: jam_id.clone(), name: name.to_string() });

    Json(serde_json::json!({ "jam_id": jam_id, "token": token, "name": name })).into_response()
}

#[derive(Serialize)]
struct JamMemberDto {
    name: String,
    is_host: bool,
}

#[derive(Serialize)]
struct JamQueueLogEntry {
    id: String,
    track: Track,
    added_by_name: String,
}

/// Snapshot for (re)hydrating the jam panel/room — members, the full
/// attribution log, and whatever "now playing" was last reported.
async fn jam_state(State(state): State<AppState>, member: JamMember) -> Response {
    let member_rows: Vec<(String, bool)> =
        sqlx::query_as("SELECT name, is_host FROM jam_members WHERE jam_id = ? ORDER BY joined_at")
            .bind(&member.jam_id)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();
    let members: Vec<JamMemberDto> =
        member_rows.into_iter().map(|(name, is_host)| JamMemberDto { name, is_host }).collect();

    let log_rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, track_json, added_by_name FROM jam_queue_log WHERE jam_id = ? ORDER BY created_at",
    )
    .bind(&member.jam_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let queue_log: Vec<JamQueueLogEntry> = log_rows
        .into_iter()
        .filter_map(|(id, track_json, added_by_name)| {
            serde_json::from_str::<Track>(&track_json).ok().map(|track| JamQueueLogEntry { id, track, added_by_name })
        })
        .collect();

    let live = state.jam_live.lock().unwrap().get(&member.jam_id).cloned();
    let permissions = fetch_jam_settings(&state.db, &member.host_user_id).await;

    Json(serde_json::json!({
        "jam_id": member.jam_id,
        "members": members,
        "queue_log": queue_log,
        "live": live,
        "permissions": permissions,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct AddJamQueueBody {
    track: Track,
}

/// Logs attribution for a track someone added to the jam and fans it out —
/// the host's client is what actually calls `queueApi.enqueue` in response
/// (see `useJam.ts`), so this never needs to know anything about playback
/// order/shuffle/repeat.
async fn add_jam_queue(
    State(state): State<AppState>,
    member: JamMember,
    Path(jam_id): Path<String>,
    Json(body): Json<AddJamQueueBody>,
) -> Response {
    if jam_id != member.jam_id {
        return (StatusCode::FORBIDDEN, "wrong jam").into_response();
    }
    if !member.is_host {
        let settings = fetch_jam_settings(&state.db, &member.host_user_id).await;
        if !settings.guests_can_add_queue {
            return (StatusCode::FORBIDDEN, "the host has turned off adding songs for guests").into_response();
        }
    }
    let Ok(track_json) = serde_json::to_string(&body.track) else {
        return (StatusCode::BAD_REQUEST, "invalid track").into_response();
    };

    let id = Uuid::new_v4().to_string();
    if sqlx::query("INSERT INTO jam_queue_log (id, jam_id, track_json, added_by_name) VALUES (?, ?, ?, ?)")
        .bind(&id)
        .bind(&jam_id)
        .bind(&track_json)
        .bind(&member.name)
        .execute(&state.db)
        .await
        .is_err()
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not add to queue").into_response();
    }

    touch_jam_activity(&state.db, &jam_id).await;
    let _ = state.jam_tx.send(JamEvent::QueueAdded {
        jam_id: jam_id.clone(),
        id,
        track: body.track,
        added_by_name: member.name.clone(),
    });

    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct JamPlaybackBody {
    track: Option<Track>,
    position_secs: f64,
    is_playing: bool,
    #[serde(default)]
    upcoming: Vec<Track>,
    #[serde(default = "default_volume")]
    volume: f64,
    #[serde(default)]
    shuffle: bool,
    #[serde(default = "default_repeat")]
    repeat: String,
}

fn default_volume() -> f64 {
    1.0
}

fn default_repeat() -> String {
    "off".to_string()
}

/// Host-only heartbeat mirroring what's actually playing, so guests' "now
/// playing" view and "up next" list stay roughly live without the server
/// needing to understand playback order itself.
async fn jam_playback(
    State(state): State<AppState>,
    member: JamMember,
    Path(jam_id): Path<String>,
    Json(body): Json<JamPlaybackBody>,
) -> Response {
    if jam_id != member.jam_id || !member.is_host {
        return (StatusCode::FORBIDDEN, "host only").into_response();
    }

    // Only an actually-playing heartbeat counts as "activity" for the
    // inactivity sweep — a paused jam left open sends this same heartbeat
    // every 5s regardless, and that alone shouldn't keep it alive forever.
    if body.is_playing {
        touch_jam_activity(&state.db, &jam_id).await;
    }

    let live = JamLive {
        now_playing: body.track,
        position_secs: body.position_secs,
        is_playing: body.is_playing,
        upcoming: body.upcoming,
        volume: body.volume,
        shuffle: body.shuffle,
        repeat: body.repeat,
    };
    state.jam_live.lock().unwrap().insert(jam_id.clone(), live.clone());
    let _ = state.jam_tx.send(JamEvent::PlaybackUpdated { jam_id, live });

    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct JamCommandBody {
    command: String,
    #[serde(default)]
    value: Option<f64>,
}

/// Play/Pause/Next/Prev/Volume from a remote — any host-role device, same
/// gate as the heartbeat/end-jam routes. Purely a fire-and-forget nudge
/// over the jam ws; no server-side notion of "which device is the source"
/// beyond the is_source flag each client already got back from create_jam,
/// so there's nothing to look up here.
async fn jam_command(
    State(state): State<AppState>,
    member: JamMember,
    Path(jam_id): Path<String>,
    Json(body): Json<JamCommandBody>,
) -> Response {
    if jam_id != member.jam_id {
        return (StatusCode::FORBIDDEN, "wrong jam").into_response();
    }
    // The account's own devices (host-role) can always send any command —
    // that's the laptop/phone remote-control case. A guest can only send
    // the specific commands the host has opted to allow for guests; volume
    // (and anything unrecognized) is never guest-allowed.
    if !member.is_host {
        let settings = fetch_jam_settings(&state.db, &member.host_user_id).await;
        let allowed = match body.command.as_str() {
            "play" | "pause" | "next" | "prev" => settings.guests_can_control_playback,
            "shuffle" | "repeat" => settings.guests_can_shuffle_repeat,
            _ => false,
        };
        if !allowed {
            return (StatusCode::FORBIDDEN, "the host hasn't allowed guests to do that").into_response();
        }
    }
    touch_jam_activity(&state.db, &jam_id).await;
    let _ = state.jam_tx.send(JamEvent::RemoteCommand { jam_id, command: body.command, value: body.value });
    StatusCode::NO_CONTENT.into_response()
}

async fn end_jam(State(state): State<AppState>, member: JamMember, Path(jam_id): Path<String>) -> Response {
    if jam_id != member.jam_id || !member.is_host {
        return (StatusCode::FORBIDDEN, "host only").into_response();
    }

    let _ = sqlx::query("UPDATE jam_sessions SET ended_at = datetime('now') WHERE id = ?")
        .bind(&jam_id)
        .execute(&state.db)
        .await;
    state.jam_live.lock().unwrap().remove(&jam_id);
    let _ = state.jam_tx.send(JamEvent::Ended { jam_id });

    StatusCode::NO_CONTENT.into_response()
}

/// Recommendations seeded off whatever was most recently added to the jam
/// (falling back to the live "now playing" track), via the same
/// `MediaProvider::radio` continuation used by `/api/radio` — just re-seeded
/// per jam and deduped against everything already added.
async fn jam_recommendations(State(state): State<AppState>, member: JamMember, Path(jam_id): Path<String>) -> Response {
    if jam_id != member.jam_id {
        return (StatusCode::FORBIDDEN, "wrong jam").into_response();
    }

    let last_track_json: Option<String> = sqlx::query_scalar(
        "SELECT track_json FROM jam_queue_log WHERE jam_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&jam_id)
    .fetch_optional(&state.db)
    .await
    .unwrap_or(None);

    let seed_track = match last_track_json.and_then(|j| serde_json::from_str::<Track>(&j).ok()) {
        Some(track) => Some(track),
        None => state.jam_live.lock().unwrap().get(&jam_id).and_then(|l| l.now_playing.clone()),
    };

    let Some(seed_track) = seed_track else {
        return Json(serde_json::json!({ "results": Vec::<Track>::new() })).into_response();
    };
    let Some(source) = seed_track.sources.first() else {
        return Json(serde_json::json!({ "results": Vec::<Track>::new() })).into_response();
    };
    let Some(provider) = state.provider(&source.provider_id) else {
        return Json(serde_json::json!({ "results": Vec::<Track>::new() })).into_response();
    };

    let candidates = match provider.radio(&source.source_ref, 16).await {
        Ok(results) => results,
        Err(err) => {
            tracing::warn!(%err, "jam recommendations failed");
            return Json(serde_json::json!({ "results": Vec::<Track>::new() })).into_response();
        }
    };

    let existing_json: Vec<String> = sqlx::query_scalar("SELECT track_json FROM jam_queue_log WHERE jam_id = ?")
        .bind(&jam_id)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
    let existing_sources: HashSet<(String, String)> = existing_json
        .iter()
        .filter_map(|j| serde_json::from_str::<Track>(j).ok())
        .filter_map(|t| t.sources.first().map(|s| (s.provider_id.clone(), s.source_ref.clone())))
        .collect();

    let results: Vec<Track> = candidates
        .into_iter()
        .filter(|t| {
            t.sources
                .first()
                .map(|s| !existing_sources.contains(&(s.provider_id.clone(), s.source_ref.clone())))
                .unwrap_or(true)
        })
        .take(6)
        .collect();

    Json(serde_json::json!({ "results": results })).into_response()
}

/// Live push side of the jam — same shape as `playback_ws`, filtered by jam
/// id instead of user id.
async fn jam_ws(State(state): State<AppState>, member: JamMember, ws: WebSocketUpgrade) -> Response {
    let rx = state.jam_tx.subscribe();
    ws.on_upgrade(move |socket| handle_jam_ws(socket, rx, member.jam_id))
}

async fn handle_jam_ws(mut socket: WebSocket, mut rx: broadcast::Receiver<JamEvent>, jam_id: String) {
    loop {
        let event = match rx.recv().await {
            Ok(event) => event,
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        };
        if event.jam_id() != jam_id {
            continue;
        }
        let Ok(json) = serde_json::to_string(&event) else { continue };
        if socket.send(Message::Text(json)).await.is_err() {
            break;
        }
    }
}
