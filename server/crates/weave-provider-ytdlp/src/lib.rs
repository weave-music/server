//! Streaming provider backed by the `yt-dlp` CLI, plus `ytmusic_bridge.py`
//! (a thin wrapper around `ytmusicapi`) for the things yt-dlp's generic page/
//! video search can't do well: real song search (not mixes/livestreams/
//! compilations), an artist's real "top songs" ranking, and their actual
//! Albums/Singles catalog — all via YouTube Music's own internal API.
//! Deliberately shells out to both rather than reimplementing extraction —
//! yt-dlp's extractors are maintained upstream, and ytmusicapi already
//! speaks the internal protocol correctly. Requires `yt-dlp` and
//! `ytmusic_bridge.py` on PATH (see docker/Dockerfile).

use async_trait::async_trait;
use rand::seq::SliceRandom;
use serde::Deserialize;
use sqlx::SqlitePool;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, Semaphore};
use uuid::Uuid;
use weave_core::{
    ArtistProfile, MediaProvider, PlaylistSummary, ProviderError, ProviderKind, ReleaseSummary, SearchQuery, Track,
    TrackSource,
};

// Every call this provider makes is a real round trip to YouTube (via
// yt-dlp or ytmusicapi), typically 1-2 seconds — there's no faster way to
// get that data, but there's also no reason to pay it again for a query
// made recently (e.g. Discover re-fetching the same 10 genre rows on every
// page load, or an artist page warmed in the background while one of their
// tracks plays — see App.tsx). Raw process stdout is cached in the
// `provider_cache` table (migrations/0012) by its exact argv, so every call
// site benefits without needing to know caching exists, and it survives a
// server restart/redeploy rather than resetting every time. The TTL itself
// is admin-configurable (migrations/0013, `/api/settings/cache`) rather
// than fixed, with 0 hours meaning "disabled" — always fetch fresh.
const DEFAULT_CACHE_TTL_HOURS: i64 = 6;

// Sentinel stored in the `provider_cache_ttl_hours` setting for "never
// expire" (distinct from 0, which already means "disabled/always fetch
// fresh"). cache_ttl() maps this to a long-but-finite duration rather than
// Duration::MAX — cache_put()'s sweep multiplies the TTL by 3, and
// SQLite's `datetime('now', '-N seconds')` modifier needs a sane N.
const UNLIMITED_CACHE_TTL_SENTINEL: i64 = -1;
const UNLIMITED_CACHE_TTL: Duration = Duration::from_secs(100 * 365 * 24 * 60 * 60);

// Resolved direct-audio URLs carry their own short-lived expiry on YouTube's
// side; cache them for less than the (admin-configurable, often much longer)
// metadata TTL above so replays are instant without ever serving an expired
// link.
const RESOLVE_CACHE_TTL: Duration = Duration::from_secs(4 * 60 * 60);

// ytmusic_bridge.py pays Python interpreter + ytmusicapi session startup
// cost once per process; keeping a small pool of warm, persistent processes
// around (talked to over stdin/stdout, one request at a time per worker)
// avoids paying that on every uncached call while still bounding how many
// concurrent bridge calls run at once.
const BRIDGE_POOL_SIZE: usize = 3;

/// One persistent `ytmusic_bridge.py` process, communicated with via
/// newline-delimited JSON over its stdin/stdout. Owned exclusively while
/// checked out of the pool, so a single write-then-read pair needs no
/// request-id multiplexing.
struct BridgeWorker {
    // Never read directly — keeping it alive (with `kill_on_drop(true)`) is
    // what makes dropping a worker actually terminate its process.
    #[allow(dead_code)]
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

#[derive(Deserialize)]
struct BridgeEnvelope {
    ok: bool,
    #[serde(default)]
    data: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<String>,
}

impl BridgeWorker {
    async fn spawn() -> Result<Self, ProviderError> {
        let mut child = Command::new("ytmusic_bridge.py")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| ProviderError::Unavailable(e.to_string()))?;
        let stdin = child.stdin.take().ok_or_else(|| ProviderError::Unavailable("bridge process has no stdin".into()))?;
        let stdout = BufReader::new(
            child.stdout.take().ok_or_else(|| ProviderError::Unavailable("bridge process has no stdout".into()))?,
        );
        Ok(Self { child, stdin, stdout })
    }

    async fn request(&mut self, command: &str, args: &[&str]) -> Result<serde_json::Value, ProviderError> {
        let payload = serde_json::json!({ "command": command, "args": args });
        let mut line = serde_json::to_string(&payload).map_err(|e| ProviderError::Upstream(e.to_string()))?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| ProviderError::Unavailable(e.to_string()))?;
        self.stdin.flush().await.map_err(|e| ProviderError::Unavailable(e.to_string()))?;

        let mut response_line = String::new();
        let bytes_read = self
            .stdout
            .read_line(&mut response_line)
            .await
            .map_err(|e| ProviderError::Unavailable(e.to_string()))?;
        if bytes_read == 0 {
            return Err(ProviderError::Unavailable("bridge process closed stdout".into()));
        }

        let envelope: BridgeEnvelope =
            serde_json::from_str(&response_line).map_err(|e| ProviderError::Upstream(e.to_string()))?;
        if envelope.ok {
            Ok(envelope.data.unwrap_or(serde_json::Value::Null))
        } else {
            Err(ProviderError::Upstream(envelope.error.unwrap_or_default()))
        }
    }
}

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
    db: SqlitePool,
    // Bounds how many `ytmusic_bridge.py` processes run concurrently; the
    // idle list holds whichever of them aren't currently handling a request.
    bridge_semaphore: Arc<Semaphore>,
    bridge_idle: Arc<Mutex<Vec<BridgeWorker>>>,
}

impl YtDlpProvider {
    pub fn new(id: impl Into<String>, db: SqlitePool) -> Self {
        Self {
            id: id.into(),
            db,
            bridge_semaphore: Arc::new(Semaphore::new(BRIDGE_POOL_SIZE)),
            bridge_idle: Arc::new(Mutex::new(Vec::new())),
        }
    }

    async fn cache_ttl(&self) -> Duration {
        let hours: i64 = sqlx::query_scalar::<_, String>(
            "SELECT value FROM settings WHERE key = 'provider_cache_ttl_hours'",
        )
        .fetch_optional(&self.db)
        .await
        .ok()
        .flatten()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_CACHE_TTL_HOURS);
        if hours == UNLIMITED_CACHE_TTL_SENTINEL {
            return UNLIMITED_CACHE_TTL;
        }
        Duration::from_secs(hours.max(0) as u64 * 60 * 60)
    }

    /// `ttl_override` lets a caller cache something (e.g. a resolved stream
    /// URL, which expires on YouTube's side well before typical metadata
    /// TTLs) for less time than the admin-configured global default.
    async fn cache_get(&self, key: &str, ttl_override: Option<Duration>) -> Option<Vec<u8>> {
        let ttl = match ttl_override {
            Some(d) => d,
            None => self.cache_ttl().await,
        };
        if ttl.is_zero() {
            return None;
        }
        sqlx::query_scalar::<_, Vec<u8>>(
            "SELECT data FROM provider_cache WHERE cache_key = ? AND inserted_at > datetime('now', ?)",
        )
        .bind(key)
        .bind(format!("-{} seconds", ttl.as_secs()))
        .fetch_optional(&self.db)
        .await
        .ok()
        .flatten()
    }

    // Also sweeps anything well past its TTL on every write, so the table
    // doesn't grow unboundedly over a long-running server process without
    // needing a separate background task just for that.
    async fn cache_put(&self, key: String, data: Vec<u8>, ttl_override: Option<Duration>) {
        let ttl = match ttl_override {
            Some(d) => d,
            None => self.cache_ttl().await,
        };
        if ttl.is_zero() {
            return;
        }
        let _ = sqlx::query("DELETE FROM provider_cache WHERE inserted_at < datetime('now', ?)")
            .bind(format!("-{} seconds", (ttl * 3).as_secs()))
            .execute(&self.db)
            .await;
        let _ = sqlx::query(
            "INSERT OR REPLACE INTO provider_cache (cache_key, data, inserted_at) VALUES (?, ?, datetime('now'))",
        )
        .bind(&key)
        .bind(&data)
        .execute(&self.db)
        .await;
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
            album_name: None,
            album_ref: None,
        }
    }

    /// Converts a normalized `ytmusic_bridge.py` song entry into a `Track`.
    fn track_from_bridge_song(&self, video_id: String, s: BridgeSong) -> Track {
        let artwork_url =
            s.artwork_url.unwrap_or_else(|| format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"));
        Track {
            id: Uuid::new_v4(),
            title: s.title,
            duration_secs: s.duration_secs.map(|d| d as u32),
            track_number: None,
            sources: vec![TrackSource {
                provider_id: self.id.clone(),
                source_ref: video_id,
                bitrate_kbps: None,
                is_lossless: false,
                is_local: false,
            }],
            artwork_url: Some(artwork_url),
            artist_name: s.artist_name,
            artist_ref: s.artist_ref,
            album_name: s.album_name,
            album_ref: s.album_ref,
        }
    }

    /// Runs yt-dlp against a "list spec" (a search spec like `ytsearch5:x`,
    /// a playlist/mix URL, or a channel URL) and parses the flat per-entry
    /// JSON lines, capped at `limit` items via `--playlist-items` so e.g. a
    /// channel listing hundreds of videos doesn't get fetched in full just
    /// to be truncated afterward.
    async fn flat_playlist(&self, list_spec: &str, limit: usize) -> Result<Vec<FlatEntry>, ProviderError> {
        let items_range = format!("1:{}", limit.max(1));
        let cache_key = format!("flat\u{1}{list_spec}\u{1}{items_range}");
        if let Some(cached) = self.cache_get(&cache_key, None).await {
            return Ok(String::from_utf8_lossy(&cached)
                .lines()
                .filter_map(|line| serde_json::from_str::<FlatEntry>(line).ok())
                .collect());
        }

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

        let entries: Vec<FlatEntry> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| serde_json::from_str::<FlatEntry>(line).ok())
            .collect();
        self.cache_put(cache_key, output.stdout, None).await;
        Ok(entries)
    }

    /// Generic YouTube video search — mixes, livestreams, and compilations
    /// included. Only used as a fallback when YT Music's own song search
    /// (see `search()`) errors out or comes back empty for a given query.
    async fn video_search(&self, query: &SearchQuery) -> Result<Vec<Track>, ProviderError> {
        let search_spec = format!("ytsearch{}:{}", query.limit.max(1), query.text);
        let entries = self.flat_playlist(&search_spec, query.limit).await?;
        Ok(entries.into_iter().map(|e| self.track_from_entry(e)).collect())
    }

    /// Sends `{command, args}` to a pooled, persistent `ytmusic_bridge.py`
    /// worker and parses its JSON response. Checks out a worker (spawning
    /// one if none are idle and the pool isn't full yet, blocking briefly
    /// if it is), returns it to the idle list on success, and simply lets
    /// it drop (killing the process, per `kill_on_drop`) on any I/O error
    /// so the next call spawns a fresh one instead of reusing a broken pipe.
    async fn run_bridge<T: serde::de::DeserializeOwned>(&self, args: &[&str]) -> Result<T, ProviderError> {
        let cache_key = format!("bridge\u{1}{}", args.join("\u{1}"));
        if let Some(cached) = self.cache_get(&cache_key, None).await {
            return serde_json::from_slice(&cached).map_err(|e| ProviderError::Upstream(e.to_string()));
        }

        let (&command, rest) = args.split_first().ok_or_else(|| ProviderError::Upstream("missing bridge command".into()))?;

        let _permit = self.bridge_semaphore.acquire().await.map_err(|e| ProviderError::Unavailable(e.to_string()))?;
        let mut worker = match self.bridge_idle.lock().await.pop() {
            Some(worker) => worker,
            None => BridgeWorker::spawn().await?,
        };

        let result = worker.request(command, rest).await;
        if result.is_ok() {
            self.bridge_idle.lock().await.push(worker);
        }
        let value = result?;

        let bytes = serde_json::to_vec(&value).map_err(|e| ProviderError::Upstream(e.to_string()))?;
        self.cache_put(cache_key, bytes.clone(), None).await;
        serde_json::from_slice(&bytes).map_err(|e| ProviderError::Upstream(e.to_string()))
    }

    /// Fallback for artists with no YouTube Music profile: just list the
    /// channel's uploaded videos instead of real "top songs".
    async fn artist_channel_videos(&self, artist_ref: &str, limit: usize) -> Result<Vec<Track>, ProviderError> {
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

#[derive(Deserialize)]
struct BridgeSong {
    video_id: Option<String>,
    title: String,
    artist_name: Option<String>,
    artist_ref: Option<String>,
    album_name: Option<String>,
    album_ref: Option<String>,
    duration_secs: Option<f64>,
    artwork_url: Option<String>,
}

#[derive(Deserialize)]
struct BridgeSongsResponse {
    songs: Vec<BridgeSong>,
}

#[derive(Deserialize)]
struct BridgeRelease {
    id: String,
    title: String,
    artwork_url: Option<String>,
    year: Option<String>,
    is_single: bool,
}

#[derive(Deserialize)]
struct BridgeArtistResponse {
    songs: Vec<BridgeSong>,
    releases: Vec<BridgeRelease>,
    artist_artwork_url: Option<String>,
}

#[derive(Deserialize)]
struct BridgeAlbumTrack {
    video_id: Option<String>,
    title: String,
    artist_name: Option<String>,
    artist_ref: Option<String>,
    track_number: Option<u32>,
    duration_secs: Option<f64>,
    artwork_url: Option<String>,
}

#[derive(Deserialize)]
struct BridgeAlbumResponse {
    title: String,
    tracks: Vec<BridgeAlbumTrack>,
}

#[derive(Deserialize)]
struct BridgePlaylist {
    id: Option<String>,
    title: String,
    artwork_url: Option<String>,
    track_count: Option<u32>,
}

#[derive(Deserialize)]
struct BridgePlaylistsResponse {
    playlists: Vec<BridgePlaylist>,
}

#[derive(Deserialize)]
struct BridgePlaylistTracksResponse {
    tracks: Vec<BridgeSong>,
}

#[async_trait]
impl MediaProvider for YtDlpProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn kind(&self) -> ProviderKind {
        ProviderKind::Streaming
    }

    /// YouTube Music's real song search first — actual named songs by real
    /// artists, not the mixes/livestreams/hour-long compilations generic
    /// YouTube video search tends to surface for genre-style queries. Falls
    /// back to plain video search if YT Music errors out or has nothing.
    async fn search(&self, query: &SearchQuery) -> Result<Vec<Track>, ProviderError> {
        let limit_str = query.limit.max(1).to_string();
        if let Ok(data) =
            self.run_bridge::<BridgeSongsResponse>(&["songs", &query.text, &limit_str]).await
        {
            if !data.songs.is_empty() {
                return Ok(data
                    .songs
                    .into_iter()
                    .filter_map(|s| s.video_id.clone().map(|id| (id, s)))
                    .map(|(video_id, s)| self.track_from_bridge_song(video_id, s))
                    .collect());
            }
        }
        self.video_search(query).await
    }

    async fn resolve(&self, source_ref: &str) -> Result<String, ProviderError> {
        let cache_key = format!("resolve\u{1}{source_ref}");
        if let Some(cached) = self.cache_get(&cache_key, Some(RESOLVE_CACHE_TTL)).await {
            return Ok(String::from_utf8_lossy(&cached).into_owned());
        }

        let url = format!("https://www.youtube.com/watch?v={source_ref}");
        let output = Command::new("yt-dlp")
            .args(["-f", "bestaudio", "-g", "--no-warnings", &url])
            .output()
            .await
            .map_err(|e| ProviderError::Unavailable(e.to_string()))?;

        if !output.status.success() {
            return Err(ProviderError::Upstream(String::from_utf8_lossy(&output.stderr).into_owned()));
        }

        let resolved = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .map(|s| s.to_string())
            .ok_or(ProviderError::NotFound)?;
        self.cache_put(cache_key, resolved.clone().into_bytes(), Some(RESOLVE_CACHE_TTL)).await;
        Ok(resolved)
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

    /// An artist's real "top songs" ranking via YouTube Music, falling back
    /// to their channel's raw video uploads if they have no YT Music profile
    /// (e.g. a non-musical channel).
    async fn artist_tracks(&self, artist_ref: &str, limit: usize) -> Result<Vec<Track>, ProviderError> {
        match self.run_bridge::<BridgeArtistResponse>(&["artist", artist_ref]).await {
            Ok(data) => Ok(data
                .songs
                .into_iter()
                .filter_map(|s| s.video_id.clone().map(|id| (id, s)))
                .take(limit)
                .map(|(video_id, mut s)| {
                    if s.artist_ref.is_none() {
                        s.artist_ref = Some(artist_ref.to_string());
                    }
                    self.track_from_bridge_song(video_id, s)
                })
                .collect()),
            Err(_) => self.artist_channel_videos(artist_ref, limit).await,
        }
    }

    /// A real album/single tracklist via YouTube Music (`album_ref` is a
    /// YT Music browseId, as returned by `artist_releases`).
    async fn album_tracks(&self, album_ref: &str, limit: usize) -> Result<Vec<Track>, ProviderError> {
        let data: BridgeAlbumResponse = self.run_bridge(&["album", album_ref]).await?;
        let album_name = data.title;
        Ok(data
            .tracks
            .into_iter()
            .filter_map(|t| t.video_id.clone().map(|id| (id, t)))
            .take(limit)
            .map(|(video_id, t)| Track {
                id: Uuid::new_v4(),
                title: t.title,
                duration_secs: t.duration_secs.map(|d| d as u32),
                track_number: t.track_number,
                sources: vec![TrackSource {
                    provider_id: self.id.clone(),
                    source_ref: video_id,
                    bitrate_kbps: None,
                    is_lossless: false,
                    is_local: false,
                }],
                artwork_url: t.artwork_url,
                artist_name: t.artist_name,
                artist_ref: t.artist_ref,
                album_name: Some(album_name.clone()),
                album_ref: Some(album_ref.to_string()),
            })
            .collect())
    }

    /// An artist's real Albums/Singles catalog plus their own profile
    /// photo via YouTube Music.
    async fn artist_releases(&self, artist_ref: &str) -> Result<ArtistProfile, ProviderError> {
        let data: BridgeArtistResponse = self.run_bridge(&["artist", artist_ref]).await?;
        Ok(ArtistProfile {
            artwork_url: data.artist_artwork_url,
            releases: data
                .releases
                .into_iter()
                .map(|r| ReleaseSummary {
                    id: r.id,
                    title: r.title,
                    artwork_url: r.artwork_url,
                    year: r.year,
                    is_single: r.is_single,
                })
                .collect(),
        })
    }

    /// Playlist search via YouTube Music's own internal API — same
    /// reasoning as song search: generic YouTube search has no reliable
    /// "this is a playlist" filter, but YT Music's does.
    async fn search_playlists(&self, query: &SearchQuery) -> Result<Vec<PlaylistSummary>, ProviderError> {
        let limit_str = query.limit.max(1).to_string();
        let data: BridgePlaylistsResponse =
            self.run_bridge(&["playlists", &query.text, &limit_str]).await?;
        Ok(data
            .playlists
            .into_iter()
            .filter_map(|p| p.id.clone().map(|id| (id, p)))
            .map(|(id, p)| PlaylistSummary {
                id,
                provider_id: self.id.clone(),
                title: p.title,
                artwork_url: p.artwork_url,
                track_count: p.track_count,
            })
            .collect())
    }

    /// A playlist's tracks via YouTube Music (`playlist_ref` is a YT Music
    /// playlistId, as returned by `search_playlists`).
    async fn playlist_tracks(&self, playlist_ref: &str, limit: usize) -> Result<Vec<Track>, ProviderError> {
        let limit_str = limit.max(1).to_string();
        let data: BridgePlaylistTracksResponse =
            self.run_bridge(&["playlist", playlist_ref, &limit_str]).await?;
        Ok(data
            .tracks
            .into_iter()
            .filter_map(|s| s.video_id.clone().map(|id| (id, s)))
            .take(limit)
            .map(|(video_id, s)| self.track_from_bridge_song(video_id, s))
            .collect())
    }
}
