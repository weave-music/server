mod auth;

use std::sync::Arc;

use auth::{create_session, hash_password, verify_password, AdminUser, AuthUser};
use axum::{
    body::Body,
    extract::{Path, Query, Request, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
    routing::{delete, get, post},
    Json, Router,
};
use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
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
}

impl AppState {
    fn provider(&self, id: &str) -> Option<&Arc<dyn MediaProvider>> {
        self.providers.iter().find(|p| p.id() == id)
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let music_dir = std::env::var("WEAVE_LIBRARY_PATH").unwrap_or_else(|_| "/music".to_string());
    let local_provider = Arc::new(LocalFilesystemProvider::new("local", music_dir));
    let ytdlp_provider = Arc::new(YtDlpProvider::new("ytdlp"));

    let db_path = std::env::var("WEAVE_DB_PATH").unwrap_or_else(|_| "/config/weave.db".to_string());
    let connect_options = SqliteConnectOptions::new().filename(&db_path).create_if_missing(true);
    let db = SqlitePoolOptions::new()
        .connect_with(connect_options)
        .await
        .unwrap_or_else(|e| panic!("failed to open database at {db_path}: {e}"));
    sqlx::migrate!().run(&db).await.expect("database migrations failed");

    let state = AppState { providers: vec![local_provider, ytdlp_provider], db };

    let app = Router::new()
        .route("/health", get(health))
        .route("/rest/ping.view", get(subsonic_ping))
        .route("/api/auth/setup", get(setup_status).post(setup))
        .route("/api/auth/login", post(login))
        .route("/api/auth/register", post(register))
        .route("/api/settings/registration", get(get_registration_setting).put(set_registration_setting))
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/:id", delete(delete_user))
        .route("/api/me", get(me))
        .route("/api/search", get(search))
        .route("/api/featured", get(featured))
        .route("/api/radio", get(radio))
        .route("/api/artist", get(artist_tracks))
        .route("/api/artist/releases", get(artist_releases))
        .route("/api/album", get(album_tracks))
        .route("/api/likes", get(list_likes).post(like_track).delete(unlike_track))
        .route("/api/stream", get(stream))
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
    match sqlx::query_as::<_, UserInfo>("SELECT id, username, is_admin, created_at FROM users ORDER BY created_at")
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
    _user: AuthUser,
    Query(params): Query<SearchParams>,
) -> Json<serde_json::Value> {
    let query = SearchQuery { text: params.q, limit: 25 };

    // Unified search across every configured provider (REQUIREMENTS.md §6).
    // Sequential for now; fan these out concurrently once there's more than one.
    let mut results = Vec::new();
    for provider in &state.providers {
        match provider.search(&query).await {
            Ok(tracks) => results.extend(tracks),
            Err(err) => tracing::warn!(provider = provider.id(), %err, "provider search failed"),
        }
    }

    Json(serde_json::json!({ "results": results }))
}

/// "Featured" tracks: a shuffled sample pulled live from every provider's
/// `browse()`. There's no listening history or taste profile yet (see
/// REQUIREMENTS.md §13), so this is honestly just randomized discovery, not
/// personalized recommendations — framed that way in the UI too.
async fn featured(State(state): State<AppState>, _user: AuthUser) -> Json<serde_json::Value> {
    let mut results = Vec::new();
    for provider in &state.providers {
        match provider.browse(8).await {
            Ok(tracks) => results.extend(tracks),
            Err(err) => tracing::warn!(provider = provider.id(), %err, "provider browse failed"),
        }
    }
    results.shuffle(&mut rand::thread_rng());
    Json(serde_json::json!({ "results": results }))
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
        Ok(releases) => Json(serde_json::json!({ "releases": releases })).into_response(),
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

/// Resolves a track source through its owning provider, then either serves
/// the file directly (local, with Range support for seeking) or redirects
/// the player at a remote stream URL. This is the seam where downloaded and
/// streamed audio become interchangeable to the client (REQUIREMENTS.md §7).
async fn stream(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<StreamParams>,
    req: Request,
) -> Response {
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
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not like track").into_response(),
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
}

async fn list_likes(State(state): State<AppState>, user: AuthUser) -> Response {
    let rows: Result<Vec<LikedRow>, _> = sqlx::query_as(
        "SELECT provider_id, source_ref, title, artist_name, album_name, artwork_url, duration_secs \
         FROM liked_tracks WHERE user_id = ? ORDER BY liked_at DESC",
    )
    .bind(&user.id)
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(rows) => {
            let tracks: Vec<Track> = rows
                .into_iter()
                .map(|r| Track {
                    id: Uuid::new_v4(),
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
                    artist_ref: None,
                    album_name: r.album_name,
                    album_ref: None,
                })
                .collect();
            Json(serde_json::json!({ "results": tracks })).into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "could not list likes").into_response(),
    }
}
