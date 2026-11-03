//! A thin, read-only client for MusicBrainz's public lookup API
//! (https://musicbrainz.org/ws/2/). Used internally to resolve a canonical
//! artist/album/recording for a liked track before matching it against
//! Lidarr's own (also MusicBrainz-backed) catalog — YT Music titles are
//! often decorated ("Song Title (Official Video)"), so raw string matching
//! against Lidarr's album list would miss or mis-match without this.
//!
//! Not a `MediaProvider` — like `lidarr.rs`, this has no playable tracks of
//! its own, just metadata.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sqlx::SqlitePool;

const USER_AGENT: &str = "Weave/0.1 ( https://github.com/weave-music/server )";
// MusicBrainz's API policy asks anonymous/unauthenticated clients to stay
// at roughly one request per second.
const MIN_INTERVAL: Duration = Duration::from_millis(1100);

#[derive(Clone)]
pub struct MbRecording {
    pub recording_mbid: Option<String>,
    pub artist_mbid: Option<String>,
    pub release_group_mbid: Option<String>,
    pub canonical_artist: Option<String>,
    pub canonical_title: Option<String>,
    pub canonical_album: Option<String>,
}

/// Reserves the next allowed request slot without holding the lock across
/// an `.await` — compute-then-sleep, not lock-then-sleep.
async fn rate_limit(last_call: &Arc<Mutex<Instant>>) {
    let wait = {
        let mut last = last_call.lock().unwrap();
        let now = Instant::now();
        let elapsed = now.duration_since(*last);
        let wait = MIN_INTERVAL.saturating_sub(elapsed);
        *last = now + wait;
        wait
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}

fn query_key(artist: &str, title: &str) -> String {
    format!("{}::{}", artist.trim().to_lowercase(), title.trim().to_lowercase())
}

async fn read_cache(db: &SqlitePool, key: &str) -> Option<MbRecording> {
    sqlx::query_as::<_, (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)>(
        "SELECT recording_mbid, artist_mbid, release_group_mbid, canonical_artist, canonical_title, canonical_album \
         FROM musicbrainz_cache WHERE query_key = ?",
    )
    .bind(key)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .map(|(recording_mbid, artist_mbid, release_group_mbid, canonical_artist, canonical_title, canonical_album)| {
        MbRecording { recording_mbid, artist_mbid, release_group_mbid, canonical_artist, canonical_title, canonical_album }
    })
}

async fn write_cache(db: &SqlitePool, key: &str, rec: &MbRecording) {
    let _ = sqlx::query(
        "INSERT OR REPLACE INTO musicbrainz_cache \
         (query_key, recording_mbid, artist_mbid, release_group_mbid, canonical_artist, canonical_title, canonical_album) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(key)
    .bind(&rec.recording_mbid)
    .bind(&rec.artist_mbid)
    .bind(&rec.release_group_mbid)
    .bind(&rec.canonical_artist)
    .bind(&rec.canonical_title)
    .bind(&rec.canonical_album)
    .execute(db)
    .await;
}

/// Best-effort recording lookup by artist + title. `None` means either
/// nothing matched or the request failed — callers should fall back to
/// whatever raw metadata they already had, not treat this as fatal.
pub async fn lookup_recording(
    db: &SqlitePool,
    http: &reqwest::Client,
    rate_limiter: &Arc<Mutex<Instant>>,
    artist: &str,
    title: &str,
) -> Option<MbRecording> {
    if artist.trim().is_empty() || title.trim().is_empty() {
        return None;
    }
    let key = query_key(artist, title);
    if let Some(cached) = read_cache(db, &key).await {
        return Some(cached);
    }

    rate_limit(rate_limiter).await;

    let query = format!("artist:\"{}\" AND recording:\"{}\"", artist.replace('"', ""), title.replace('"', ""));
    let res = http
        .get("https://musicbrainz.org/ws/2/recording/")
        .header("User-Agent", USER_AGENT)
        .query(&[("query", query.as_str()), ("fmt", "json"), ("limit", "1")])
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let body: serde_json::Value = res.json().await.ok()?;
    let recording = body.get("recordings")?.as_array()?.first()?;

    let recording_mbid = recording.get("id").and_then(|v| v.as_str()).map(str::to_string);
    let canonical_title = recording.get("title").and_then(|v| v.as_str()).map(str::to_string);

    let artist_credit = recording.get("artist-credit").and_then(|v| v.as_array()).and_then(|a| a.first());
    let artist_mbid = artist_credit.and_then(|ac| ac.get("artist")).and_then(|a| a.get("id")).and_then(|v| v.as_str()).map(str::to_string);
    let canonical_artist = artist_credit.and_then(|ac| ac.get("name")).and_then(|v| v.as_str()).map(str::to_string);

    let release = recording.get("releases").and_then(|v| v.as_array()).and_then(|r| r.first());
    let canonical_album = release.and_then(|r| r.get("title")).and_then(|v| v.as_str()).map(str::to_string);
    let release_group_mbid = release
        .and_then(|r| r.get("release-group"))
        .and_then(|rg| rg.get("id"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let rec = MbRecording { recording_mbid, artist_mbid, release_group_mbid, canonical_artist, canonical_title, canonical_album };
    write_cache(db, &key, &rec).await;
    Some(rec)
}
