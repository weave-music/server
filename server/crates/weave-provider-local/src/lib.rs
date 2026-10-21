//! Simplest possible provider: serves audio files already sitting on disk.
//! Tag/metadata extraction (artist, album, duration) is not wired up yet —
//! tracks are derived from filename and folder structure only. Swap in
//! proper tag reading (e.g. via `symphonia` or `lofty`) before this leaves
//! the MVP.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use rand::seq::SliceRandom;
use uuid::Uuid;
use walkdir::WalkDir;
use weave_core::{MediaProvider, ProviderError, ProviderKind, SearchQuery, Track, TrackSource};

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

    fn all_audio_paths(&self) -> Vec<PathBuf> {
        WalkDir::new(&self.root)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.into_path())
            .filter(|path| Self::is_audio_file(path))
            .collect()
    }

    /// The containing folder, treated as the "album" — a real, reliable
    /// signal for anyone who organizes their library as Artist/Album/Track
    /// (common convention), unlike YouTube, which has no equivalent. Tracks
    /// sitting directly in the library root have no meaningful album folder,
    /// so they get none rather than a fake "album" named after the root.
    fn album_info(&self, path: &Path) -> (Option<String>, Option<String>) {
        match path.parent() {
            Some(parent) if parent != self.root => {
                let name = parent.file_name().and_then(|n| n.to_str()).map(str::to_string);
                (name, Some(parent.to_string_lossy().into_owned()))
            }
            _ => (None, None),
        }
    }

    fn track_from_path(&self, path: &Path) -> Track {
        let title = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Unknown").to_string();
        let is_lossless = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("flac") || e.eq_ignore_ascii_case("wav"))
            .unwrap_or(false);
        let (album_name, album_ref) = self.album_info(path);

        Track {
            id: Uuid::new_v4(),
            title,
            duration_secs: None,
            track_number: None,
            sources: vec![TrackSource {
                provider_id: self.id.clone(),
                source_ref: path.to_string_lossy().into_owned(),
                bitrate_kbps: None,
                is_lossless,
                is_local: true,
            }],
            artwork_url: None,
            // No reliable artist convention to assume (unlike album-by-folder,
            // a lot of local libraries aren't organized as Artist/Album).
            artist_name: None,
            artist_ref: None,
            album_name,
            album_ref,
        }
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

        let matches = self
            .all_audio_paths()
            .into_iter()
            .filter(|path| {
                let title_matches = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_lowercase().contains(&needle))
                    .unwrap_or(false);
                // Also match on the album (folder) name, not just the
                // filename — otherwise searching an album's title only
                // surfaces it when a track happens to share that text.
                let album_matches = self
                    .album_info(path)
                    .0
                    .map(|album| album.to_lowercase().contains(&needle))
                    .unwrap_or(false);
                title_matches || album_matches
            })
            .take(query.limit)
            .map(|path| self.track_from_path(&path))
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

    async fn browse(&self, limit: usize) -> Result<Vec<Track>, ProviderError> {
        let mut paths = self.all_audio_paths();
        paths.shuffle(&mut rand::thread_rng());
        Ok(paths.into_iter().take(limit).map(|path| self.track_from_path(&path)).collect())
    }

    /// No genre/similarity data yet, so "radio" here is just a random sample
    /// of the rest of the library — good enough to keep a queue going.
    async fn radio(&self, source_ref: &str, limit: usize) -> Result<Vec<Track>, ProviderError> {
        let mut paths: Vec<_> =
            self.all_audio_paths().into_iter().filter(|p| p.to_string_lossy() != source_ref).collect();
        paths.shuffle(&mut rand::thread_rng());
        Ok(paths.into_iter().take(limit).map(|path| self.track_from_path(&path)).collect())
    }

    async fn album_tracks(&self, album_ref: &str, limit: usize) -> Result<Vec<Track>, ProviderError> {
        let dir = Path::new(album_ref);
        if !dir.is_dir() {
            return Err(ProviderError::NotFound);
        }
        let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
            .map_err(|e| ProviderError::Unavailable(e.to_string()))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| Self::is_audio_file(p))
            .collect();
        entries.sort();
        Ok(entries.into_iter().take(limit).map(|path| self.track_from_path(&path)).collect())
    }
}
