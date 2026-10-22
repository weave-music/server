import { useCallback, useState } from "react";
import type { Track } from "./types";

const STORAGE_KEY = "weave.history.v1";
const MAX_ENTRIES = 50;

interface HistoryEntry {
  track: Track;
  playedAt: number;
}

function load(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// No server-side play-history table yet, so "what have you been listening
// to" lives in the browser for now, same stopgap as playlists. Only tracks
// with an artist_name (currently: yt-dlp tracks) can seed a "similar
// artist" row — local files have no artist metadata yet.
export function useListeningHistory() {
  const [version, setVersion] = useState(0);
  const recordPlay = useCallback((track: Track) => {
    const entries = load().filter(
      (e) => !(e.track.sources[0]?.source_ref === track.sources[0]?.source_ref),
    );
    entries.unshift({ track, playedAt: Date.now() });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
    setVersion((v) => v + 1);
  }, []);

  const getRecentTracks = useCallback((limit: number): Track[] => {
    return load()
      .slice(0, limit)
      .map((e) => e.track);
  }, []);

  const getRecentArtists = useCallback((limit: number): { artist: string; track: Track }[] => {
    const seen = new Set<string>();
    const result: { artist: string; track: Track }[] = [];
    for (const entry of load()) {
      const artist = entry.track.artist_name;
      if (!artist || seen.has(artist)) continue;
      seen.add(artist);
      result.push({ artist, track: entry.track });
      if (result.length >= limit) break;
    }
    return result;
  }, []);

  return { recordPlay, getRecentTracks, getRecentArtists, version };
}
