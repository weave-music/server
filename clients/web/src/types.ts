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
  // (today: local files, via the containing folder).
  album_ref: string | null;
}
