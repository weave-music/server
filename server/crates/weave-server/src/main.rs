use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Query, Request, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tower::ServiceExt;
use tower_http::services::ServeFile;
use weave_core::{MediaProvider, SearchQuery};
use weave_provider_local::LocalFilesystemProvider;
use weave_provider_ytdlp::YtDlpProvider;

#[derive(Clone)]
struct AppState {
    providers: Vec<Arc<dyn MediaProvider>>,
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

    let state = AppState { providers: vec![local_provider, ytdlp_provider] };

    let app = Router::new()
        .route("/health", get(health))
        .route("/rest/ping.view", get(subsonic_ping))
        .route("/api/search", get(search))
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
struct SearchParams {
    q: String,
}

async fn search(State(state): State<AppState>, Query(params): Query<SearchParams>) -> Json<serde_json::Value> {
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
async fn stream(State(state): State<AppState>, Query(params): Query<StreamParams>, req: Request) -> Response {
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
