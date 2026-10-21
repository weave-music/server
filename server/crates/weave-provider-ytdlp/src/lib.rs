//! Streaming provider backed by the `yt-dlp` CLI. Deliberately shells out
//! rather than scraping YouTube ourselves — yt-dlp's extractors are
//! maintained upstream and already handle the cat-and-mouse with YouTube.
//! Requires a `yt-dlp` binary on PATH (see docker/Dockerfile).

use async_trait::async_trait;
use serde::Deserialize;
use tokio::process::Command;
use uuid::Uuid;
use weave_core::{MediaProvider, ProviderError, ProviderKind, SearchQuery, Track, TrackSource};

pub struct YtDlpProvider {
    id: String,
}

impl YtDlpProvider {
    pub fn new(id: impl Into<String>) -> Self {
        Self { id: id.into() }
    }
}

#[derive(Deserialize)]
struct FlatEntry {
    id: String,
    title: String,
    #[serde(default)]
    uploader: Option<String>,
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
        let output = Command::new("yt-dlp")
            .args(["--flat-playlist", "--dump-json", "--no-warnings", "--skip-download", &search_spec])
            .output()
            .await
            .map_err(|e| ProviderError::Unavailable(e.to_string()))?;

        if !output.status.success() {
            return Err(ProviderError::Upstream(String::from_utf8_lossy(&output.stderr).into_owned()));
        }

        let placeholder_artist = Uuid::nil();
        let tracks = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| serde_json::from_str::<FlatEntry>(line).ok())
            .map(|entry| Track {
                id: Uuid::new_v4(),
                title: match &entry.uploader {
                    Some(uploader) => format!("{} \u{2014} {}", entry.title, uploader),
                    None => entry.title,
                },
                artist_id: placeholder_artist,
                album_id: None,
                duration_secs: entry.duration.map(|d| d as u32),
                track_number: None,
                sources: vec![TrackSource {
                    provider_id: self.id.clone(),
                    source_ref: entry.id,
                    bitrate_kbps: None,
                    is_lossless: false,
                    is_local: false,
                }],
            })
            .collect();

        Ok(tracks)
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
}
