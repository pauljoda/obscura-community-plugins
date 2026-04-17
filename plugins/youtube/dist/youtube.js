"use strict";
/**
 * YouTube Plugin for Obscura
 *
 * Fetches metadata for YouTube videos by URL, by search, and in
 * batch via the YouTube Data API v3.
 *
 * Capabilities:
 * - videoByURL / audioByURL: resolve a YouTube URL to a single video
 * - videoByName: search YouTube by title and return the top-ranked hit
 * - supportsBatch: accept up to 50 URLs in a single `/videos` call
 */
Object.defineProperty(exports, "__esModule", { value: true });
const YT_API = "https://www.googleapis.com/youtube/v3";
const YT_THUMB_BASE = "https://i.ytimg.com/vi";
// ─── Helpers ──────────────────────────────────────────────────────
/**
 * Extract a YouTube video id from any of the common URL shapes.
 * Accepts:
 *   https://youtu.be/<id>
 *   https://www.youtube.com/watch?v=<id>
 *   https://www.youtube.com/embed/<id>
 *   https://www.youtube.com/shorts/<id>
 *   https://www.youtube.com/live/<id>
 *   https://music.youtube.com/watch?v=<id>
 */
function extractVideoId(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, "");
        if (host === "youtu.be") {
            const seg = u.pathname.replace(/^\//, "").split("/")[0];
            return isValidId(seg) ? seg : null;
        }
        if (host === "youtube.com" ||
            host === "m.youtube.com" ||
            host === "music.youtube.com") {
            const v = u.searchParams.get("v");
            if (v && isValidId(v))
                return v;
            const m = u.pathname.match(/\/(embed|shorts|live|v)\/([a-zA-Z0-9_-]{11})/);
            if (m)
                return m[2];
        }
        return null;
    }
    catch {
        // Fall back to bare id (some callers pass `dQw4w9WgXcQ` alone).
        return isValidId(url) ? url : null;
    }
}
function isValidId(s) {
    return /^[a-zA-Z0-9_-]{11}$/.test(s);
}
/**
 * Parse an ISO-8601 duration like `PT4H13M24S` into whole seconds.
 * YouTube omits zero components (`PT5M` = 5 minutes, no seconds).
 */
function parseIsoDurationToSeconds(iso) {
    if (!iso)
        return null;
    const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
    if (!m)
        return null;
    const h = m[1] ? Number.parseInt(m[1], 10) : 0;
    const mm = m[2] ? Number.parseInt(m[2], 10) : 0;
    const s = m[3] ? Number.parseInt(m[3], 10) : 0;
    const total = h * 3600 + mm * 60 + s;
    return Number.isFinite(total) && total > 0 ? total : null;
}
/**
 * Build the thumbnail candidate list. YouTube's JSON exposes a few
 * named sizes; plus we synthesize the static `hqdefault` / `maxresdefault`
 * URLs so the picker always has something even if the snippet list is
 * empty.
 */
function thumbCandidates(video) {
    const t = video.snippet.thumbnails;
    const out = [];
    const push = (entry, rank) => {
        if (!entry?.url)
            return;
        if (out.some((c) => c.url === entry.url))
            return;
        out.push({
            url: entry.url,
            source: "youtube",
            rank,
            width: entry.width,
            height: entry.height,
            aspectRatio: entry.width && entry.height && entry.height > 0
                ? entry.width / entry.height
                : undefined,
        });
    };
    push(t.maxres, 10);
    push(t.standard, 8);
    push(t.high, 6);
    push(t.medium, 4);
    push(t.default, 2);
    // Fallback static URLs — these always exist for public videos even
    // if the snippet lacks the higher-res entries.
    const staticFallback = (variant, rank) => {
        const url = `${YT_THUMB_BASE}/${video.id}/${variant}.jpg`;
        if (!out.some((c) => c.url === url)) {
            out.push({ url, source: "youtube", rank });
        }
    };
    staticFallback("maxresdefault", 9);
    staticFallback("hqdefault", 5);
    return out.sort((a, b) => b.rank - a.rank);
}
function bestThumbUrl(video) {
    const t = video.snippet.thumbnails;
    return (t.maxres?.url ??
        t.standard?.url ??
        t.high?.url ??
        t.medium?.url ??
        t.default?.url ??
        `${YT_THUMB_BASE}/${video.id}/hqdefault.jpg`);
}
function videoUrl(id) {
    return `https://www.youtube.com/watch?v=${id}`;
}
async function ytFetch(path, apiKey, params) {
    const url = new URL(`${YT_API}${path}`);
    url.searchParams.set("key", apiKey);
    for (const [k, v] of Object.entries(params))
        url.searchParams.set(k, v);
    const res = await fetch(url.toString());
    if (!res.ok) {
        // Pull the quotaExceeded / keyInvalid reason out of the error
        // body so identify-row errors tell the user what to fix.
        let detail = `${res.status} ${res.statusText}`;
        try {
            const body = (await res.json());
            const reason = body.error?.errors?.[0]?.reason;
            if (body.error?.message)
                detail += ` — ${body.error.message}`;
            if (reason)
                detail += ` (${reason})`;
        }
        catch {
            // non-JSON body; keep the status line
        }
        throw new Error(`YouTube API error: ${detail}`);
    }
    return res.json();
}
// ─── Result builders ──────────────────────────────────────────────
function videoToResult(video) {
    const date = video.snippet.publishedAt
        ? video.snippet.publishedAt.slice(0, 10)
        : null;
    const description = video.snippet.description?.slice(0, 4000) ?? null;
    const tags = video.snippet.tags?.slice(0, 30) ?? [];
    const runtime = parseIsoDurationToSeconds(video.contentDetails?.duration);
    const thumbs = thumbCandidates(video);
    return {
        // New normalized movie-shaped keys (the identify pipeline treats
        // YouTube clips as single videos). The accept-scrape service reads
        // posterCandidates/backdropCandidates/externalIds from this shape.
        title: video.snippet.title,
        originalTitle: null,
        overview: description,
        tagline: null,
        releaseDate: date,
        runtime,
        genres: [],
        studioName: video.snippet.channelTitle ?? null,
        cast: [],
        posterCandidates: thumbs,
        backdropCandidates: thumbs,
        externalIds: { youtube: video.id },
        // Legacy flat keys (identify row + rawResult consumers)
        date,
        details: description,
        urls: [videoUrl(video.id)],
        performerNames: [],
        tagNames: tags,
        imageUrl: bestThumbUrl(video),
        episodeNumber: null,
        series: null,
        code: null,
        director: null,
    };
}
// ─── Actions ──────────────────────────────────────────────────────
async function videoByURL(input, apiKey) {
    const url = input.url ?? "";
    const id = extractVideoId(url);
    if (!id)
        return null;
    return videoById(id, apiKey);
}
async function videoByName(input, apiKey) {
    const q = (input.name ?? input.title ?? "").trim();
    if (!q)
        return null;
    const search = await ytFetch(`/search`, apiKey, {
        part: "snippet",
        q,
        type: "video",
        maxResults: "5",
        safeSearch: "none",
    });
    const firstWithId = (search.items ?? []).find((it) => it.id?.videoId);
    if (!firstWithId?.id.videoId)
        return null;
    return videoById(firstWithId.id.videoId, apiKey);
}
async function videoById(id, apiKey) {
    const data = await ytFetch(`/videos`, apiKey, {
        id,
        part: "snippet,contentDetails,statistics",
    });
    const video = data.items?.[0];
    if (!video)
        return null;
    return videoToResult(video);
}
async function videoBatchByURL(items, apiKey) {
    // Resolve every input URL to a video id. Items with no extractable
    // id pass through as null without costing a quota unit.
    const idByItem = new Map();
    for (const item of items) {
        const url = item.input.url ?? "";
        idByItem.set(item.id, extractVideoId(url));
    }
    const ids = [...new Set([...idByItem.values()].filter((v) => Boolean(v)))];
    const byYouTubeId = new Map();
    // YouTube /videos accepts up to 50 comma-separated ids per call.
    for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const data = await ytFetch(`/videos`, apiKey, {
            id: chunk.join(","),
            part: "snippet,contentDetails,statistics",
        });
        for (const v of data.items ?? [])
            byYouTubeId.set(v.id, v);
    }
    return items.map((item) => {
        const ytId = idByItem.get(item.id) ?? null;
        if (!ytId)
            return { id: item.id, result: null };
        const video = byYouTubeId.get(ytId);
        return { id: item.id, result: video ? videoToResult(video) : null };
    });
}
// ─── Plugin export ────────────────────────────────────────────────
exports.default = {
    capabilities: {
        videoByURL: true,
        videoByName: true,
        audioByURL: true,
        supportsBatch: true,
    },
    async execute(action, input, auth) {
        const apiKey = auth.YOUTUBE_API_KEY;
        if (!apiKey)
            throw new Error("YOUTUBE_API_KEY is required");
        switch (action) {
            case "videoByURL":
            case "audioByURL":
                return videoByURL(input, apiKey);
            case "videoByName":
                return videoByName(input, apiKey);
            default:
                return null;
        }
    },
    async executeBatch(action, items, auth) {
        const apiKey = auth.YOUTUBE_API_KEY;
        if (!apiKey)
            throw new Error("YOUTUBE_API_KEY is required");
        if (action === "videoByURL" || action === "audioByURL") {
            return videoBatchByURL(items, apiKey);
        }
        // Fan out per-item for actions that don't have a native bulk form
        // (e.g. videoByName — YouTube's /search doesn't take batched queries).
        const out = [];
        for (const item of items) {
            try {
                const result = await this.execute(action, item.input, auth);
                out.push({ id: item.id, result });
            }
            catch {
                out.push({ id: item.id, result: null });
            }
        }
        return out;
    },
};
