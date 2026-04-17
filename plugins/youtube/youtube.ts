/**
 * YouTube Plugin for Obscura
 *
 * Resolves YouTube video URLs to identify-row metadata.
 *
 * Strategy:
 * - oEmbed (no auth) is the primary path — title, author, thumbnail.
 * - YouTube Data API v3 (optional API key) is a metadata upgrade —
 *   when configured we additionally fetch description, duration, tags,
 *   channel id. The Data API call cost is 1 quota unit per video, so
 *   batches stay cheap. We deliberately do NOT use search.list (100
 *   units, frequently restricted) — title-only search is a poor fit
 *   for YouTube where the user almost always already has a URL.
 *
 * Capabilities: videoByURL, audioByURL, supportsBatch.
 */

const YT_OEMBED = "https://www.youtube.com/oembed";
const YT_API = "https://www.googleapis.com/youtube/v3";
const YT_THUMB_BASE = "https://i.ytimg.com/vi";

// ─── Data API response types ──────────────────────────────────────

interface YTThumbnail {
  url: string;
  width?: number;
  height?: number;
}

interface YTVideoItem {
  id: string;
  snippet: {
    title: string;
    description: string;
    publishedAt: string;
    channelId: string;
    channelTitle: string;
    tags?: string[];
    categoryId?: string;
    thumbnails: {
      maxres?: YTThumbnail;
      standard?: YTThumbnail;
      high?: YTThumbnail;
      medium?: YTThumbnail;
      default?: YTThumbnail;
    };
  };
  contentDetails?: {
    duration?: string;
  };
  statistics?: {
    viewCount?: string;
    likeCount?: string;
  };
}

interface OEmbedResponse {
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  provider_name?: string;
  type?: string;
  html?: string;
}

interface ImageCandidate {
  url: string;
  source: string;
  rank: number;
  width?: number;
  height?: number;
  aspectRatio?: number;
}

// ─── URL parsing ──────────────────────────────────────────────────

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
function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      const seg = u.pathname.replace(/^\//, "").split("/")[0];
      return isValidId(seg) ? seg : null;
    }
    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com"
    ) {
      const v = u.searchParams.get("v");
      if (v && isValidId(v)) return v;

      const m = u.pathname.match(/\/(embed|shorts|live|v)\/([a-zA-Z0-9_-]{11})/);
      if (m) return m[2];
    }
    return null;
  } catch {
    return isValidId(url) ? url : null;
  }
}

function isValidId(s: string): boolean {
  return /^[a-zA-Z0-9_-]{11}$/.test(s);
}

function videoUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * Parse an ISO-8601 duration like `PT4H13M24S` into whole seconds.
 * YouTube omits zero components (`PT5M` = 5 minutes, no seconds).
 */
function parseIsoDurationToSeconds(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const h = m[1] ? Number.parseInt(m[1], 10) : 0;
  const mm = m[2] ? Number.parseInt(m[2], 10) : 0;
  const s = m[3] ? Number.parseInt(m[3], 10) : 0;
  const total = h * 3600 + mm * 60 + s;
  return Number.isFinite(total) && total > 0 ? total : null;
}

// ─── Thumbnail builder ────────────────────────────────────────────

/**
 * Build a candidate list using the static i.ytimg.com URLs every
 * public video has. Used by oEmbed-only callers and as a fallback
 * when the Data API thumbnails dict is sparse.
 */
function staticThumbCandidates(videoId: string): ImageCandidate[] {
  return [
    {
      url: `${YT_THUMB_BASE}/${videoId}/maxresdefault.jpg`,
      source: "youtube",
      rank: 9,
    },
    {
      url: `${YT_THUMB_BASE}/${videoId}/sddefault.jpg`,
      source: "youtube",
      rank: 7,
    },
    {
      url: `${YT_THUMB_BASE}/${videoId}/hqdefault.jpg`,
      source: "youtube",
      rank: 5,
    },
    {
      url: `${YT_THUMB_BASE}/${videoId}/mqdefault.jpg`,
      source: "youtube",
      rank: 3,
    },
  ];
}

function thumbCandidatesFromVideo(video: YTVideoItem): ImageCandidate[] {
  const t = video.snippet.thumbnails;
  const out: ImageCandidate[] = [];
  const push = (entry: YTThumbnail | undefined, rank: number) => {
    if (!entry?.url) return;
    if (out.some((c) => c.url === entry.url)) return;
    out.push({
      url: entry.url,
      source: "youtube",
      rank,
      width: entry.width,
      height: entry.height,
      aspectRatio:
        entry.width && entry.height && entry.height > 0
          ? entry.width / entry.height
          : undefined,
    });
  };
  push(t.maxres, 10);
  push(t.standard, 8);
  push(t.high, 6);
  push(t.medium, 4);
  push(t.default, 2);

  // Always merge the static URLs underneath so the picker has fallbacks
  // if the snippet entry happens to 404 (older videos sometimes do).
  for (const cand of staticThumbCandidates(video.id)) {
    if (!out.some((c) => c.url === cand.url)) out.push(cand);
  }
  return out.sort((a, b) => b.rank - a.rank);
}

// ─── HTTP helpers ─────────────────────────────────────────────────

async function oembedLookup(videoId: string): Promise<OEmbedResponse | null> {
  // oEmbed is unauthenticated and lightweight, but it does 404 for
  // private/age-restricted/unlisted videos. We treat that as "no
  // result" rather than an error so the orchestrator falls through
  // cleanly.
  const url = `${YT_OEMBED}?url=${encodeURIComponent(videoUrl(videoId))}&format=json`;
  const res = await fetch(url);
  if (res.status === 404 || res.status === 401) return null;
  if (!res.ok) {
    throw new Error(`YouTube oEmbed error: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as OEmbedResponse;
}

async function dataApiVideos(
  ids: string[],
  apiKey: string,
): Promise<Map<string, YTVideoItem>> {
  const byId = new Map<string, YTVideoItem>();
  if (!ids.length) return byId;

  // /videos accepts up to 50 comma-separated ids per call (1 quota
  // unit per call regardless of id count). We stay within that.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const url = new URL(`${YT_API}/videos`);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("id", chunk.join(","));
    url.searchParams.set("part", "snippet,contentDetails,statistics");
    const res = await fetch(url.toString());
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as {
          error?: { message?: string; errors?: Array<{ reason?: string }> };
        };
        const reason = body.error?.errors?.[0]?.reason;
        if (body.error?.message) detail += ` — ${body.error.message}`;
        if (reason) detail += ` (${reason})`;
      } catch {
        // non-JSON body; keep status line
      }
      throw new Error(`YouTube API error: ${detail}`);
    }
    const data = (await res.json()) as { items: YTVideoItem[] };
    for (const v of data.items ?? []) byId.set(v.id, v);
  }
  return byId;
}

// ─── Result builders ──────────────────────────────────────────────

function resultFromOembed(
  videoId: string,
  oembed: OEmbedResponse | null,
): Record<string, unknown> {
  const thumbs = oembed?.thumbnail_url
    ? [
        {
          url: oembed.thumbnail_url,
          source: "youtube",
          rank: 8,
          width: oembed.thumbnail_width,
          height: oembed.thumbnail_height,
        } satisfies ImageCandidate,
        ...staticThumbCandidates(videoId),
      ]
    : staticThumbCandidates(videoId);

  // Deduplicate by URL while preserving the first/highest rank.
  const seen = new Set<string>();
  const dedupedThumbs: ImageCandidate[] = [];
  for (const c of thumbs) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    dedupedThumbs.push(c);
  }

  const title = oembed?.title ?? null;
  const channel = oembed?.author_name ?? null;
  const imageUrl = dedupedThumbs[0]?.url ?? null;

  return {
    // Normalized movie-shaped keys
    title,
    originalTitle: null,
    overview: null,
    tagline: null,
    releaseDate: null,
    runtime: null,
    genres: [],
    studioName: channel,
    cast: [],
    posterCandidates: dedupedThumbs,
    backdropCandidates: dedupedThumbs,
    externalIds: { youtube: videoId },

    // Legacy flat keys
    date: null,
    details: null,
    urls: [videoUrl(videoId)],
    performerNames: [],
    tagNames: [],
    imageUrl,
    episodeNumber: null,
    series: null,
    code: null,
    director: null,
  };
}

function resultFromDataApi(video: YTVideoItem): Record<string, unknown> {
  const date = video.snippet.publishedAt
    ? video.snippet.publishedAt.slice(0, 10)
    : null;
  const description = video.snippet.description?.slice(0, 4000) ?? null;
  const tags = video.snippet.tags?.slice(0, 30) ?? [];
  const runtime = parseIsoDurationToSeconds(video.contentDetails?.duration);
  const thumbs = thumbCandidatesFromVideo(video);
  const imageUrl = thumbs[0]?.url ?? null;

  return {
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
    externalIds: { youtube: video.id, youtubeChannel: video.snippet.channelId },

    date,
    details: description,
    urls: [videoUrl(video.id)],
    performerNames: [],
    tagNames: tags,
    imageUrl,
    episodeNumber: null,
    series: null,
    code: null,
    director: null,
  };
}

// ─── Actions ──────────────────────────────────────────────────────

async function videoByURL(
  input: Record<string, unknown>,
  apiKey: string | null,
): Promise<Record<string, unknown> | null> {
  const url = (input.url as string) ?? "";
  const id = extractVideoId(url);
  if (!id) return null;

  if (apiKey) {
    // Data API path — richer metadata. Fall back to oEmbed if the
    // /videos call returns no item (deleted / region-blocked / wrong
    // id) or the API throws (quota, key restrictions, network).
    try {
      const map = await dataApiVideos([id], apiKey);
      const video = map.get(id);
      if (video) return resultFromDataApi(video);
    } catch (err) {
      // Surface the API error as a stderr breadcrumb but keep going
      // — oEmbed should still produce a usable result.
      // eslint-disable-next-line no-console
      console.error(`[youtube] Data API failed, falling back to oEmbed: ${
        err instanceof Error ? err.message : String(err)
      }`);
    }
  }

  const oembed = await oembedLookup(id);
  if (!oembed && !apiKey) return null;
  return resultFromOembed(id, oembed);
}

async function videoBatchByURL(
  items: Array<{ id: string; input: Record<string, unknown> }>,
  apiKey: string | null,
): Promise<Array<{ id: string; result: Record<string, unknown> | null }>> {
  // Pre-resolve every input URL to a YouTube id so we know which
  // items are even worth fetching.
  const ytIdByItem = new Map<string, string | null>();
  for (const item of items) {
    const url = (item.input.url as string) ?? "";
    ytIdByItem.set(item.id, extractVideoId(url));
  }
  const ytIds = [
    ...new Set([...ytIdByItem.values()].filter((v): v is string => Boolean(v))),
  ];

  let dataApiByYtId = new Map<string, YTVideoItem>();
  let dataApiFailed = false;
  if (apiKey && ytIds.length) {
    try {
      dataApiByYtId = await dataApiVideos(ytIds, apiKey);
    } catch (err) {
      dataApiFailed = true;
      // eslint-disable-next-line no-console
      console.error(`[youtube] batch Data API failed, falling back to oEmbed: ${
        err instanceof Error ? err.message : String(err)
      }`);
    }
  }

  // Fan out oEmbed for the items we still don't have data for. oEmbed
  // doesn't bulk; we issue them sequentially to stay polite. Most
  // batches will have come back from the Data API already so this
  // loop is usually empty.
  const out: Array<{ id: string; result: Record<string, unknown> | null }> = [];
  for (const item of items) {
    const ytId = ytIdByItem.get(item.id) ?? null;
    if (!ytId) {
      out.push({ id: item.id, result: null });
      continue;
    }
    const apiHit = dataApiByYtId.get(ytId);
    if (apiHit) {
      out.push({ id: item.id, result: resultFromDataApi(apiHit) });
      continue;
    }
    // Data API miss (or no key, or batch failed): use oEmbed.
    if (apiKey && !dataApiFailed) {
      // The Data API succeeded but didn't return this id → likely a
      // deleted / private / region-blocked video. Still try oEmbed.
    }
    try {
      const oembed = await oembedLookup(ytId);
      if (!oembed && !apiKey) {
        out.push({ id: item.id, result: null });
      } else {
        out.push({ id: item.id, result: resultFromOembed(ytId, oembed) });
      }
    } catch {
      out.push({ id: item.id, result: null });
    }
  }
  return out;
}

// ─── Plugin export ────────────────────────────────────────────────

export default {
  capabilities: {
    videoByURL: true,
    audioByURL: true,
    supportsBatch: true,
  },

  async execute(
    action: string,
    input: Record<string, unknown>,
    auth: Record<string, string>,
  ): Promise<Record<string, unknown> | null> {
    const apiKey = auth.YOUTUBE_API_KEY || null;

    switch (action) {
      case "videoByURL":
      case "audioByURL":
        return videoByURL(input, apiKey);
      default:
        return null;
    }
  },

  async executeBatch(
    action: string,
    items: Array<{ id: string; input: Record<string, unknown> }>,
    auth: Record<string, string>,
  ): Promise<Array<{ id: string; result: Record<string, unknown> | null }>> {
    const apiKey = auth.YOUTUBE_API_KEY || null;

    if (action === "videoByURL" || action === "audioByURL") {
      return videoBatchByURL(items, apiKey);
    }
    return items.map((it) => ({ id: it.id, result: null }));
  },
};
