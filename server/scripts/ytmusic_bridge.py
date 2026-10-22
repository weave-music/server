#!/usr/bin/env python3
"""Thin JSON bridge to ytmusicapi, invoked as a subprocess by weave-provider-ytdlp.

yt-dlp's generic page scraping can't see YouTube Music's actual artist/album
catalog (no reliable Albums/Singles structure — confirmed across four
extraction approaches). This talks to the same internal API the YouTube
Music web client itself uses, via ytmusicapi.
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


def cmd_artist(channel_id):
    yt = YTMusic()
    artist = yt.get_artist(channel_id)

    songs = []
    for s in (artist.get("songs") or {}).get("results", []):
        name, ref = artist_name_and_ref(s.get("artists"))
        songs.append(
            {
                "video_id": s.get("videoId"),
                "title": s.get("title"),
                "artist_name": name,
                "artist_ref": ref,
                "artwork_url": best_thumbnail(s.get("thumbnails")),
            }
        )

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
        print(json.dumps({"error": "usage: ytmusic_bridge.py <artist|album> <id>"}), file=sys.stderr)
        sys.exit(1)
    command, arg = sys.argv[1], sys.argv[2]
    try:
        if command == "artist":
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
