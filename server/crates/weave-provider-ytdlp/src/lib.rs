//! Streaming provider backed by the `yt-dlp` CLI, plus `ytmusic_bridge.py`
//! (a thin wrapper around `ytmusicapi`) for the things yt-dlp's generic page
//! scraping can't see: an artist's real "top songs" ranking and their actual
//! Albums/Singles catalog, via YouTube Music's own internal API. Deliberately
//! shells out to both rather than reimplementing extraction — yt-dlp's
//! extractors are maintained upstream, and ytmusicapi already speaks the
//! internal protocol correctly. Requires `yt-dlp` and `ytmusic_bridge.py` on
//! PATH (see docker/Dockerfile).

use async_trait::async_trait;
use rand::seq::SliceRandom;
use serde::Deserialize;
use tokio::process::Command;
use uuid::Uuid;
use weave_core::{MediaProvider, ProviderError, ProviderKind, ReleaseSummary, SearchQuery, Track, TrackSource};

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
            // Plain search results don't carry album info — an individual
            // video doesn't know which (if any) YT Music release it belongs
            // to without an extra per-track lookup, which isn't worth doing
            // for a whole page of search results. Real album data is
            // available via artist_releases()/album_tracks() instead.
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

    /// Runs `ytmusic_bridge.py <command> <arg>` and parses its JSON stdout.
    async fn run_bridge<T: serde::de::DeserializeOwned>(&self, command: &str, arg: &str) -> Result<T, ProviderError> {
        let output = Command::new("ytmusic_bridge.py")
            .args([command, arg])
            .output()
            .await
            .map_err(|e| ProviderError::Unavailable(e.to_string()))?;

        if !output.status.success() {
            return Err(ProviderError::Upstream(String::from_utf8_lossy(&output.stderr).into_owned()));
        }

        serde_json::from_slice(&output.stdout).map_err(|e| ProviderError::Upstream(e.to_string()))
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
    artwork_url: Option<String>,
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

    /// An artist's real "top songs" ranking via YouTube Music, falling back
    /// to their channel's raw video uploads if they have no YT Music profile
    /// (e.g. a non-musical channel).
    async fn artist_tracks(&self, artist_ref: &str, limit: usize) -> Result<Vec<Track>, ProviderError> {
        match self.run_bridge::<BridgeArtistResponse>("artist", artist_ref).await {
            Ok(data) => Ok(data
                .songs
                .into_iter()
                .filter_map(|s| s.video_id.clone().map(|id| (id, s)))
                .take(limit)
                .map(|(video_id, s)| Track {
                    id: Uuid::new_v4(),
                    title: s.title,
                    duration_secs: None,
                    track_number: None,
                    sources: vec![TrackSource {
                        provider_id: self.id.clone(),
                        source_ref: video_id.clone(),
                        bitrate_kbps: None,
                        is_lossless: false,
                        is_local: false,
                    }],
                    artwork_url: s
                        .artwork_url
                        .or_else(|| Some(format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"))),
                    artist_name: s.artist_name,
                    artist_ref: s.artist_ref.or_else(|| Some(artist_ref.to_string())),
                    album_name: None,
                    album_ref: None,
                })
                .collect()),
            Err(_) => self.artist_channel_videos(artist_ref, limit).await,
        }
    }

    /// A real album/single tracklist via YouTube Music (`album_ref` is a
    /// YT Music browseId, as returned by `artist_releases`).
    async fn album_tracks(&self, album_ref: &str, limit: usize) -> Result<Vec<Track>, ProviderError> {
        let data: BridgeAlbumResponse = self.run_bridge("album", album_ref).await?;
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

    /// An artist's real Albums/Singles catalog via YouTube Music.
    async fn artist_releases(&self, artist_ref: &str) -> Result<Vec<ReleaseSummary>, ProviderError> {
        let data: BridgeArtistResponse = self.run_bridge("artist", artist_ref).await?;
        Ok(data
            .releases
            .into_iter()
            .map(|r| ReleaseSummary {
                id: r.id,
                title: r.title,
                artwork_url: r.artwork_url,
                year: r.year,
                is_single: r.is_single,
            })
            .collect())
    }
}
