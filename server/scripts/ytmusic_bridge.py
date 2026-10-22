#!/usr/bin/env python3
"""Thin JSON bridge to ytmusicapi, invoked as a subprocess by weave-provider-ytdlp.

yt-dlp's generic page scraping can't see YouTube Music's actual artist/album
catalog (no reliable Albums/Singles structure — confirmed across four
extraction approaches), and generic YouTube video search surfaces mixes,
livestreams and compilations rather than individual songs. This talks to the
same internal API the YouTube Music web client itself uses, via ytmusicapi,
for both.
"""
import json
import sys

from ytmusicapi import YTMusic


def best_thumbnail(thumbnails):
    if not thumbnails:
        return None
    return max(thumbnails, key=lambda t: t.get("width", 0)).get("url")


def artist_name_and_ref(artists):
    if not artists:
        return None, None
    return artists[0].get("name"), artists[0].get("id")


def song_entry(r):
    """Normalizes a ytmusicapi "song" dict (from search or get_artist) into
    the shape weave-provider-ytdlp expects."""
    name, ref = artist_name_and_ref(r.get("artists"))
    album = r.get("album") or {}
    return {
        "video_id": r.get("videoId"),
        "title": r.get("title"),
        "artist_name": name,
        "artist_ref": ref,
        "album_name": album.get("name"),
        "album_ref": album.get("id"),
        "duration_secs": r.get("duration_seconds"),
        "artwork_url": best_thumbnail(r.get("thumbnails")),
    }


def cmd_songs(query, limit):
    yt = YTMusic()
    results = yt.search(query, filter="songs", limit=int(limit))
    print(json.dumps({"songs": [song_entry(r) for r in results]}))


def cmd_artist(channel_id):
    yt = YTMusic()
    artist = yt.get_artist(channel_id)

    songs = [song_entry(s) for s in (artist.get("songs") or {}).get("results", [])]

    def releases(key, is_single):
        out = []
        for r in (artist.get(key) or {}).get("results", []):
            out.append(
                {
                    "id": r.get("browseId"),
                    "title": r.get("title"),
                    "artwork_url": best_thumbnail(r.get("thumbnails")),
                    "year": r.get("year"),
                    "is_single": is_single,
                }
            )
        return out

    print(json.dumps({"songs": songs, "releases": releases("albums", False) + releases("singles", True)}))


def cmd_album(browse_id):
    yt = YTMusic()
    album = yt.get_album(browse_id)
    artwork_url = best_thumbnail(album.get("thumbnails"))

    tracks = []
    for t in album.get("tracks", []):
        name, ref = artist_name_and_ref(t.get("artists"))
        tracks.append(
            {
                "video_id": t.get("videoId"),
                "title": t.get("title"),
                "artist_name": name,
                "artist_ref": ref,
                "track_number": t.get("trackNumber"),
                "duration_secs": t.get("duration_seconds"),
                "artwork_url": artwork_url,
            }
        )

    print(json.dumps({"title": album.get("title"), "artwork_url": artwork_url, "tracks": tracks}))


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: ytmusic_bridge.py <songs|artist|album> <query|id> [limit]"}), file=sys.stderr)
        sys.exit(1)
    command, arg = sys.argv[1], sys.argv[2]
    try:
        if command == "songs":
            cmd_songs(arg, sys.argv[3] if len(sys.argv) > 3 else 25)
        elif command == "artist":
            cmd_artist(arg)
        elif command == "album":
            cmd_album(arg)
        else:
            raise ValueError(f"unknown command: {command}")
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
