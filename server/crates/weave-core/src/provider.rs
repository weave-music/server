use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{PlaylistSummary, ReleaseSummary, Track};

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

    /// An unfiltered sample of this provider's catalog, for "featured"/
    /// discovery surfaces. Default just searches for nothing; providers for
    /// which an empty query doesn't make sense (e.g. one that requires a
    /// search term) should override this.
    async fn browse(&self, limit: usize) -> Result<Vec<Track>, ProviderError> {
        self.search(&SearchQuery { text: String::new(), limit }).await
    }

    /// Tracks related to the given one — "radio"/"more like this", seeded
    /// off a track the listener just played. Default: unsupported.
    async fn radio(&self, _source_ref: &str, _limit: usize) -> Result<Vec<Track>, ProviderError> {
        Ok(Vec::new())
    }

    /// More tracks from the artist identified by `Track::artist_ref`.
    /// Default: unsupported (most providers have no reliable artist
    /// concept to browse by).
    async fn artist_tracks(&self, _artist_ref: &str, _limit: usize) -> Result<Vec<Track>, ProviderError> {
        Ok(Vec::new())
    }

    /// The tracks that make up the album identified by `Track::album_ref`.
    /// Default: unsupported.
    async fn album_tracks(&self, _album_ref: &str, _limit: usize) -> Result<Vec<Track>, ProviderError> {
        Ok(Vec::new())
    }

    /// Structured albums/singles for an artist, when the provider has real
    /// release data (today: yt-dlp, via `ytmusic_bridge.py` talking to
    /// YouTube Music's own internal API — not available through generic
    /// YouTube channel scraping). Default: unsupported.
    async fn artist_releases(&self, _artist_ref: &str) -> Result<Vec<ReleaseSummary>, ProviderError> {
        Ok(Vec::new())
    }

    /// Playlists matching a search term, when the provider has a real
    /// playlist concept (today: yt-dlp only, via YouTube Music's own
    /// playlist search — see `ytmusic_bridge.py`). Default: unsupported.
    async fn search_playlists(&self, _query: &SearchQuery) -> Result<Vec<PlaylistSummary>, ProviderError> {
        Ok(Vec::new())
    }

    /// The tracks that make up the playlist identified by
    /// `PlaylistSummary::id`. Default: unsupported.
    async fn playlist_tracks(&self, _playlist_ref: &str, _limit: usize) -> Result<Vec<Track>, ProviderError> {
        Ok(Vec::new())
    }
}
