#!/usr/bin/env python3
"""Thin JSON bridge to ytmusicapi, run as a long-lived subprocess by
weave-provider-ytdlp (which keeps a small pool of these alive rather than
spawning one per call — interpreter startup + ytmusicapi session setup is
the dominant cost of a single call otherwise).

yt-dlp's generic page scraping can't see YouTube Music's actual artist/album
catalog (no reliable Albums/Singles structure — confirmed across four
extraction approaches), and generic YouTube video search surfaces mixes,
livestreams and compilations rather than individual songs. This talks to the
same internal API the YouTube Music web client itself uses, via ytmusicapi,
for both.

Protocol: one JSON object per line on stdin, `{"command": ..., "args": [...]}`
(mirrors the old argv-based invocation); one JSON object per line on stdout,
`{"ok": true, "data": ...}` or `{"ok": false, "error": "..."}`.
"""
import json
import sys

from ytmusicapi import YTMusic

_yt = None


def get_yt():
    global _yt
    if _yt is None:
        _yt = YTMusic()
    return _yt


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
    results = get_yt().search(query, filter="songs", limit=int(limit))
    return {"songs": [song_entry(r) for r in results]}


def cmd_artist(channel_id):
    artist = get_yt().get_artist(channel_id)

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

    return {
        "songs": songs,
        "releases": releases("albums", False) + releases("singles", True),
        # The artist's own profile photo — distinct from any song's
        # thumbnail, which `tracks[0]?.artwork_url` was standing in
        # for before (and often didn't match what search had shown
        # for the same artist, since that came from a different
        # track entirely).
        "artist_artwork_url": best_thumbnail(artist.get("thumbnails")),
    }


def playlist_entry(r):
    count = r.get("itemCount")
    try:
        count = int(count) if count is not None else None
    except (TypeError, ValueError):
        count = None
    return {
        "id": r.get("playlistId") or r.get("browseId"),
        "title": r.get("title"),
        "artwork_url": best_thumbnail(r.get("thumbnails")),
        "track_count": count,
    }


def cmd_playlists(query, limit):
    results = get_yt().search(query, filter="playlists", limit=int(limit))
    return {"playlists": [playlist_entry(r) for r in results if r.get("playlistId") or r.get("browseId")]}


def cmd_playlist(playlist_id, limit):
    playlist = get_yt().get_playlist(playlist_id, limit=int(limit))
    playlist_artwork = best_thumbnail(playlist.get("thumbnails"))

    tracks = []
    for t in playlist.get("tracks", []):
        # Unavailable/private videos still show up as entries with no videoId.
        if not t.get("videoId"):
            continue
        name, ref = artist_name_and_ref(t.get("artists"))
        album = t.get("album") or {}
        tracks.append(
            {
                "video_id": t.get("videoId"),
                "title": t.get("title"),
                "artist_name": name,
                "artist_ref": ref,
                "album_name": album.get("name"),
                "album_ref": album.get("id"),
                "duration_secs": t.get("duration_seconds"),
                "artwork_url": best_thumbnail(t.get("thumbnails")) or playlist_artwork,
            }
        )

    return {"title": playlist.get("title"), "artwork_url": playlist_artwork, "tracks": tracks}


def cmd_album(browse_id):
    album = get_yt().get_album(browse_id)
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

    return {"title": album.get("title"), "artwork_url": artwork_url, "tracks": tracks}


def cmd_lyrics(video_id):
    # Lyrics aren't looked up by video id directly — get_watch_playlist
    # returns a "lyrics" browseId for this video, which get_lyrics then
    # resolves to the actual text. Either step can come back empty (no
    # lyrics available for this track), which is a normal result, not
    # an error.
    watch = get_yt().get_watch_playlist(video_id)
    browse_id = watch.get("lyrics")
    if not browse_id:
        return {"lyrics": None}
    data = get_yt().get_lyrics(browse_id)
    return {"lyrics": data.get("lyrics") if data else None}


COMMANDS = {
    "songs": lambda args: cmd_songs(args[0], args[1] if len(args) > 1 else 25),
    "artist": lambda args: cmd_artist(args[0]),
    "album": lambda args: cmd_album(args[0]),
    "playlists": lambda args: cmd_playlists(args[0], args[1] if len(args) > 1 else 25),
    "playlist": lambda args: cmd_playlist(args[0], args[1] if len(args) > 1 else 300),
    "lyrics": lambda args: cmd_lyrics(args[0]),
}


def dispatch(command, args):
    handler = COMMANDS.get(command)
    if handler is None:
        raise ValueError(f"unknown command: {command}")
    return handler(args)


def main():
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            data = dispatch(request["command"], request.get("args", []))
            print(json.dumps({"ok": True, "data": data}), flush=True)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
