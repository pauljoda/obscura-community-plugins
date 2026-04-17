#!/usr/bin/env python3
"""
MusicBrainz plugin for Obscura.

Identifies music metadata (albums, artists, tracks) using:
- MusicBrainz WS/2 JSON API for search and release lookup
- Cover Art Archive for release cover images

Capabilities:
- audioLibraryByName:  search for an album / release by name
- audioByFragment:     identify a single track from title + artist + optional album
- audioByURL:          resolve a musicbrainz.org release or recording URL
- supportsBatch:       batch fan-out for mass library matching

Emits the NormalizedAudioLibraryResult / NormalizedAudioTrackResult
shapes Obscura's scrape-accept service reads. Legacy flat keys are
preserved for existing identify-row consumers.
"""

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


MB_API_BASE = "https://musicbrainz.org/ws/2"
COVERART_BASE = "https://coverartarchive.org"
USER_AGENT = "Obscura/0.2 (https://github.com/pauljoda/obscura)"

# MusicBrainz asks clients to stay below 1 req/s to avoid a block.
# A 1.05 s floor gives us a safety margin while keeping batch mode
# usable for libraries of a few hundred tracks.
MIN_REQUEST_INTERVAL_SEC = 1.05
_last_request_at = 0.0


def _throttle():
    global _last_request_at
    now = time.monotonic()
    elapsed = now - _last_request_at
    if elapsed < MIN_REQUEST_INTERVAL_SEC:
        time.sleep(MIN_REQUEST_INTERVAL_SEC - elapsed)
    _last_request_at = time.monotonic()


def _http_json(url: str, timeout: float = 10.0):
    """GET + JSON-decode with MusicBrainz-appropriate rate limiting and
    one retry on 503 (MB's "too busy" response)."""
    _throttle()
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 503:
            time.sleep(2.0)
            _throttle()
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        if e.code == 404:
            return None
        raise


def _quote_term(t: str) -> str:
    """Lucene-quote a search term so spaces + punctuation stay together."""
    cleaned = t.replace('"', "").strip()
    return f'"{cleaned}"' if cleaned else ""


def _cover_art_urls(release_mbid: str):
    """Return cover-art candidates for a release without hitting the API
    if the image doesn't exist. The coverartarchive.org `/release/<id>`
    endpoint returns a JSON manifest we can turn into candidates."""
    if not release_mbid:
        return []
    try:
        data = _http_json(f"{COVERART_BASE}/release/{release_mbid}")
    except Exception:
        data = None
    if not data or not isinstance(data, dict):
        return []

    out = []
    for img in data.get("images", []) or []:
        url = img.get("image")
        if not url:
            continue
        thumbs = img.get("thumbnails", {}) or {}
        # Rank front covers highest so the default pick in the drawer
        # is the album art rather than a back / liner / booklet scan.
        rank = 10 if img.get("front") else 4
        out.append(
            {
                "url": url,
                "source": "coverartarchive",
                "rank": rank,
                "thumbUrl": thumbs.get("500") or thumbs.get("large"),
            }
        )
    return sorted(out, key=lambda c: c["rank"], reverse=True)


def _artist_credit(credits) -> str:
    if not isinstance(credits, list):
        return ""
    names = []
    for ac in credits:
        name = ac.get("name") or ac.get("artist", {}).get("name")
        if name:
            names.append(name)
    return ", ".join(names)


def _primary_release(releases):
    """Pick the release most likely to be the canonical album: prefer
    `release-group.primary-type == Album`, then oldest `date`."""
    if not releases:
        return None
    albums = [
        r for r in releases
        if (r.get("release-group") or {}).get("primary-type") == "Album"
    ]
    pool = albums or releases
    with_date = [r for r in pool if r.get("date")]
    if with_date:
        with_date.sort(key=lambda r: r.get("date") or "9999")
        return with_date[0]
    return pool[0]


# ─── Search actions ─────────────────────────────────────────────────


def search_release(query: str, artist_hint: str = ""):
    """Search for an album by title (and optional artist)."""
    parts = [f"release:{_quote_term(query)}"]
    if artist_hint:
        parts.append(f"artist:{_quote_term(artist_hint)}")
    q = " AND ".join(p for p in parts if p and not p.endswith(":"))
    if not q:
        return None

    params = urllib.parse.urlencode({"query": q, "fmt": "json", "limit": 5})
    url = f"{MB_API_BASE}/release/?{params}"
    data = _http_json(url)
    if not data:
        return None

    releases = data.get("releases", [])
    if not releases:
        return None

    best = releases[0]
    mbid = best.get("id")
    artist = _artist_credit(best.get("artist-credit"))

    # Pull the full release to get genres/tags + track-list length.
    details = _http_json(
        f"{MB_API_BASE}/release/{mbid}?inc=tags+genres+labels+release-groups&fmt=json"
    ) if mbid else None

    genres = []
    if details:
        for g in (details.get("genres") or []):
            name = g.get("name")
            if name:
                genres.append(name)
        # Fall back to tags when genres are empty — smaller releases
        # often only have tags.
        if not genres:
            for t in (details.get("tags") or []):
                name = t.get("name")
                if name and int(t.get("count") or 0) >= 1:
                    genres.append(name)

    label = None
    for li in (details.get("label-info") or []) if details else []:
        name = (li.get("label") or {}).get("name")
        if name:
            label = name
            break

    release_group = (details or best).get("release-group") or {}
    release_url = f"https://musicbrainz.org/release/{mbid}" if mbid else None

    covers = _cover_art_urls(mbid)
    image_url = covers[0]["url"] if covers else None

    return {
        # NormalizedAudioLibraryResult-shaped keys
        "name": best.get("title"),
        "artist": artist or None,
        "details": release_group.get("disambiguation") or best.get("disambiguation") or None,
        "date": best.get("date") or release_group.get("first-release-date") or None,
        "imageUrl": image_url,
        "posterCandidates": covers,
        "urls": [u for u in [release_url] if u],
        "tagNames": genres,
        "trackCount": best.get("track-count"),
        "label": label,
        "externalIds": {"musicbrainz": mbid} if mbid else {},
    }


def search_recording(title: str, artist: str = "", album: str = ""):
    """Identify a single recording (track). Optional artist/album hints
    dramatically improve scoring on generic titles."""
    parts = [f"recording:{_quote_term(title)}"]
    if artist:
        parts.append(f"artist:{_quote_term(artist)}")
    if album:
        parts.append(f"release:{_quote_term(album)}")
    q = " AND ".join(p for p in parts if p and not p.endswith(":"))
    if not q:
        return None

    params = urllib.parse.urlencode({"query": q, "fmt": "json", "limit": 5})
    url = f"{MB_API_BASE}/recording/?{params}"
    data = _http_json(url)
    if not data:
        return None

    recordings = data.get("recordings", [])
    if not recordings:
        return None

    best = recordings[0]
    artist_name = _artist_credit(best.get("artist-credit"))
    release = _primary_release(best.get("releases"))
    album_title = release.get("title") if release else None
    album_mbid = release.get("id") if release else None
    release_date = release.get("date") if release else None

    # Length is in milliseconds on /recording/.
    length_ms = best.get("length")
    runtime_sec = int(length_ms / 1000) if isinstance(length_ms, int) else None

    # Track number — MB puts it inside `releases[].media[].track[].number`
    # but the compact /recording/ response doesn't include it. We'd need
    # an extra release lookup to get it reliably; skip for now.
    track_number = None

    covers = _cover_art_urls(album_mbid) if album_mbid else []
    image_url = covers[0]["url"] if covers else None

    recording_url = (
        f"https://musicbrainz.org/recording/{best.get('id')}"
        if best.get("id")
        else None
    )
    urls = [u for u in [recording_url] if u]
    if album_mbid:
        urls.append(f"https://musicbrainz.org/release/{album_mbid}")

    return {
        # NormalizedAudioTrackResult-shaped keys
        "title": best.get("title"),
        "artist": artist_name or None,
        "album": album_title,
        "trackNumber": track_number,
        "date": release_date,
        "runtime": runtime_sec,
        "details": best.get("disambiguation") or None,
        "imageUrl": image_url,
        "posterCandidates": covers,
        "urls": urls,
        "tagNames": [],
        "externalIds": {"musicbrainz": best.get("id")} if best.get("id") else {},
    }


# ─── URL parsing ────────────────────────────────────────────────────

_MB_URL_RE = re.compile(
    r"musicbrainz\.org/(release|recording|release-group)/"
    r"([0-9a-f-]{36})",
    re.IGNORECASE,
)


def _lookup_by_url(url: str):
    m = _MB_URL_RE.search(url or "")
    if not m:
        return None
    kind = m.group(1).lower()
    mbid = m.group(2).lower()

    if kind == "release":
        data = _http_json(
            f"{MB_API_BASE}/release/{mbid}"
            "?inc=artist-credits+tags+genres+labels+release-groups&fmt=json"
        )
        if not data:
            return None
        # Fabricate a "releases" list entry so search_release can reuse
        # its formatter — cheaper than duplicating.
        return _release_to_library(data)

    if kind == "recording":
        data = _http_json(
            f"{MB_API_BASE}/recording/{mbid}?inc=artist-credits+releases&fmt=json"
        )
        if not data:
            return None
        return _recording_to_track(data)

    if kind == "release-group":
        # Walk the release group and pick its earliest release.
        data = _http_json(
            f"{MB_API_BASE}/release-group/{mbid}"
            "?inc=releases+artist-credits+tags+genres&fmt=json"
        )
        if not data:
            return None
        releases = data.get("releases") or []
        if not releases:
            return None
        best = _primary_release(releases)
        if not best:
            return None
        return _lookup_by_url(f"https://musicbrainz.org/release/{best.get('id')}")

    return None


def _release_to_library(release):
    mbid = release.get("id")
    artist = _artist_credit(release.get("artist-credit"))
    genres = [g.get("name") for g in (release.get("genres") or []) if g.get("name")]
    if not genres:
        genres = [t.get("name") for t in (release.get("tags") or []) if t.get("name")]
    release_group = release.get("release-group") or {}
    covers = _cover_art_urls(mbid) if mbid else []
    image_url = covers[0]["url"] if covers else None
    label = None
    for li in (release.get("label-info") or []):
        name = (li.get("label") or {}).get("name")
        if name:
            label = name
            break
    return {
        "name": release.get("title"),
        "artist": artist or None,
        "details": release.get("disambiguation")
        or release_group.get("disambiguation")
        or None,
        "date": release.get("date") or release_group.get("first-release-date") or None,
        "imageUrl": image_url,
        "posterCandidates": covers,
        "urls": [f"https://musicbrainz.org/release/{mbid}"] if mbid else [],
        "tagNames": genres,
        "trackCount": None,
        "label": label,
        "externalIds": {"musicbrainz": mbid} if mbid else {},
    }


def _recording_to_track(recording):
    artist = _artist_credit(recording.get("artist-credit"))
    release = _primary_release(recording.get("releases"))
    album_title = release.get("title") if release else None
    album_mbid = release.get("id") if release else None
    release_date = release.get("date") if release else None
    length_ms = recording.get("length")
    runtime_sec = int(length_ms / 1000) if isinstance(length_ms, int) else None
    covers = _cover_art_urls(album_mbid) if album_mbid else []
    image_url = covers[0]["url"] if covers else None
    recording_url = (
        f"https://musicbrainz.org/recording/{recording.get('id')}"
        if recording.get("id")
        else None
    )
    urls = [u for u in [recording_url] if u]
    if album_mbid:
        urls.append(f"https://musicbrainz.org/release/{album_mbid}")
    return {
        "title": recording.get("title"),
        "artist": artist or None,
        "album": album_title,
        "trackNumber": None,
        "date": release_date,
        "runtime": runtime_sec,
        "details": recording.get("disambiguation") or None,
        "imageUrl": image_url,
        "posterCandidates": covers,
        "urls": urls,
        "tagNames": [],
        "externalIds": {"musicbrainz": recording.get("id")}
        if recording.get("id")
        else {},
    }


# ─── Dispatch ───────────────────────────────────────────────────────


def dispatch(action: str, input_data: dict):
    if action == "audioLibraryByName":
        name = input_data.get("name") or input_data.get("title") or ""
        artist = input_data.get("artist") or ""
        if not name:
            return None
        return search_release(name, artist)

    if action == "audioByFragment":
        title = input_data.get("title") or ""
        artist = input_data.get("artist") or ""
        album = input_data.get("album") or ""
        if not title:
            return None
        return search_recording(title, artist, album)

    if action == "audioByURL":
        url = input_data.get("url") or ""
        if not url:
            return None
        return _lookup_by_url(url)

    return None


def main():
    try:
        raw = sys.stdin.read()
        envelope = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "error": f"bad envelope: {e}"}))
        return

    action = envelope.get("action", "")
    batch = envelope.get("batch")

    try:
        if isinstance(batch, list) and batch:
            results = []
            for item in batch:
                item_id = item.get("id")
                try:
                    results.append(
                        {"id": item_id, "result": dispatch(action, item.get("input") or {})}
                    )
                except Exception as e:
                    # Per-item failure shouldn't abort the whole batch —
                    # the executor aggregates successes alongside nulls.
                    sys.stderr.write(f"item {item_id} failed: {e}\n")
                    results.append({"id": item_id, "result": None})
            print(json.dumps({"ok": True, "results": results}))
            return

        result = dispatch(action, envelope.get("input") or {})
        print(json.dumps({"ok": True, "result": result}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))


if __name__ == "__main__":
    main()
