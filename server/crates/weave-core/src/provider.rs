use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::Track;

/// Download sources acquire files into the library; streaming sources
/// play audio without necessarily owning a local copy. A provider may
/// report both, e.g. once a stream has been transparently cached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderKind {
    Download,
    Streaming,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchQuery {
    pub text: String,
    pub limit: usize,
}

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("provider unavailable: {0}")]
    Unavailable(String),
    #[error("not found")]
    NotFound,
    #[error("upstream error: {0}")]
    Upstream(String),
}

/// The contract every media source implements, whether it's a compiled-in
/// Rust connector (current direction for known sources like Lidarr/slskd/
/// yt-dlp/Piped) or, eventually, an out-of-process plugin speaking the same
/// interface over gRPC. Keeping this trait the seam between "core" and
/// "source" is what lets a new provider be added without touching the
/// rest of the server. See REQUIREMENTS.md §4 and §13.
#[async_trait]
pub trait MediaProvider: Send + Sync {
    fn id(&self) -> &str;
    fn kind(&self) -> ProviderKind;

    async fn search(&self, query: &SearchQuery) -> Result<Vec<Track>, ProviderError>;

    /// Returns a URL or local path the server can stream/serve from.
    async fn resolve(&self, source_ref: &str) -> Result<String, ProviderError>;
}
