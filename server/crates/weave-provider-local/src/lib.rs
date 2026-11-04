//! Serves audio files already sitting on disk. Metadata (artist, album,
//! track number, duration, lossless-ness) is read from embedded tags via
//! `lofty` and cached in `local_tag_cache` (see `refresh_tag_cache`) rather
//! than parsed on every request — falls back to filename/folder guessing
//! for any file that hasn't been scanned yet (or has no useful tags), so a
//! freshly-added file is never fully broken, just less descriptive until
//! the next background scan catches up.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use rand::seq::SliceRandom;
use sqlx::SqlitePool;
use uuid::Uuid;
use walkdir::WalkDir;
use weave_core::{MediaProvider, ProviderError, ProviderKind, SearchQuery, Track, TrackSource};

const AUDIO_EXTENSIONS: &[&str] = &["flac", "mp3", "ogg", "opus", "m4a", "wav"];

struct CachedTags {
    title: Option<String>,
    artist_name: Option<String>,
    album_name: Option<String>,
    track_number: Option<u32>,
    duration_secs: Option<u32>,
    is_lossless: bool,
    has_artwork: bool,
}

pub struct LocalFilesystemProvider {
    id: String,
    root: PathBuf,
    db: SqlitePool,
}

impl LocalFilesystemProvider {
    pub fn new(id: impl Into<String>, root: impl Into<PathBuf>, db: SqlitePool) -> Self {
        Self { id: id.into(), root: root.into(), db }
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

    /// Whole-table fetch rather than a per-path `WHERE ... IN (...)` — at
    /// self-hosted scale a full `local_tag_cache` read is still a fast
    /// single query, and it keeps every call site (search, which needs to
    /// match against the whole library's tags, not just a pre-filtered
    /// subset) simple.
    async fn all_cached_tags(&self) -> HashMap<PathBuf, CachedTags> {
        let rows: Vec<(String, Option<String>, Option<String>, Option<String>, Option<i64>, Option<i64>, bool, bool)> = sqlx::query_as(
            "SELECT path, title, artist_name, album_name, track_number, duration_secs, is_lossless, (artwork IS NOT NULL) AS has_artwork \
             FROM local_tag_cache",
        )
        .fetch_all(&self.db)
        .await
        .unwrap_or_default();

        rows.into_iter()
            .map(|(path, title, artist_name, album_name, track_number, duration_secs, is_lossless, has_artwork)| {
                (
                    PathBuf::from(path),
                    CachedTags {
                        title,
                        artist_name,
                        album_name,
                        track_number: track_number.map(|n| n as u32),
                        duration_secs: duration_secs.map(|d| d as u32),
                        is_lossless,
                        has_artwork,
                    },
                )
            })
            .collect()
    }

    fn track_from_path(&self, path: &Path, cached: Option<&CachedTags>) -> Track {
        let filename_title = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Unknown").to_string();
        let (folder_album_name, album_ref) = self.album_info(path);
        let extension_is_lossless = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("flac") || e.eq_ignore_ascii_case("wav"))
            .unwrap_or(false);

        let title = cached.and_then(|c| c.title.clone()).filter(|t| !t.is_empty()).unwrap_or(filename_title);
        let artist_name = cached.and_then(|c| c.artist_name.clone()).filter(|a| !a.is_empty());
        let album_name = cached.and_then(|c| c.album_name.clone()).filter(|a| !a.is_empty()).or(folder_album_name);
        let is_lossless = cached.map(|c| c.is_lossless).unwrap_or(extension_is_lossless);
        // The artist name itself is the only stable key available — there's
        // no browseId concept for local files. `artist_tracks` normalizes
        // (trim + lowercase) when matching this back.
        let artist_ref = artist_name.clone();
        let artwork_url = if cached.map(|c| c.has_artwork).unwrap_or(false) {
            let encoded_ref: String = url::form_urlencoded::byte_serialize(path.to_string_lossy().as_bytes()).collect();
            Some(format!("/api/library/local-artwork?ref={encoded_ref}"))
        } else {
            None
        };

        Track {
            id: Uuid::new_v4(),
            title,
            duration_secs: cached.and_then(|c| c.duration_secs),
            track_number: cached.and_then(|c| c.track_number),
            sources: vec![TrackSource {
                provider_id: self.id.clone(),
                source_ref: path.to_string_lossy().into_owned(),
                bitrate_kbps: None,
                is_lossless,
                is_local: true,
            }],
            artwork_url,
            artist_name,
            artist_ref,
            album_name,
            album_ref,
            download_status: None,
        }
    }

    /// Reads a single file's tags via lofty. `None` on anything that fails
    /// to open/parse — the caller just leaves that file out of the cache
    /// update, so it keeps falling back to the filename/folder guess (and
    /// gets retried on the next scan) rather than the whole scan failing.
    #[allow(clippy::type_complexity)]
    fn parse_tags(
        path: &Path,
    ) -> Option<(Option<String>, Option<String>, Option<String>, Option<i64>, Option<i64>, bool, Option<(Vec<u8>, String)>)> {
        use lofty::file::{AudioFile, FileType, TaggedFileExt};
        use lofty::picture::PictureType;
        use lofty::prelude::Accessor;
        use lofty::probe::Probe;

        let tagged = Probe::open(path).ok()?.read().ok()?;
        let file_type = tagged.file_type();
        let tag = tagged.primary_tag().or_else(|| tagged.first_tag());

        let title = tag.and_then(|t| t.title()).map(|c| c.to_string()).filter(|s| !s.is_empty());
        let artist_name = tag.and_then(|t| t.artist()).map(|c| c.to_string()).filter(|s| !s.is_empty());
        let album_name = tag.and_then(|t| t.album()).map(|c| c.to_string()).filter(|s| !s.is_empty());
        let track_number = tag.and_then(|t| t.track()).map(|n| n as i64);
        let duration_secs = Some(tagged.properties().duration().as_secs() as i64);
        // FileType has no distinct ALAC variant (ALAC-in-.m4a and AAC-in-.m4a
        // are both `FileType::Mp4`) — defaults to lossy for Mp4 since AAC is
        // the far more common case in practice.
        let is_lossless = matches!(file_type, FileType::Flac | FileType::Wav | FileType::WavPack | FileType::Ape | FileType::Aiff);
        let artwork = tag
            .and_then(|t| t.get_picture_type(PictureType::CoverFront).or_else(|| t.pictures().first()))
            .map(|pic| (pic.data().to_vec(), pic.mime_type().map(|m| m.as_str().to_string()).unwrap_or_else(|| "image/jpeg".to_string())));

        Some((title, artist_name, album_name, track_number, duration_secs, is_lossless, artwork))
    }

    /// Walks the library, re-parsing tags only for files that are new or
    /// whose mtime/size changed since the last scan, and drops cache rows
    /// for files that no longer exist. All blocking file I/O (the walk,
    /// stat calls, lofty parsing) happens inside one `spawn_blocking`
    /// closure rather than one task per file.
    pub async fn refresh_tag_cache(&self) {
        let known: HashMap<PathBuf, (i64, i64)> =
            sqlx::query_as::<_, (String, i64, i64)>("SELECT path, mtime, size FROM local_tag_cache")
                .fetch_all(&self.db)
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|(path, mtime, size)| (PathBuf::from(path), (mtime, size)))
                .collect();

        let root = self.root.clone();
        let scan = tokio::task::spawn_blocking(move || {
            let current_paths: Vec<PathBuf> = WalkDir::new(&root)
                .into_iter()
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.into_path())
                .filter(|path| Self::is_audio_file(path))
                .collect();

            let mut current_set = std::collections::HashSet::with_capacity(current_paths.len());
            let mut changed = Vec::new();

            for path in &current_paths {
                current_set.insert(path.clone());

                let Ok(meta) = std::fs::metadata(path) else { continue };
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                let size = meta.len() as i64;

                if known.get(path) == Some(&(mtime, size)) {
                    continue;
                }
                let Some((title, artist_name, album_name, track_number, duration_secs, is_lossless, artwork)) = Self::parse_tags(path) else {
                    continue;
                };
                let (artwork_bytes, artwork_mime) = match artwork {
                    Some((bytes, mime)) => (Some(bytes), Some(mime)),
                    None => (None, None),
                };
                changed.push((
                    path.to_string_lossy().into_owned(),
                    mtime,
                    size,
                    title,
                    artist_name,
                    album_name,
                    track_number,
                    duration_secs,
                    is_lossless,
                    artwork_bytes,
                    artwork_mime,
                ));
            }

            let gone: Vec<String> =
                known.keys().filter(|path| !current_set.contains(*path)).map(|path| path.to_string_lossy().into_owned()).collect();

            (changed, gone)
        })
        .await;

        let Ok((changed, gone)) = scan else { return };

        for (path, mtime, size, title, artist_name, album_name, track_number, duration_secs, is_lossless, artwork_bytes, artwork_mime) in changed {
            let _ = sqlx::query(
                "INSERT OR REPLACE INTO local_tag_cache \
                 (path, mtime, size, title, artist_name, album_name, track_number, duration_secs, is_lossless, artwork, artwork_mime, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))",
            )
            .bind(path)
            .bind(mtime)
            .bind(size)
            .bind(title)
            .bind(artist_name)
            .bind(album_name)
            .bind(track_number)
            .bind(duration_secs)
            .bind(is_lossless)
            .bind(artwork_bytes)
            .bind(artwork_mime)
            .execute(&self.db)
            .await;
        }
        for path in gone {
            let _ = sqlx::query("DELETE FROM local_tag_cache WHERE path = ?").bind(path).execute(&self.db).await;
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
        let cache = self.all_cached_tags().await;

        let matches = self
            .all_audio_paths()
            .into_iter()
            .filter(|path| {
                let cached = cache.get(path);
                let title_matches = cached
                    .and_then(|c| c.title.as_deref())
                    .map(|t| t.to_lowercase().contains(&needle))
                    .unwrap_or_else(|| {
                        path.file_stem().and_then(|s| s.to_str()).map(|s| s.to_lowercase().contains(&needle)).unwrap_or(false)
                    });
                let artist_matches = cached.and_then(|c| c.artist_name.as_deref()).map(|a| a.to_lowercase().contains(&needle)).unwrap_or(false);
                // Also match on the album (folder/tag) name, not just the
                // title — otherwise searching an album's title only
                // surfaces it when a track happens to share that text.
                let album_matches = cached
                    .and_then(|c| c.album_name.as_deref())
                    .map(|a| a.to_lowercase().contains(&needle))
                    .unwrap_or_else(|| self.album_info(path).0.map(|a| a.to_lowercase().contains(&needle)).unwrap_or(false));
                title_matches || artist_matches || album_matches
            })
            .take(query.limit)
            .map(|path| self.track_from_path(&path, cache.get(&path)))
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
        paths.truncate(limit);
        let cache = self.all_cached_tags().await;
        Ok(paths.iter().map(|path| self.track_from_path(path, cache.get(path))).collect())
    }

    /// No genre/similarity data yet, so "radio" here is just a random sample
    /// of the rest of the library — good enough to keep a queue going.
    async fn radio(&self, source_ref: &str, limit: usize) -> Result<Vec<Track>, ProviderError> {
        let mut paths: Vec<_> =
            self.all_audio_paths().into_iter().filter(|p| p.to_string_lossy() != source_ref).collect();
        paths.shuffle(&mut rand::thread_rng());
        paths.truncate(limit);
        let cache = self.all_cached_tags().await;
        Ok(paths.iter().map(|path| self.track_from_path(path, cache.get(path))).collect())
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

        let cache = self.all_cached_tags().await;
        let mut tracks: Vec<Track> = entries.iter().map(|path| self.track_from_path(path, cache.get(path))).collect();
        // Real track-number tags take priority; untagged tracks keep their
        // filename-sorted relative order (stable sort) instead of being
        // shuffled arbitrarily to the end.
        tracks.sort_by_key(|t| t.track_number.unwrap_or(u32::MAX));
        tracks.truncate(limit);
        Ok(tracks)
    }

    /// `artist_ref` is just the artist name itself (`track_from_path` sets
    /// it to the same value as `artist_name` — no browseId concept exists
    /// for local files), normalized here for matching so minor casing/
    /// whitespace differences across files still group together.
    async fn artist_tracks(&self, artist_ref: &str, limit: usize) -> Result<Vec<Track>, ProviderError> {
        let needle = artist_ref.trim().to_lowercase();
        let paths = self.all_audio_paths();
        let cache = self.all_cached_tags().await;

        let matches = paths
            .into_iter()
            .filter(|path| {
                cache.get(path).and_then(|c| c.artist_name.as_deref()).map(|a| a.trim().to_lowercase() == needle).unwrap_or(false)
            })
            .take(limit)
            .map(|path| self.track_from_path(&path, cache.get(&path)))
            .collect();

        Ok(matches)
    }
}
