export interface TrackSource {
  provider_id: string;
  source_ref: string;
  is_local: boolean;
  is_lossless: boolean;
}

export interface Track {
  id: string;
  title: string;
  duration_secs: number | null;
  sources: TrackSource[];
  artwork_url: string | null;
  artist_name: string | null;
  // Present only when the owning provider supports browsing more from this
  // artist (today: yt-dlp tracks, via YouTube channel id).
  artist_ref: string | null;
  album_name: string | null;
  // Present only when the owning provider supports browsing this album
  // (today: local files via the containing folder, or yt-dlp tracks that
  // came from album_tracks/a YouTube Music release).
  album_ref: string | null;
}

// A lightweight album/single card on an artist page — not a full Track list,
// just enough to show a card and open it via fetchAlbumTracks.
export interface ReleaseSummary {
  id: string;
  title: string;
  artwork_url: string | null;
  year: string | null;
  is_single: boolean;
}

// A playlist search result (today: YouTube Music, via searchExternalPlaylists)
// — not a full Track list, just enough to show a card and open it via
// fetchPlaylistTracks. provider_id travels with each result since playlist
// search spans every provider at once, unlike ReleaseSummary which is always
// browsed within an already-known provider.
export interface ExternalPlaylist {
  id: string;
  provider_id: string;
  title: string;
  artwork_url: string | null;
  track_count: number | null;
}
