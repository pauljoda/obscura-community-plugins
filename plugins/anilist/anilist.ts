/**
 * AniList Plugin for Obscura
 *
 * Identifies anime (TV series, movies, OVAs, ONAs, specials) using the
 * AniList public GraphQL API. No authentication required.
 *
 * Capabilities:
 * - videoByName:    search anime by title, return single best match
 * - videoByURL:     resolve https://anilist.co/anime/{id} URLs
 * - folderByName:   search for a series by folder name; auto-merges
 *                   AniList's separate-Media-per-cour entries (S1/S2/S3)
 *                   into a single series via PREQUEL/SEQUEL chain walking
 * - folderCascade:  return per-episode metadata for a given season of a chain
 *
 * Rate limit: 30 req/min per IP. Each handler does at most ~1 fetch per
 * season in the chain (capped at MAX_CHAIN_DEPTH).
 */

const ANILIST_API = "https://graphql.anilist.co";
const ANILIST_WEB = "https://anilist.co";
const USER_AGENT = "Obscura-AniList-Plugin/0.2.1";

// Stop walking the SEQUEL/PREQUEL chain after this many entries to
// bound API calls and protect against pathological cycles.
const MAX_CHAIN_DEPTH = 10;

// Only relations whose linked Media has these formats count as "next
// season" hops. Movies/ONAs/specials remain as separate disambiguation
// candidates rather than getting folded in as a season.
const TV_CHAIN_FORMATS = new Set(["TV", "TV_SHORT"]);

// ─── AniList GraphQL response types ───────────────────────────────

interface AniListTitle {
  romaji?: string | null;
  english?: string | null;
  native?: string | null;
}

interface AniListImage {
  extraLarge?: string | null;
  large?: string | null;
  medium?: string | null;
  color?: string | null;
}

interface AniListFuzzyDate {
  year?: number | null;
  month?: number | null;
  day?: number | null;
}

interface AniListTag {
  name: string;
  rank?: number | null;
}

interface AniListStudio {
  name: string;
  isAnimationStudio?: boolean;
}

interface AniListStreamingEpisode {
  title?: string | null;
  thumbnail?: string | null;
  url?: string | null;
  site?: string | null;
}

interface AniListVoiceActor {
  name?: { full?: string | null };
  image?: { large?: string | null };
}

interface AniListCharacterEdge {
  role?: string | null;
  node?: {
    name?: { full?: string | null };
    image?: { large?: string | null };
  };
  voiceActors?: AniListVoiceActor[];
}

interface AniListRelationEdge {
  relationType?: string | null;
  node?: {
    id: number;
    type?: string | null;
    format?: string | null;
  } | null;
}

interface AniListMedia {
  id: number;
  idMal?: number | null;
  title?: AniListTitle | null;
  description?: string | null;
  format?: string | null;
  episodes?: number | null;
  duration?: number | null;
  status?: string | null;
  startDate?: AniListFuzzyDate | null;
  endDate?: AniListFuzzyDate | null;
  season?: string | null;
  seasonYear?: number | null;
  coverImage?: AniListImage | null;
  bannerImage?: string | null;
  averageScore?: number | null;
  meanScore?: number | null;
  popularity?: number | null;
  genres?: string[] | null;
  tags?: AniListTag[] | null;
  studios?: { nodes?: AniListStudio[] } | null;
  siteUrl?: string | null;
  isAdult?: boolean | null;
  streamingEpisodes?: AniListStreamingEpisode[] | null;
  characters?: { edges?: AniListCharacterEdge[] } | null;
  relations?: { edges?: AniListRelationEdge[] } | null;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; status?: number }>;
}

interface ImageCandidate {
  url: string;
  source: string;
  rank: number;
  language?: string | null;
  width?: number;
  height?: number;
  aspectRatio?: number;
}

// ─── GraphQL helper ───────────────────────────────────────────────

async function anilistFetch<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(ANILIST_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `AniList API error: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
    );
  }

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors && json.errors.length > 0) {
    throw new Error(`AniList GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) {
    throw new Error("AniList GraphQL returned no data");
  }
  return json.data;
}

// ─── GraphQL queries ──────────────────────────────────────────────

// Shared media field selection. Kept as a fragment so detail and search
// agree on shape and there's only one place to extend the schema.
const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  description(asHtml: false)
  format
  episodes
  duration
  status
  startDate { year month day }
  endDate { year month day }
  season
  seasonYear
  coverImage { extraLarge large medium color }
  bannerImage
  averageScore
  meanScore
  popularity
  genres
  tags { name rank }
  studios { nodes { name isAnimationStudio } }
  siteUrl
  isAdult
  streamingEpisodes { title thumbnail url site }
  characters(perPage: 25, sort: [ROLE, RELEVANCE]) {
    edges {
      role
      node { name { full } image { large } }
      voiceActors(language: JAPANESE) { name { full } image { large } }
    }
  }
  relations {
    edges {
      relationType(version: 2)
      node { id type format }
    }
  }
`;

const MEDIA_DETAIL_QUERY = `
  query ($id: Int!) {
    Media(id: $id, type: ANIME) {
      ${MEDIA_FIELDS}
    }
  }
`;

// AniList's `isAdult` argument is a tristate matcher: `false` excludes
// adult, `true` includes only adult, and `null` matches nothing (not
// "no filter" as you'd expect). To get "no filter" we have to omit the
// argument entirely — hence two separate queries below.
const MEDIA_SEARCH_QUERY_SFW = `
  query ($search: String!) {
    Page(perPage: 10) {
      media(
        search: $search
        type: ANIME
        isAdult: false
        sort: [SEARCH_MATCH, POPULARITY_DESC]
      ) {
        ${MEDIA_FIELDS}
      }
    }
  }
`;

const MEDIA_SEARCH_QUERY_ALL = `
  query ($search: String!) {
    Page(perPage: 10) {
      media(
        search: $search
        type: ANIME
        sort: [SEARCH_MATCH, POPULARITY_DESC]
      ) {
        ${MEDIA_FIELDS}
      }
    }
  }
`;

// ─── URL parsing ──────────────────────────────────────────────────

function parseAniListUrl(url: string): { id: number } | null {
  // https://anilist.co/anime/12345 or .../anime/12345/Slug
  const m = url.match(/anilist\.co\/anime\/(\d+)/i);
  if (!m) return null;
  return { id: Number.parseInt(m[1], 10) };
}

function extractAniListIdOverride(input: Record<string, unknown>): number | null {
  const ext = input.externalIds;
  if (ext && typeof ext === "object") {
    const v = (ext as Record<string, unknown>).anilist;
    if (typeof v === "string") {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) return n;
    }
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  const legacy = input.externalId;
  if (typeof legacy === "string") {
    const m = legacy.match(/^anilist:(\d+)$/);
    if (m) return Number.parseInt(m[1], 10);
  }
  return null;
}

// ─── Mappers ──────────────────────────────────────────────────────

function pickTitle(t?: AniListTitle | null): string {
  if (!t) return "";
  return t.english || t.romaji || t.native || "";
}

function originalTitle(t?: AniListTitle | null): string | null {
  if (!t) return null;
  // If we displayed english as the canonical title, prefer romaji as
  // the "original"; otherwise fall back to native.
  if (t.english && t.romaji && t.english !== t.romaji) return t.romaji ?? null;
  return t.native ?? t.romaji ?? null;
}

/**
 * AniList descriptions still contain HTML even with `asHtml: false` —
 * `<br>`, `<i>`, `<b>`, occasional `<p>`, plus the usual entity escapes.
 * Convert to plain text the UI can render directly: `<br>` becomes a
 * newline, paragraph structure is preserved, other tags are dropped.
 */
function stripHtml(s: string | null | undefined): string | null {
  if (!s) return null;
  const out = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<p\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out || null;
}

function fuzzyDateToString(d?: AniListFuzzyDate | null): string | null {
  if (!d || !d.year) return null;
  const y = String(d.year).padStart(4, "0");
  if (!d.month) return y;
  const mo = String(d.month).padStart(2, "0");
  if (!d.day) return `${y}-${mo}`;
  const da = String(d.day).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function mapStatus(
  s: string | null | undefined,
): "returning" | "ended" | "canceled" | "unknown" | null {
  if (!s) return null;
  switch (s.toUpperCase()) {
    case "RELEASING":
    case "NOT_YET_RELEASED":
      return "returning";
    case "FINISHED":
      return "ended";
    case "CANCELLED":
      return "canceled";
    case "HIATUS":
      return "unknown";
    default:
      return "unknown";
  }
}

function coverCandidates(img?: AniListImage | null): ImageCandidate[] {
  if (!img) return [];
  const out: ImageCandidate[] = [];
  if (img.extraLarge) out.push({ url: img.extraLarge, source: "anilist", rank: 10 });
  if (img.large && img.large !== img.extraLarge) {
    out.push({ url: img.large, source: "anilist", rank: 8 });
  }
  if (img.medium && img.medium !== img.large && img.medium !== img.extraLarge) {
    out.push({ url: img.medium, source: "anilist", rank: 5 });
  }
  return out;
}

function bannerCandidates(banner?: string | null): ImageCandidate[] {
  if (!banner) return [];
  return [{ url: banner, source: "anilist", rank: 9 }];
}

function pickPosterUrl(img?: AniListImage | null): string | null {
  if (!img) return null;
  return img.extraLarge || img.large || img.medium || null;
}

function pickStudio(studios?: { nodes?: AniListStudio[] } | null): string | null {
  const nodes = studios?.nodes ?? [];
  const animation = nodes.find((s) => s.isAnimationStudio);
  return animation?.name ?? nodes[0]?.name ?? null;
}

interface CastEntry {
  name: string;
  character: string | null;
  order: number;
  profileUrl: string | null;
}

function castFromCharacters(edges?: AniListCharacterEdge[] | null): CastEntry[] {
  if (!edges || edges.length === 0) return [];
  const ROLE_ORDER: Record<string, number> = {
    MAIN: 0,
    SUPPORTING: 1,
    BACKGROUND: 2,
  };
  return edges
    .map((e, i) => {
      const va = e.voiceActors?.[0];
      // Skip entries without a voice actor — for cast purposes the seiyuu
      // is the "name". The character name lives in the `character` field.
      if (!va) return null;
      const name = va.name?.full ?? null;
      if (!name) return null;
      return {
        name,
        character: e.node?.name?.full ?? null,
        order: (ROLE_ORDER[e.role ?? ""] ?? 9) * 1000 + i,
        profileUrl: va.image?.large ?? null,
      } satisfies CastEntry;
    })
    .filter((x): x is CastEntry => x !== null)
    .sort((a, b) => a.order - b.order)
    .slice(0, 25);
}

function mediaSiteUrl(m: AniListMedia): string {
  return m.siteUrl || `${ANILIST_WEB}/anime/${m.id}`;
}

function mediaToCandidate(m: AniListMedia): Record<string, unknown> {
  return {
    externalIds: { anilist: String(m.id) },
    title: pickTitle(m.title),
    year: m.seasonYear ?? m.startDate?.year ?? null,
    overview: stripHtml(m.description),
    posterUrl: pickPosterUrl(m.coverImage),
    popularity: typeof m.averageScore === "number" ? m.averageScore : null,
    format: m.format ?? null,
  };
}

// ─── Title scoring (mirrors tmdb.ts) ──────────────────────────────

function normalizeQueryForMatch(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[!?.'"`]/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeQueryForMatch(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeQueryForMatch(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const tok of ta) {
    if (tb.has(tok)) inter += 1;
  }
  const union = new Set([...ta, ...tb]).size;
  return inter / union;
}

/** Best similarity across romaji/english/native. */
function bestTitleSimilarity(query: string, t?: AniListTitle | null): number {
  if (!t) return 0;
  const candidates = [t.english, t.romaji, t.native].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  let best = 0;
  for (const c of candidates) {
    const s = titleSimilarity(query, c);
    if (s > best) best = s;
  }
  return best;
}

// ─── Local seasons input parsing (mirrors tmdb.ts) ────────────────

interface LocalEpisodeDef {
  episodeNumber: number;
  localFilePath: string;
  title: string | null;
}

interface LocalSeasonDef {
  seasonNumber: number;
  episodes: LocalEpisodeDef[];
}

function parseLocalSeasons(input: Record<string, unknown>): LocalSeasonDef[] | null {
  const raw = input.localSeasons;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const bySeason = new Map<number, LocalEpisodeDef[]>();
  for (const item of raw) {
    if (typeof item !== "object" || !item) continue;
    const o = item as Record<string, unknown>;
    const sn = typeof o.seasonNumber === "number" ? o.seasonNumber : Number(o.seasonNumber);
    if (!Number.isFinite(sn)) continue;
    const acc = bySeason.get(sn) ?? [];
    const epsRaw = o.episodes;
    if (Array.isArray(epsRaw)) {
      for (const e of epsRaw) {
        if (typeof e !== "object" || !e) continue;
        const er = e as Record<string, unknown>;
        const en =
          typeof er.episodeNumber === "number" ? er.episodeNumber : Number(er.episodeNumber);
        if (!Number.isFinite(en)) continue;
        acc.push({
          episodeNumber: en,
          localFilePath: typeof er.localFilePath === "string" ? er.localFilePath : "",
          title: typeof er.title === "string" ? er.title : null,
        });
      }
    }
    bySeason.set(sn, acc);
  }
  if (bySeason.size === 0) return null;
  return [...bySeason.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seasonNumber, episodes]) => ({
      seasonNumber,
      episodes: episodes.sort((x, y) => x.episodeNumber - y.episodeNumber),
    }));
}

// ─── Episode helpers ──────────────────────────────────────────────

/**
 * AniList's `streamingEpisodes` titles look like
 *   "Episode 12 - Jupiter Jazz (part 1)"
 * Pull the leading number off so we can key by episode number.
 */
function parseStreamingEpisodeNumber(title: string | null | undefined): number | null {
  if (!title) return null;
  const m = title.match(/^\s*(?:episode|ep\.?)\s*(\d+)/i);
  return m ? Number.parseInt(m[1], 10) : null;
}

function streamingEpisodeTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  // Strip "Episode N - " prefix so the title is just the episode name.
  return title.replace(/^\s*(?:episode|ep\.?)\s*\d+\s*[-–:]\s*/i, "").trim() || title;
}

interface EpisodeRecord {
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  overview: string | null;
  airDate: string | null;
  runtime: number | null;
  stillCandidates: ImageCandidate[];
  guestStars: never[];
  externalIds: Record<string, string>;
  matched: boolean;
  localFilePath: string | null;
  streamingUrl?: string | null;
  streamingSite?: string | null;
}

function buildEpisodeRecords(
  m: AniListMedia,
  local?: LocalEpisodeDef[] | null,
): EpisodeRecord[] {
  // Trust streamingEpisodes only when their count matches the declared
  // episode count. Crunchyroll lists multi-season anime as one
  // continuous show, and AniList faithfully copies that list onto
  // every Media in the chain — so JJK S2 (episodes: 23) reports the
  // same 24 streaming entries as JJK S1, all with S1 titles. The
  // count mismatch is a reliable signal that the data is the parent
  // series' episodes, not this entry's.
  const seList = m.streamingEpisodes ?? [];
  const expected = m.episodes ?? 0;
  const trustStreaming = seList.length > 0 && expected > 0 && seList.length === expected;

  // Index AniList's streaming episodes by number for O(1) lookup.
  const byNum = new Map<number, AniListStreamingEpisode>();
  if (trustStreaming) {
    for (const se of seList) {
      const n = parseStreamingEpisodeNumber(se.title);
      if (n !== null && !byNum.has(n)) byNum.set(n, se);
    }
  }

  // Caller-provided local episode layout takes precedence over the
  // AniList total, so we map exactly what the user has on disk.
  if (local && local.length > 0) {
    return local.map((le) => {
      const se = byNum.get(le.episodeNumber);
      return {
        seasonNumber: 1,
        episodeNumber: le.episodeNumber,
        title: streamingEpisodeTitle(se?.title) ?? le.title,
        overview: null,
        airDate: null,
        runtime: m.duration ?? null,
        stillCandidates: se?.thumbnail
          ? [{ url: se.thumbnail, source: "anilist", rank: 8 }]
          : [],
        guestStars: [],
        externalIds: {},
        matched: Boolean(se),
        localFilePath: le.localFilePath || null,
        streamingUrl: se?.url ?? null,
        streamingSite: se?.site ?? null,
      } satisfies EpisodeRecord;
    });
  }

  // No local layout: emit one record per known episode number, taking
  // the count from the streaming list's max or `m.episodes`.
  const total = Math.max(
    m.episodes ?? 0,
    byNum.size > 0 ? Math.max(...byNum.keys()) : 0,
  );
  if (total === 0) return [];
  const out: EpisodeRecord[] = [];
  for (let n = 1; n <= total; n++) {
    const se = byNum.get(n);
    out.push({
      seasonNumber: 1,
      episodeNumber: n,
      title: streamingEpisodeTitle(se?.title),
      overview: null,
      airDate: null,
      runtime: m.duration ?? null,
      stillCandidates: se?.thumbnail
        ? [{ url: se.thumbnail, source: "anilist", rank: 8 }]
        : [],
      guestStars: [],
      externalIds: {},
      matched: Boolean(se),
      localFilePath: null,
      streamingUrl: se?.url ?? null,
      streamingSite: se?.site ?? null,
    });
  }
  return out;
}

// ─── Season chain walking ─────────────────────────────────────────

function pickRelatedMediaId(
  m: AniListMedia,
  relationType: "PREQUEL" | "SEQUEL",
): number | null {
  const edges = m.relations?.edges ?? [];
  for (const e of edges) {
    if (e.relationType !== relationType) continue;
    const node = e.node;
    if (!node || node.type !== "ANIME") continue;
    if (!TV_CHAIN_FORMATS.has(node.format ?? "")) continue;
    return node.id;
  }
  return null;
}

/**
 * AniList stores each anime cour/season as its own Media entry (e.g.
 * Attack on Titan S1, S2, Final all have distinct IDs). Walk the
 * PREQUEL chain backward to find the earliest TV entry, then walk
 * SEQUEL forward to assemble the full season list. Returns the chain
 * in season order — index 0 is "Season 1".
 *
 * Movies, OVAs, ONAs, and specials are NOT folded into the chain:
 * users see those as separate disambiguation candidates.
 */
async function walkSeasonChain(
  rootMedia: AniListMedia,
  fetchById: (id: number) => Promise<AniListMedia | null> = fetchMediaById,
): Promise<AniListMedia[]> {
  const cache = new Map<number, AniListMedia>([[rootMedia.id, rootMedia]]);

  // Walk PREQUEL backward to find earliest TV entry.
  let earliest = rootMedia;
  for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
    const prequelId = pickRelatedMediaId(earliest, "PREQUEL");
    if (prequelId === null || cache.has(prequelId)) break;
    const prev = await fetchById(prequelId);
    if (!prev) break;
    cache.set(prev.id, prev);
    earliest = prev;
  }

  // Walk SEQUEL forward from the earliest entry to assemble the chain.
  const chain: AniListMedia[] = [earliest];
  const seen = new Set<number>([earliest.id]);
  while (chain.length < MAX_CHAIN_DEPTH) {
    const last = chain[chain.length - 1];
    const sequelId = pickRelatedMediaId(last, "SEQUEL");
    if (sequelId === null || seen.has(sequelId)) break;
    let next = cache.get(sequelId) ?? null;
    if (!next) {
      next = await fetchById(sequelId);
      if (!next) break;
      cache.set(next.id, next);
    }
    chain.push(next);
    seen.add(next.id);
  }

  return chain;
}

// ─── Result builders ──────────────────────────────────────────────

function mediaToVideoResult(m: AniListMedia): Record<string, unknown> {
  const title = pickTitle(m.title);
  const cast = castFromCharacters(m.characters?.edges);
  const genres = m.genres ?? [];
  const studio = pickStudio(m.studios);
  const releaseDate = fuzzyDateToString(m.startDate);
  const poster = pickPosterUrl(m.coverImage);
  const url = mediaSiteUrl(m);

  return {
    title,
    originalTitle: originalTitle(m.title),
    overview: stripHtml(m.description),
    tagline: null,
    releaseDate,
    runtime: m.duration ?? null,
    genres,
    studioName: studio,
    cast,
    posterCandidates: coverCandidates(m.coverImage),
    backdropCandidates: bannerCandidates(m.bannerImage),
    externalIds: { anilist: String(m.id), ...(m.idMal ? { mal: String(m.idMal) } : {}) },
    // Legacy flat keys for identify-row consumers
    date: releaseDate,
    details: stripHtml(m.description),
    urls: [url],
    performerNames: cast.map((c) => c.name),
    tagNames: genres,
    imageUrl: poster,
    episodeNumber: null,
    series:
      m.format && m.format !== "MOVIE"
        ? { name: title, externalId: `anilist:${m.id}` }
        : null,
    code: null,
    director: null,
  };
}

/**
 * Season record for a `localSeasons` entry whose `seasonNumber` falls
 * outside the AniList chain. We have no AniList Media to enrich
 * from, so episodes carry only the user-provided fields and the host
 * UI can still render the local files.
 */
function buildLocalOnlySeasonRecord(
  ls: LocalSeasonDef,
): Record<string, unknown> {
  return {
    seasonNumber: ls.seasonNumber,
    title: `Season ${ls.seasonNumber}`,
    overview: null,
    airDate: null,
    posterCandidates: [],
    externalIds: {},
    episodes: ls.episodes.map((le) => ({
      seasonNumber: ls.seasonNumber,
      episodeNumber: le.episodeNumber,
      title: le.title,
      overview: null,
      airDate: null,
      runtime: null,
      stillCandidates: [],
      guestStars: [],
      externalIds: {},
      matched: false,
      localFilePath: le.localFilePath || null,
      streamingUrl: null,
      streamingSite: null,
    })),
  };
}

function buildSeasonRecord(
  m: AniListMedia,
  seasonNumber: number,
  localEpisodes: LocalEpisodeDef[] | null,
): Record<string, unknown> {
  const episodes = buildEpisodeRecords(m, localEpisodes).map((e) => ({
    ...e,
    seasonNumber,
  }));
  return {
    seasonNumber,
    title: pickTitle(m.title) || `Season ${seasonNumber}`,
    overview: stripHtml(m.description),
    airDate: fuzzyDateToString(m.startDate),
    posterCandidates: coverCandidates(m.coverImage),
    externalIds: { anilist: String(m.id) },
    episodes,
  };
}

/**
 * Build the multi-season folder result. The chain head (chain[0]) is
 * the canonical "series" — its title, cast, and artwork are surfaced
 * at the top level. Each chain entry becomes one season. When the
 * caller passes `localSeasons`, episodes for season N are matched
 * against `chain[N-1].streamingEpisodes`.
 */
function chainToFolderResult(
  chain: AniListMedia[],
  input: Record<string, unknown>,
  candidates?: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const head = chain[0];
  const title = pickTitle(head.title);
  const genres = head.genres ?? [];
  const cast = castFromCharacters(head.characters?.edges);
  const studio = pickStudio(head.studios);
  const local = parseLocalSeasons(input);

  const seasons: Array<Record<string, unknown>> = [];
  const claimedSeasonNumbers = new Set<number>();
  chain.forEach((m, i) => {
    const seasonNumber = i + 1;
    claimedSeasonNumbers.add(seasonNumber);
    const localForSeason =
      local?.find((s) => s.seasonNumber === seasonNumber)?.episodes ?? null;
    seasons.push(buildSeasonRecord(m, seasonNumber, localForSeason));
  });

  // The chain only covers what AniList knows about. If the user has
  // local seasons numbered outside the chain (mis-numbered folders,
  // an OVA collection labeled "Season 4", etc.), surface them too so
  // the cascade UI doesn't silently drop the user's files.
  if (local) {
    for (const ls of local) {
      if (claimedSeasonNumbers.has(ls.seasonNumber)) continue;
      seasons.push(buildLocalOnlySeasonRecord(ls));
    }
    seasons.sort(
      (a, b) => (a.seasonNumber as number) - (b.seasonNumber as number),
    );
  }

  // Headline air dates span the chain.
  const firstAirDate = fuzzyDateToString(head.startDate);
  const endAirDate = fuzzyDateToString(chain[chain.length - 1].endDate);
  const totalEpisodes = chain.reduce((acc, m) => acc + (m.episodes ?? 0), 0);
  const lastStatus = mapStatus(chain[chain.length - 1].status);

  return {
    title,
    originalTitle: originalTitle(head.title),
    overview: stripHtml(head.description),
    tagline: null,
    firstAirDate,
    endAirDate,
    status: lastStatus,
    genres,
    studioName: studio,
    cast,
    posterCandidates: coverCandidates(head.coverImage),
    backdropCandidates: bannerCandidates(head.bannerImage),
    logoCandidates: [],
    externalIds: { anilist: String(head.id), ...(head.idMal ? { mal: String(head.idMal) } : {}) },
    seasons,
    ...(candidates && candidates.length > 1 ? { candidates } : {}),
    // Legacy flat keys
    name: title,
    details: stripHtml(head.description),
    date: firstAirDate,
    imageUrl: pickPosterUrl(head.coverImage),
    backdropUrl: head.bannerImage ?? null,
    tagNames: genres,
    urls: [mediaSiteUrl(head)],
    seriesExternalId: `anilist:${head.id}`,
    seasonCount: chain.length,
    totalEpisodes: totalEpisodes || undefined,
    folderByName: true,
  };
}

/**
 * Build the cascade response for one season of a chain. The host
 * passes `seasonNumber` along with the chain head's externalId; we
 * pick `chain[seasonNumber - 1]` and emit its episode map.
 */
function chainToCascadeResult(
  chain: AniListMedia[],
  seasonNumber: number,
): Record<string, unknown> {
  const head = chain[0];
  const target = chain[seasonNumber - 1] ?? head;
  const episodes = buildEpisodeRecords(target, null);
  const episodeMap: Record<string, Record<string, unknown>> = {};
  for (const e of episodes) {
    episodeMap[String(e.episodeNumber)] = {
      episodeNumber: e.episodeNumber,
      seasonNumber,
      title: e.title,
      date: null,
      details: null,
    };
  }

  const totalEpisodes = chain.reduce((acc, m) => acc + (m.episodes ?? 0), 0);
  return {
    name: pickTitle(head.title),
    details: stripHtml(head.description),
    date: fuzzyDateToString(head.startDate),
    imageUrl: pickPosterUrl(head.coverImage),
    backdropUrl: head.bannerImage ?? null,
    studioName: pickStudio(head.studios),
    tagNames: head.genres ?? [],
    urls: [mediaSiteUrl(head)],
    seriesExternalId: `anilist:${head.id}`,
    seasonCount: chain.length,
    totalEpisodes: totalEpisodes || undefined,
    episodeMap,
  };
}

// ─── Action handlers ──────────────────────────────────────────────

function getAllowNsfw(input: Record<string, unknown>): boolean {
  return input.allowNsfw === true;
}

async function fetchMediaById(id: number): Promise<AniListMedia | null> {
  const data = await anilistFetch<{ Media: AniListMedia | null }>(
    MEDIA_DETAIL_QUERY,
    { id },
  );
  return data.Media ?? null;
}

async function searchMedia(
  query: string,
  allowNsfw: boolean,
): Promise<AniListMedia[]> {
  const data = await anilistFetch<{ Page: { media: AniListMedia[] | null } }>(
    allowNsfw ? MEDIA_SEARCH_QUERY_ALL : MEDIA_SEARCH_QUERY_SFW,
    { search: query },
  );
  return data.Page?.media ?? [];
}

async function videoByName(
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const query = (input.name as string) ?? (input.title as string) ?? "";
  if (!query) return null;
  const cleanQuery = normalizeQueryForMatch(query) || query;
  const results = await searchMedia(cleanQuery, getAllowNsfw(input));
  if (results.length === 0) return null;

  // Re-rank by title similarity to be robust against AniList's fuzzy
  // search occasionally surfacing a sequel ahead of the original.
  const best = results
    .map((m, i) => ({ m, score: bestTitleSimilarity(query, m.title), i }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))[0].m;

  return mediaToVideoResult(best);
}

async function videoByURL(
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const url = input.url as string;
  if (!url) return null;
  const parsed = parseAniListUrl(url);
  if (!parsed) return null;
  const media = await fetchMediaById(parsed.id);
  return media ? mediaToVideoResult(media) : null;
}

async function folderByName(
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  // The cascade drawer re-resolves with `externalIds.anilist` when
  // the user picks a candidate. Respect that pick literally — return
  // a single-Media folder result rather than walking the chain, or
  // the user's selection silently re-anchors back to chain head and
  // the UI shows no change.
  const override = extractAniListIdOverride(input);
  if (override !== null) {
    const m = await fetchMediaById(override);
    if (!m) return null;
    return chainToFolderResult([m], input);
  }

  const query = (input.name as string) ?? (input.title as string) ?? "";
  if (!query) return null;
  const cleanQuery = normalizeQueryForMatch(query) || query;

  const results = await searchMedia(cleanQuery, getAllowNsfw(input));
  if (results.length === 0) return null;

  const scored = results
    .map((m, i) => ({ m, score: bestTitleSimilarity(query, m.title), order: i }))
    .sort((a, b) => (b.score - a.score) || (a.order - b.order));

  const best = scored[0].m;
  const chain = await walkSeasonChain(best);

  // Filter chain members out of the candidates list — they're folded
  // into the seasons array now, so showing them as separate picks is
  // confusing. Movies, OVAs, and specials remain.
  const chainIds = new Set(chain.map((m) => m.id));
  const candidates = scored
    .slice(0, 10)
    .filter((s) => !chainIds.has(s.m.id))
    .map((s) => mediaToCandidate(s.m));

  return chainToFolderResult(chain, input, candidates);
}

async function folderCascade(
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const override = extractAniListIdOverride(input);
  let id = override;
  if (id === null) {
    const externalId = input.externalId as string | undefined;
    if (!externalId) return null;
    const m = externalId.match(/^anilist:(\d+)$/);
    if (!m) return null;
    id = Number.parseInt(m[1], 10);
  }
  const media = await fetchMediaById(id);
  if (!media) return null;

  const chain = await walkSeasonChain(media);
  // The host passes `seasonNumber` indexed against the seasons array
  // we returned from folderByName. Default to season 1 when absent.
  const seasonNumber =
    typeof input.seasonNumber === "number" ? input.seasonNumber : 1;
  return chainToCascadeResult(chain, seasonNumber);
}

// ─── Plugin export ────────────────────────────────────────────────

export default {
  capabilities: {
    videoByURL: true,
    videoByName: true,
    folderByName: true,
    folderCascade: true,
  },

  async execute(
    action: string,
    input: Record<string, unknown>,
    _auth: Record<string, string>,
  ): Promise<Record<string, unknown> | null> {
    switch (action) {
      case "videoByName":
        return videoByName(input);
      case "videoByURL":
        return videoByURL(input);
      case "folderByName":
        return folderByName(input);
      case "folderCascade":
        return folderCascade(input);
      default:
        return null;
    }
  },
};
