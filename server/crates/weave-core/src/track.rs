use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Where a concrete copy of a track's audio can be obtained from.
/// A single `Track` may have several of these; quality-profile resolution
/// (see REQUIREMENTS.md §4) picks which one to actually play.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackSource {
    pub provider_id: String,
    /// Opaque identifier the owning provider uses to locate this file/stream.
    pub source_ref: String,
    pub bitrate_kbps: Option<u32>,
    pub is_lossless: bool,
    /// True once the server holds the actual audio bytes (downloaded or
    /// transparently cached from a stream) rather than needing to fetch
    /// them live on every play.
    pub is_local: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: Uuid,
    pub title: String,
    pub duration_secs: Option<u32>,
    pub track_number: Option<u32>,
    pub sources: Vec<TrackSource>,
    /// Not available for every provider yet — local files have no tag-based
    /// cover art extraction (REQUIREMENTS.md notes this as future work).
    pub artwork_url: Option<String>,

    pub artist_name: Option<String>,
    /// Provider-specific id usable with `MediaProvider::artist_tracks` to
    /// fetch more from this artist. `None` means the provider has no artist
    /// browsing for this track (e.g. local files have no reliable artist
    /// convention to assume).
    pub artist_ref: Option<String>,

    pub album_name: Option<String>,
    /// Provider-specific id usable with `MediaProvider::album_tracks`.
    /// `None` means no album browsing available for this particular track
    /// (e.g. a yt-dlp search result — individual videos don't carry album
    /// info without an extra per-track lookup, so that only gets filled in
    /// via `MediaProvider::artist_releases` or when tracks are themselves
    /// fetched through `album_tracks`).
    pub album_ref: Option<String>,
}

/// A lightweight album/single listing on an artist's page — not a full
/// `Track` list, just enough to show a card and open it via `album_tracks`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseSummary {
    pub id: String,
    pub title: String,
    pub artwork_url: Option<String>,
    pub year: Option<String>,
    pub is_single: bool,
}
