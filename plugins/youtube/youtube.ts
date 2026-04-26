/**
 * YouTube Plugin for Obscura
 *
 * Resolves YouTube video URLs / filenames / titles to identify-row
 * metadata.
 *
 * Resolution order (per Obscura's plugin contract — input has `url`,
 * `filePath`, `name`, `title`, `details`):
 *
 *   1. URL    — `input.url`, or any youtube.com / youtu.be URL we
 *               find inside `filePath` / `name` / `title` / `details`.
 *   2. ID     — an 11-char video id wrapped in `[…]` at the end of
 *               the filename or title (yt-dlp's `--output "%(title)s
 *               [%(id)s].%(ext)s"` convention). Whitespace inside the
 *               brackets is normalised to `_` so an underscore that
 *               renders as a space in the UI still matches.
 *   3. Title  — InnerTube `/search` against `name` / `title`. We pick
 *               the first videoRenderer hit. Less precise than 1/2 so
 *               only used when nothing better is available.
 *
 * Once we have an id we hit InnerTube `/youtubei/v1/player` (the same
 * internal JSON API the youtube.com web player uses, no API key)
 * for full metadata: title, description, duration, keywords, channel,
 * publish date, category, thumbnails. oEmbed is the fallback if
 * InnerTube is unreachable for that id.
 *
 * Capabilities: videoByURL, videoByName, audioByURL, supportsBatch.
 */

const YT_OEMBED = "https://www.youtube.com/oembed";
const YT_INNERTUBE_BASE = "https://www.youtube.com/youtubei/v1";
const YT_THUMB_BASE = "https://i.ytimg.com/vi";

// Public InnerTube key embedded in every youtube.com watch page. It
// is not a secret — every web client uses it. yt-dlp and every other
// metadata extractor hardcodes the same value. If YouTube ever
// rotates it, bump alongside the client version.
const INNERTUBE_WEB_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const INNERTUBE_WEB_CLIENT_VERSION = "2.20240726.00.00";

// Parallelism cap for batch fan-out. InnerTube has no documented rate
// limit at this volume, but we stay polite.
const BATCH_CONCURRENCY = 6;

// ─── InnerTube response types ────────────────────────────────────

interface YTThumbnail {
  url: string;
  width?: number;
  height?: number;
}

interface InnertubeVideoDetails {
  videoId?: string;
  title?: string;
  lengthSeconds?: string;
  keywords?: string[];
  channelId?: string;
  shortDescription?: string;
  thumbnail?: { thumbnails?: YTThumbnail[] };
  author?: string;
  viewCount?: string;
  isLiveContent?: boolean;
}

interface InnertubeMicroformat {
  playerMicroformatRenderer?: {
    publishDate?: string;
    uploadDate?: string;
    category?: string;
    ownerChannelName?: string;
    externalChannelId?: string;
    isUnlisted?: boolean;
    isFamilySafe?: boolean;
  };
}

interface InnertubePlayerResponse {
  videoDetails?: InnertubeVideoDetails;
  microformat?: InnertubeMicroformat;
  playabilityStatus?: { status?: string; reason?: string };
  error?: { message?: string; code?: number };
}

// Search responses are deeply nested. We only declare the slice we
// actually walk.
interface InnertubeRun {
  text?: string;
}
interface InnertubeVideoRenderer {
  videoId?: string;
  title?: { runs?: InnertubeRun[]; simpleText?: string };
}
interface InnertubeSearchResponse {
  contents?: {
    twoColumnSearchResultsRenderer?: {
      primaryContents?: {
        sectionListRenderer?: {
          contents?: Array<{
            itemSectionRenderer?: {
              contents?: Array<{ videoRenderer?: InnertubeVideoRenderer }>;
            };
          }>;
        };
      };
    };
  };
  error?: { message?: string; code?: number };
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

// ─── Id extraction ────────────────────────────────────────────────

const ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function isValidId(s: string): boolean {
  return ID_RE.test(s);
}

function videoUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * Pull a YouTube id from a single string. Tries:
 *   1. The string itself if it is exactly an 11-char id.
 *   2. A `youtube.com` / `youtu.be` URL parsed out of it.
 *   3. The last `[…]` block, with whitespace normalised to `_` so an
 *      underscore that renders as a space in the UI still matches.
 */
function idFromString(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  if (isValidId(s)) return s;

  // Try every URL-shaped substring. We don't assume the input is
  // *only* a URL — `details` fields often contain prose with a URL
  // embedded mid-sentence, and `filePath` may contain query strings
  // copied from a download tool.
  const urlRe = /https?:\/\/[^\s"'<>]+/g;
  for (const m of s.matchAll(urlRe)) {
    const id = idFromUrl(m[0]);
    if (id) return id;
  }

  // Bracket suffix: yt-dlp's `[id]` convention, sometimes nested in
  // a path. Walk every bracket group, prefer the rightmost (closest
  // to the extension) since titles can also contain `[abc]`.
  const brackets = [...s.matchAll(/\[([^\]]+)\]/g)];
  for (let i = brackets.length - 1; i >= 0; i--) {
    const cand = brackets[i][1].replace(/\s+/g, "_");
    if (isValidId(cand)) return cand;
  }
  return null;
}

function idFromUrl(url: string): string | null {
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
    return null;
  }
}

/**
 * Walk the input fields Obscura is known to populate, in priority
 * order, and return the first id any of them yield.
 */
function idFromInput(input: Record<string, unknown>): string | null {
  const fields = ["url", "filePath", "name", "title", "details"] as const;
  for (const f of fields) {
    const v = input[f];
    if (typeof v !== "string") continue;
    const id = idFromString(v);
    if (id) return id;
  }
  return null;
}

/**
 * Extract a search query from input fields. Strips a trailing `[id]`
 * (yt-dlp filename suffix) and the file extension if `filePath` is
 * what we end up with — those would just confuse YouTube search.
 */
function queryFromInput(input: Record<string, unknown>): string | null {
  const candidates = [input.name, input.title]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (candidates.length === 0) {
    const fp = input.filePath;
    if (typeof fp === "string" && fp.trim().length > 0) candidates.push(fp);
  }
  for (const raw of candidates) {
    let q = raw;
    // Drop trailing yt-dlp `[id]` segment.
    q = q.replace(/\s*\[[^\]]+\]\s*$/, "");
    // If this looks like a file path, take the basename and drop ext.
    if (q.includes("/") || q.includes("\\")) {
      q = q.split(/[\\/]/).pop() ?? q;
    }
    q = q.replace(/\.[a-z0-9]{2,5}$/i, "");
    q = q.trim();
    if (q.length >= 2) return q;
  }
  return null;
}

// ─── Thumbnail builder ────────────────────────────────────────────

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

function thumbCandidatesFromInnertube(
  videoId: string,
  thumbs: YTThumbnail[] | undefined,
): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  const sorted = [...(thumbs ?? [])].sort(
    (a, b) => (b.width ?? 0) - (a.width ?? 0),
  );
  let rank = 10;
  for (const t of sorted) {
    if (!t.url) continue;
    if (out.some((c) => c.url === t.url)) continue;
    out.push({
      url: t.url,
      source: "youtube",
      rank,
      width: t.width,
      height: t.height,
      aspectRatio:
        t.width && t.height && t.height > 0 ? t.width / t.height : undefined,
    });
    rank = Math.max(2, rank - 2);
  }
  for (const cand of staticThumbCandidates(videoId)) {
    if (!out.some((c) => c.url === cand.url)) out.push(cand);
  }
  return out.sort((a, b) => b.rank - a.rank);
}

// ─── HTTP helpers ─────────────────────────────────────────────────

const INNERTUBE_CONTEXT = {
  client: {
    clientName: "WEB",
    clientVersion: INNERTUBE_WEB_CLIENT_VERSION,
    hl: "en",
    gl: "US",
  },
};

async function innertubePost<T>(endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(
    `${YT_INNERTUBE_BASE}/${endpoint}?key=${INNERTUBE_WEB_KEY}&prettyPrint=false`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-YouTube-Client-Name": "1",
        "X-YouTube-Client-Version": INNERTUBE_WEB_CLIENT_VERSION,
        Origin: "https://www.youtube.com",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(
      `YouTube InnerTube /${endpoint} error: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as T;
}

async function innertubePlayer(
  videoId: string,
): Promise<InnertubePlayerResponse | null> {
  const data = await innertubePost<InnertubePlayerResponse>("player", {
    videoId,
    context: INNERTUBE_CONTEXT,
  });
  if (data.error) {
    throw new Error(
      `YouTube InnerTube error: ${data.error.code ?? "?"} ${
        data.error.message ?? "unknown"
      }`,
    );
  }
  // playabilityStatus may be UNPLAYABLE/LOGIN_REQUIRED for the WEB
  // client and that's fine — we care about title/description/etc,
  // not playback. Only treat ERROR (invalid id) as a miss.
  if (data.playabilityStatus?.status === "ERROR") return null;
  if (!data.videoDetails?.videoId) return null;
  return data;
}

async function innertubeSearchTopVideoId(query: string): Promise<string | null> {
  const data = await innertubePost<InnertubeSearchResponse>("search", {
    query,
    context: INNERTUBE_CONTEXT,
  });
  if (data.error) {
    throw new Error(
      `YouTube InnerTube search error: ${data.error.code ?? "?"} ${
        data.error.message ?? "unknown"
      }`,
    );
  }
  const sects =
    data.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents ?? [];
  for (const sect of sects) {
    const items = sect.itemSectionRenderer?.contents ?? [];
    for (const it of items) {
      const id = it.videoRenderer?.videoId;
      if (id && isValidId(id)) return id;
    }
  }
  return null;
}

async function oembedLookup(videoId: string): Promise<OEmbedResponse | null> {
  // oEmbed returns 4xx for anything it can't resolve. Treat the
  // whole 4xx range as "no result" so the caller gets a clean null.
  const url = `${YT_OEMBED}?url=${encodeURIComponent(videoUrl(videoId))}&format=json`;
  const res = await fetch(url);
  if (res.status >= 400 && res.status < 500) return null;
  if (!res.ok) {
    throw new Error(`YouTube oEmbed error: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as OEmbedResponse;
}

// ─── Result builders ──────────────────────────────────────────────

function parseLengthSeconds(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function resultFromInnertube(
  data: InnertubePlayerResponse,
): Record<string, unknown> | null {
  const vd = data.videoDetails;
  if (!vd?.videoId) return null;
  const mf = data.microformat?.playerMicroformatRenderer;

  const description = vd.shortDescription?.slice(0, 4000) ?? null;
  const tags = vd.keywords?.slice(0, 30) ?? [];
  const runtime = parseLengthSeconds(vd.lengthSeconds);
  const thumbs = thumbCandidatesFromInnertube(
    vd.videoId,
    vd.thumbnail?.thumbnails,
  );
  const imageUrl = thumbs[0]?.url ?? null;
  const publishDate = mf?.publishDate ?? mf?.uploadDate ?? null;
  const date = publishDate ? publishDate.slice(0, 10) : null;
  const channel = mf?.ownerChannelName ?? vd.author ?? null;
  const channelId = vd.channelId ?? mf?.externalChannelId ?? null;
  const category = mf?.category ?? null;

  return {
    title: vd.title ?? null,
    originalTitle: null,
    overview: description,
    tagline: null,
    releaseDate: date,
    runtime,
    genres: category ? [category] : [],
    studioName: channel,
    cast: [],
    posterCandidates: thumbs,
    backdropCandidates: thumbs,
    externalIds: {
      youtube: vd.videoId,
      ...(channelId ? { youtubeChannel: channelId } : {}),
    },

    date,
    details: description,
    urls: [videoUrl(vd.videoId)],
    performerNames: [],
    tagNames: tags,
    imageUrl,
    episodeNumber: null,
    series: null,
    code: null,
    director: null,
  };
}

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

// ─── Single-video resolution ──────────────────────────────────────

async function resolveById(
  videoId: string,
): Promise<Record<string, unknown> | null> {
  // Primary: InnerTube /player. Falls through to oEmbed on any error
  // so a transient blip doesn't break identification.
  try {
    const data = await innertubePlayer(videoId);
    if (data) {
      const result = resultFromInnertube(data);
      if (result) return result;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[youtube] InnerTube /player failed, falling back to oEmbed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const oembed = await oembedLookup(videoId);
  if (!oembed) return null;
  return resultFromOembed(videoId, oembed);
}

async function videoByURL(
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const id = idFromInput(input);
  if (!id) return null;
  return resolveById(id);
}

async function videoByName(
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  // If the name/title/filePath already contains a URL or a `[id]`
  // suffix, prefer that — direct lookup beats search every time.
  const direct = idFromInput(input);
  if (direct) return resolveById(direct);

  const query = queryFromInput(input);
  if (!query) return null;

  let id: string | null = null;
  try {
    id = await innertubeSearchTopVideoId(query);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[youtube] InnerTube /search failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  if (!id) return null;
  return resolveById(id);
}

// ─── Batch ────────────────────────────────────────────────────────

/**
 * Fan out resolution across items with a small concurrency cap.
 * InnerTube has no bulk endpoint, so batching is just parallelism —
 * no worse than the per-item path, and usually much faster overall.
 */
async function batchResolve(
  items: Array<{ id: string; input: Record<string, unknown> }>,
  resolver: (input: Record<string, unknown>) => Promise<
    Record<string, unknown> | null
  >,
): Promise<Array<{ id: string; result: Record<string, unknown> | null }>> {
  const out: Array<{ id: string; result: Record<string, unknown> | null }> =
    new Array(items.length);

  let next = 0;
  const workers = Array.from(
    { length: Math.min(BATCH_CONCURRENCY, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        const item = items[i];
        try {
          out[i] = { id: item.id, result: await resolver(item.input) };
        } catch {
          out[i] = { id: item.id, result: null };
        }
      }
    },
  );
  await Promise.all(workers);
  return out;
}

// ─── Plugin export ────────────────────────────────────────────────

export default {
  capabilities: {
    videoByURL: true,
    videoByName: true,
    audioByURL: true,
    supportsBatch: true,
  },

  async execute(
    action: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    switch (action) {
      case "videoByURL":
      case "audioByURL":
        return videoByURL(input);
      case "videoByName":
        return videoByName(input);
      default:
        return null;
    }
  },

  async executeBatch(
    action: string,
    items: Array<{ id: string; input: Record<string, unknown> }>,
  ): Promise<Array<{ id: string; result: Record<string, unknown> | null }>> {
    if (action === "videoByURL" || action === "audioByURL") {
      return batchResolve(items, videoByURL);
    }
    if (action === "videoByName") {
      return batchResolve(items, videoByName);
    }
    return items.map((it) => ({ id: it.id, result: null }));
  },
};
