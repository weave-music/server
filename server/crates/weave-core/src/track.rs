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
    /// `None` means no album browsing available (true for all yt-dlp
    /// tracks today — YouTube has no reliable album concept outside of
    /// YouTube Music's own artist pages, which yt-dlp doesn't expose
    /// cleanly; see weave-provider-ytdlp).
    pub album_ref: Option<String>,
}
