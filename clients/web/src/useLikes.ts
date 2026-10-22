import { useCallback, useEffect, useState } from "react";
import { fetchLikes, likeTrack, unlikeTrack } from "./api";
import type { Track } from "./types";

// Track::id is a fresh random uuid every time a track is fetched, so
// identity for "is this liked" has to be the stable (provider, source_ref)
// pair instead — same key a track's TrackSource already carries.
function trackKey(track: Track): string | null {
  const source = track.sources[0];
  return source ? `${source.provider_id}:${source.source_ref}` : null;
}

export function useLikes(token: string | null) {
  const [likedKeys, setLikedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!token) return;
    fetchLikes(token).then((tracks) => {
      setLikedKeys(new Set(tracks.map(trackKey).filter((k): k is string => k !== null)));
    });
  }, [token]);

  const isLiked = useCallback((track: Track) => {
    const key = trackKey(track);
    return key ? likedKeys.has(key) : false;
  }, [likedKeys]);

  const toggleLike = useCallback(
    (track: Track) => {
      if (!token) return;
      const key = trackKey(track);
      if (!key) return;
      const currentlyLiked = likedKeys.has(key);

      // Optimistic update — reverted if the request fails.
      setLikedKeys((prev) => {
        const next = new Set(prev);
        if (currentlyLiked) next.delete(key);
        else next.add(key);
        return next;
      });

      const request = currentlyLiked ? unlikeTrack(token, track) : likeTrack(token, track);
      request.catch(() => {
        setLikedKeys((prev) => {
          const next = new Set(prev);
          if (currentlyLiked) next.add(key);
          else next.delete(key);
          return next;
        });
      });
    },
    [token, likedKeys],
  );

  return { isLiked, toggleLike };
}
