//! Streaming provider backed by the `yt-dlp` CLI. Deliberately shells out
//! rather than scraping YouTube ourselves — yt-dlp's extractors are
//! maintained upstream and already handle the cat-and-mouse with YouTube.
//! Requires a `yt-dlp` binary on PATH (see docker/Dockerfile).

use async_trait::async_trait;
use rand::seq::SliceRandom;
use serde::Deserialize;
use tokio::process::Command;
use uuid::Uuid;
use weave_core::{MediaProvider, ProviderError, ProviderKind, SearchQuery, Track, TrackSource};

/// No real recommendation engine behind "browse" (there's no play history or
/// taste profile to draw on yet) — this just gives `browse()` something to
/// search for instead of an empty, meaningless query string.
const SEED_TOPICS: &[&str] = &[
    "lofi hip hop",
    "indie rock",
    "synthwave",
    "jazz standards",
    "classical piano",
    "electronic dance",
    "acoustic covers",
    "r&b soul",
    "folk acoustic",
    "90s alternative",
];

pub struct YtDlpProvider {
    id: String,
}

impl YtDlpProvider {
    pub fn new(id: impl Into<String>) -> Self {
        Self { id: id.into() }
    }

    fn track_from_entry(&self, entry: FlatEntry) -> Track {
        // YouTube serves a predictable thumbnail per video id — no need to
        // parse yt-dlp's thumbnails array (flat-playlist mode often leaves
        // the simpler `thumbnail` field null anyway).
        let artwork_url = format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", entry.id);
        let artist_name = entry.channel.or(entry.uploader);

        Track {
            id: Uuid::new_v4(),
            title: entry.title,
            duration_secs: entry.duration.map(|d| d as u32),
            track_number: None,
            sources: vec![TrackSource {
                provider_id: self.id.clone(),
                source_ref: entry.id,
                bitrate_kbps: None,
                is_lossless: false,
                is_local: false,
            }],
            artwork_url: Some(artwork_url),
            artist_name,
            artist_ref: entry.channel_id,
            // No reliable "album" concept on regular YouTube — a single
            // video doesn't belong to anything like one, and channels only
            // expose generic auto-playlists (Uploads/Favorites), not real
            // albums. Would need YouTube Music's own artist pages, which
            // yt-dlp doesn't surface cleanly.
            album_name: None,
            album_ref: None,
        }
    }

    /// Runs yt-dlp against a "list spec" (a search spec like `ytsearch5:x`,
    /// a playlist/mix URL, or a channel URL) and parses the flat per-entry
    /// JSON lines, capped at `limit` items via `--playlist-items` so e.g. a
    /// channel listing hundreds of videos doesn't get fetched in full just
    /// to be truncated afterward.
    async fn flat_playlist(&self, list_spec: &str, limit: usize) -> Result<Vec<FlatEntry>, ProviderError> {
        let items_range = format!("1:{}", limit.max(1));
        let output = Command::new("yt-dlp")
            .args([
                "--flat-playlist",
                "--dump-json",
                "--no-warnings",
                "--skip-download",
                "--playlist-items",
                &items_range,
                list_spec,
            ])
            .output()
            .await
            .map_err(|e| ProviderError::Unavailable(e.to_string()))?;

        if !output.status.success() {
            return Err(ProviderError::Upstream(String::from_utf8_lossy(&output.stderr).into_owned()));
        }

        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| serde_json::from_str::<FlatEntry>(line).ok())
            .collect())
    }
}

#[derive(Deserialize)]
struct FlatEntry {
    id: String,
    title: String,
    #[serde(default)]
    uploader: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    channel_id: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
}

#[async_trait]
impl MediaProvider for YtDlpProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn kind(&self) -> ProviderKind {
        ProviderKind::Streaming
    }

    async fn search(&self, query: &SearchQuery) -> Result<Vec<Track>, ProviderError> {
        // --flat-playlist skips per-video metadata extraction so search stays
        // fast; full extraction only happens in resolve(), at play time.
        let search_spec = format!("ytsearch{}:{}", query.limit.max(1), query.text);
        let entries = self.flat_playlist(&search_spec, query.limit).await?;
        Ok(entries.into_iter().map(|e| self.track_from_entry(e)).collect())
    }

    async fn resolve(&self, source_ref: &str) -> Result<String, ProviderError> {
        let url = format!("https://www.youtube.com/watch?v={source_ref}");
        let output = Command::new("yt-dlp")
            .args(["-f", "bestaudio", "-g", "--no-warnings", &url])
            .output()
            .await
            .map_err(|e| ProviderError::Unavailable(e.to_string()))?;

        if !output.status.success() {
            return Err(ProviderError::Upstream(String::from_utf8_lossy(&output.stderr).into_owned()));
        }

        String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .map(|s| s.to_string())
            .ok_or(ProviderError::NotFound)
    }

    async fn browse(&self, limit: usize) -> Result<Vec<Track>, ProviderError> {
        let topic = SEED_TOPICS.choose(&mut rand::thread_rng()).copied().unwrap_or("music");
        self.search(&SearchQuery { text: topic.to_string(), limit }).await
    }

    /// Rides YouTube's own "mix"/radio continuation playlist (the same one
    /// the YouTube UI builds when you click "Radio" or auto-play), rather
    /// than inventing our own similarity logic.
    async fn radio(&self, source_ref: &str, limit: usize) -> Result<Vec<Track>, ProviderError> {
        let mix_url = format!("https://www.youtube.com/watch?v={source_ref}&list=RD{source_ref}");
        // Fetch one extra since the seed track itself usually comes back as
        // the first entry and gets filtered out below.
        let entries = self.flat_playlist(&mix_url, limit + 1).await?;
        Ok(entries
            .into_iter()
            .filter(|e| e.id != source_ref)
            .take(limit)
            .map(|e| self.track_from_entry(e))
            .collect())
    }

    /// A channel's "Videos" tab, standing in for "more from this artist" —
    /// the real, reliable thing yt-dlp can give us (unlike albums).
    async fn artist_tracks(&self, artist_ref: &str, limit: usize) -> Result<Vec<Track>, ProviderError> {
        let channel_url = format!("https://www.youtube.com/channel/{artist_ref}/videos");
        let entries = self.flat_playlist(&channel_url, limit).await?;
        Ok(entries
            .into_iter()
            .map(|e| {
                // Entries from a channel's own listing omit channel/channel_id
                // (it's implicit) — fill it back in since we already know it.
                let mut track = self.track_from_entry(e);
                if track.artist_ref.is_none() {
                    track.artist_ref = Some(artist_ref.to_string());
                }
                track
            })
            .collect())
    }
}
