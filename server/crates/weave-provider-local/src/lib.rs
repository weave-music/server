//! Simplest possible provider: serves audio files already sitting on disk.
//! Tag/metadata extraction (artist, album, duration) is not wired up yet —
//! tracks are currently derived from filename only. Swap in proper tag
//! reading (e.g. via `symphonia` or `lofty`) before this leaves the MVP.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use uuid::Uuid;
use walkdir::WalkDir;
use weave_core::{Artist, MediaProvider, ProviderError, ProviderKind, SearchQuery, Track, TrackSource};

const AUDIO_EXTENSIONS: &[&str] = &["flac", "mp3", "ogg", "opus", "m4a", "wav"];

pub struct LocalFilesystemProvider {
    id: String,
    root: PathBuf,
}

impl LocalFilesystemProvider {
    pub fn new(id: impl Into<String>, root: impl Into<PathBuf>) -> Self {
        Self { id: id.into(), root: root.into() }
    }

    fn is_audio_file(path: &Path) -> bool {
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| AUDIO_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
            .unwrap_or(false)
    }
}

#[async_trait]
impl MediaProvider for LocalFilesystemProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn kind(&self) -> ProviderKind {
        ProviderKind::Download
    }

    async fn search(&self, query: &SearchQuery) -> Result<Vec<Track>, ProviderError> {
        let needle = query.text.to_lowercase();
        let placeholder_artist = Uuid::nil();

        let matches = WalkDir::new(&self.root)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .filter(|entry| Self::is_audio_file(entry.path()))
            .filter(|entry| {
                entry
                    .path()
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_lowercase().contains(&needle))
                    .unwrap_or(false)
            })
            .take(query.limit)
            .map(|entry| {
                let path = entry.path();
                let title = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Unknown")
                    .to_string();
                let is_lossless = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("flac") || e.eq_ignore_ascii_case("wav"))
                    .unwrap_or(false);

                Track {
                    id: Uuid::new_v4(),
                    title,
                    artist_id: placeholder_artist,
                    album_id: None,
                    duration_secs: None,
                    track_number: None,
                    sources: vec![TrackSource {
                        provider_id: self.id.clone(),
                        source_ref: path.to_string_lossy().into_owned(),
                        bitrate_kbps: None,
                        is_lossless,
                        is_local: true,
                    }],
                }
            })
            .collect();

        Ok(matches)
    }

    async fn resolve(&self, source_ref: &str) -> Result<String, ProviderError> {
        let path = Path::new(source_ref);
        if path.exists() {
            Ok(source_ref.to_string())
        } else {
            Err(ProviderError::NotFound)
        }
    }
}

/// Placeholder until tag-based artist resolution exists.
pub fn unknown_artist() -> Artist {
    Artist { id: Uuid::nil(), name: "Unknown Artist".to_string(), musicbrainz_id: None }
}
