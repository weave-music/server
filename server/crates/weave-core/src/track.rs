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
pub struct Artist {
    pub id: Uuid,
    pub name: String,
    pub musicbrainz_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Album {
    pub id: Uuid,
    pub title: String,
    pub artist_id: Uuid,
    pub musicbrainz_id: Option<String>,
    pub release_year: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: Uuid,
    pub title: String,
    pub artist_id: Uuid,
    pub album_id: Option<Uuid>,
    pub duration_secs: Option<u32>,
    pub track_number: Option<u32>,
    pub sources: Vec<TrackSource>,
}
