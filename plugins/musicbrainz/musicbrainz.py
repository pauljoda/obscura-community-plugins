#!/usr/bin/env python3
"""
MusicBrainz Plugin for Obscura

Identifies music metadata (albums, artists, tracks) via the MusicBrainz API.
Supports: audioLibraryByName, audioByFragment
"""

import json
import sys
import urllib.request
import urllib.parse
import time

MB_API_BASE = "https://musicbrainz.org/ws/2"
USER_AGENT = "Obscura/0.1 (https://github.com/pauljoda/obscura)"


def search_release(query: str):
    """Search for an album/release by name."""
    params = urllib.parse.urlencode({
        "query": query,
        "fmt": "json",
        "limit": 5,
    })
    url = f"{MB_API_BASE}/release/?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            releases = data.get("releases", [])
            if not releases:
                return None

            best = releases[0]
            artists = [ac.get("artist", {}).get("name", "")
                       for ac in best.get("artist-credit", [])]
            artist = ", ".join(a for a in artists if a)

            return {
                "name": best.get("title"),
                "artist": artist or None,
                "details": None,
                "date": best.get("date"),
                "imageUrl": None,
                "urls": [f"https://musicbrainz.org/release/{best.get('id')}"],
                "tagNames": [],
                "trackCount": best.get("track-count"),
            }
    except Exception:
        return None


def search_recording(query: str):
    """Search for a track/recording by name."""
    params = urllib.parse.urlencode({
        "query": query,
        "fmt": "json",
        "limit": 5,
    })
    url = f"{MB_API_BASE}/recording/?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            recordings = data.get("recordings", [])
            if not recordings:
                return None

            best = recordings[0]
            artists = [ac.get("artist", {}).get("name", "")
                       for ac in best.get("artist-credit", [])]
            artist = ", ".join(a for a in artists if a)

            # Try to get album from first release
            releases = best.get("releases", [])
            album = releases[0].get("title") if releases else None

            return {
                "title": best.get("title"),
                "artist": artist or None,
                "album": album,
                "trackNumber": None,
                "date": releases[0].get("date") if releases else None,
                "details": None,
                "imageUrl": None,
                "urls": [f"https://musicbrainz.org/recording/{best.get('id')}"],
                "tagNames": [],
            }
    except Exception:
        return None


def main():
    raw = sys.stdin.read()
    envelope = json.loads(raw)

    action = envelope.get("action", "")
    input_data = envelope.get("input", {})

    result = None

    if action == "audioLibraryByName":
        name = input_data.get("name") or input_data.get("title") or ""
        if name:
            result = search_release(name)

    elif action == "audioByFragment":
        title = input_data.get("title") or ""
        artist = input_data.get("artist") or ""
        query = f"{title} {artist}".strip()
        if query:
            result = search_recording(query)

    output = {"ok": True, "result": result}
    print(json.dumps(output))


if __name__ == "__main__":
    main()
