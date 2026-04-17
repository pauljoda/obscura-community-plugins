/**
 * TVDB Plugin for Obscura
 *
 * Identifies TV series, seasons, and episodes using the TVDB v4 API.
 *
 * Capabilities:
 * - folderByName: search for a TV series by folder name
 * - videoByURL: resolve a thetvdb.com series / episode URL
 * - folderCascade: map a resolved series+season to per-episode metadata
 * - seriesByName / seriesByURL / seriesCascade: plan-C show-level lookup
 *
 * Emits the same normalized cascade shape as the TMDB plugin so the
 * accept-scrape service and review drawer can consume results without
 * branching on provider.
 */

const TVDB_API = "https://api4.thetvdb.com/v4";

// ─── TVDB API response types ──────────────────────────────────────

interface TvdbLoginResponse {
  data: { token: string };
}

interface TvdbSearchHit {
  /** TVDB returns both numeric id and "series-<id>" style tvdb_id fields. */
  id?: string;
  tvdb_id?: string;
  objectID?: string;
  name?: string;
  translations?: Record<string, string>;
  overview?: string;
  overviews?: Record<string, string>;
  image_url?: string;
  thumbnail?: string;
  first_air_time?: string;
  year?: string;
  network?: string;
  country?: string;
  primary_language?: string;
  slug?: string;
  status?: string;
}

interface TvdbSeriesExtended {
  id: number;
  name: string;
  slug?: string;
  image?: string;
  firstAired?: string;
  lastAired?: string;
  nextAired?: string;
  status?: { name?: string; recordType?: string };
  originalCountry?: string;
  originalLanguage?: string;
  averageRuntime?: number;
  overview?: string;
  year?: string;
  aliases?: Array<{ language: string; name: string }>;
  genres?: Array<{ name: string; slug?: string }>;
  companies?: Array<{ name: string; country?: string; primaryCompanyType?: number }>;
  originalNetwork?: { name?: string };
  latestNetwork?: { name?: string };
  seasons?: Array<{
    id: number;
    seriesId: number;
    type: { id: number; name: string; type: string };
    number: number;
    name?: string;
    image?: string;
    imageType?: number;
  }>;
  artworks?: TvdbArtwork[];
  translations?: {
    nameTranslations?: Array<{ language: string; name: string }>;
    overviewTranslations?: Array<{ language: string; overview: string }>;
  };
  characters?: TvdbCharacter[];
}

interface TvdbArtwork {
  id: number;
  image: string;
  thumbnail?: string;
  language?: string | null;
  type: number;
  score?: number;
  width?: number;
  height?: number;
  includesText?: boolean;
}

interface TvdbCharacter {
  id: number;
  name?: string;
  personName?: string;
  peopleId?: number;
  seriesId?: number;
  type?: number;
  personImgURL?: string;
  image?: string;
  sort?: number;
  isFeatured?: boolean;
}

interface TvdbSeasonExtended {
  id: number;
  number: number;
  name?: string;
  image?: string;
  seriesId: number;
  type: { id: number; name: string; type: string };
  episodes?: TvdbEpisode[];
  artwork?: TvdbArtwork[];
  overview?: string;
  translations?: {
    nameTranslations?: Array<{ language: string; name: string }>;
    overviewTranslations?: Array<{ language: string; overview: string }>;
  };
}

interface TvdbEpisode {
  id: number;
  seriesId?: number;
  seasonNumber?: number;
  number?: number;
  absoluteNumber?: number | null;
  name?: string;
  overview?: string;
  aired?: string;
  runtime?: number;
  image?: string;
  /** Some endpoints use `nameTranslations` / `overviewTranslations` arrays. */
  nameTranslations?: string[];
  overviewTranslations?: string[];
}

interface TvdbEpisodeExtended extends TvdbEpisode {
  characters?: TvdbCharacter[];
  translations?: {
    nameTranslations?: Array<{ language: string; name: string }>;
    overviewTranslations?: Array<{ language: string; overview: string }>;
  };
}

// ─── Artwork type ids ─────────────────────────────────────────────
// TVDB assigns integer type ids per artwork slot. Codes come from
// the public `/artwork/types` endpoint; we hard-code the ones we
// actually care about to avoid an extra request on every call.
const ARTWORK_SERIES_BANNER = 1;
const ARTWORK_SERIES_POSTER = 2;
const ARTWORK_SERIES_BACKGROUND = 3;
const ARTWORK_SERIES_ICON = 5;
const ARTWORK_SERIES_CLEARART = 22;
const ARTWORK_SERIES_CLEARLOGO = 23;
const ARTWORK_SEASON_POSTER = 7;
const ARTWORK_SEASON_BANNER = 8;

// ─── API helpers ──────────────────────────────────────────────────

/**
 * Cache the v4 bearer token for the life of the plugin module. TVDB
 * tokens are valid for ~30 days; we refresh on 401. Executing many
 * actions in one identify batch would otherwise burn a login call per
 * action.
 */
let cachedToken: { apiKey: string; token: string } | null = null;

async function getToken(apiKey: string): Promise<string> {
  if (cachedToken && cachedToken.apiKey === apiKey) return cachedToken.token;
  const res = await fetch(`${TVDB_API}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: apiKey }),
  });
  if (!res.ok) throw new Error(`TVDB login failed: ${res.status}`);
  const data = (await res.json()) as TvdbLoginResponse;
  cachedToken = { apiKey, token: data.data.token };
  return cachedToken.token;
}

async function tvdbFetch<T>(
  path: string,
  apiKey: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${TVDB_API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const doFetch = async (token: string) =>
    fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

  let token = await getToken(apiKey);
  let res = await doFetch(token);

  // Retry once if the cached token expired.
  if (res.status === 401) {
    cachedToken = null;
    token = await getToken(apiKey);
    res = await doFetch(token);
  }

  if (!res.ok) {
    throw new Error(`TVDB API error: ${res.status} ${res.statusText} (${path})`);
  }
  const json = (await res.json()) as { data: T };
  return json.data;
}

// ─── Image helpers ────────────────────────────────────────────────

interface ImageCandidate {
  url: string;
  source: string;
  rank: number;
  language?: string | null;
  width?: number;
  height?: number;
  aspectRatio?: number;
}

function artworkCandidates(
  artworks: TvdbArtwork[] | undefined,
  typeIds: number[],
): ImageCandidate[] {
  if (!artworks?.length) return [];
  const matches = artworks.filter((a) => typeIds.includes(a.type));
  return matches
    .filter((a) => typeof a.image === "string" && a.image)
    .map<ImageCandidate>((a) => ({
      url: a.image,
      source: "tvdb",
      // TVDB scores are 0..10_000 range; project into a 0..10 band
      // so they sort sensibly next to TMDB vote averages if users ever
      // compare candidates across providers.
      rank:
        typeof a.score === "number"
          ? Math.min(10, a.score / 1000)
          : 0,
      language: a.language ?? null,
      width: typeof a.width === "number" ? a.width : undefined,
      height: typeof a.height === "number" ? a.height : undefined,
      aspectRatio:
        typeof a.width === "number" && typeof a.height === "number" && a.height > 0
          ? a.width / a.height
          : undefined,
    }))
    .sort((a, b) => b.rank - a.rank);
}

function mergeFallbackCandidate(
  candidates: ImageCandidate[],
  fallbackUrl: string | null | undefined,
  rank: number,
): ImageCandidate[] {
  if (!fallbackUrl) return candidates;
  if (candidates.some((c) => c.url === fallbackUrl)) return candidates;
  return [...candidates, { url: fallbackUrl, source: "tvdb", rank }];
}

function firstArtwork(
  artworks: TvdbArtwork[] | undefined,
  typeIds: number[],
): string | null {
  if (!artworks?.length) return null;
  for (const a of artworks) {
    if (typeIds.includes(a.type) && a.image) return a.image;
  }
  return null;
}

// ─── Status mapping ───────────────────────────────────────────────

function mapTvdbSeriesStatus(
  s: string | undefined,
): "returning" | "ended" | "canceled" | "unknown" | null {
  if (!s) return null;
  const l = s.toLowerCase();
  if (l.includes("cancel")) return "canceled";
  if (l.includes("ended")) return "ended";
  if (l.includes("continuing") || l.includes("returning") || l.includes("upcoming")) {
    return "returning";
  }
  return "unknown";
}

// ─── Cast ─────────────────────────────────────────────────────────

function topCast(
  characters: TvdbCharacter[] | undefined,
): Array<{
  name: string;
  character?: string | null;
  order?: number | null;
  profileUrl?: string | null;
}> {
  if (!characters?.length) return [];
  // Types 3/4 are actor roles; other types include guest stars, writers,
  // directors — we keep guest stars under guestStars on episodes and
  // surface actors here.
  const actors = characters.filter((c) => c.type === 3 || c.type === 4 || c.type == null);
  return actors
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .slice(0, 25)
    .map((c) => ({
      name: c.personName ?? "",
      character: c.name ?? null,
      order: typeof c.sort === "number" ? c.sort : null,
      profileUrl: c.personImgURL ?? null,
    }))
    .filter((c) => c.name);
}

// ─── Local-season parsing (shared with TMDB shape) ───────────────

interface LocalEpisodeDef {
  episodeNumber: number;
  localFilePath: string;
  title: string | null;
}

interface LocalSeasonDef {
  seasonNumber: number;
  episodes: LocalEpisodeDef[];
}

function parseLocalSeasons(
  input: Record<string, unknown>,
): LocalSeasonDef[] | null {
  const raw = input.localSeasons;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const bySeason = new Map<number, LocalEpisodeDef[]>();
  for (const item of raw) {
    if (typeof item !== "object" || !item) continue;
    const o = item as Record<string, unknown>;
    const sn =
      typeof o.seasonNumber === "number" ? o.seasonNumber : Number(o.seasonNumber);
    if (!Number.isFinite(sn)) continue;
    const acc = bySeason.get(sn) ?? [];
    const epsRaw = o.episodes;
    if (Array.isArray(epsRaw)) {
      for (const e of epsRaw) {
        if (typeof e !== "object" || !e) continue;
        const er = e as Record<string, unknown>;
        const en =
          typeof er.episodeNumber === "number"
            ? er.episodeNumber
            : Number(er.episodeNumber);
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

// ─── URL parsing ──────────────────────────────────────────────────

/**
 * Parse a thetvdb.com URL into a series id (and optionally season /
 * episode numbers). Supported shapes:
 *
 *   https://thetvdb.com/series/<slug>
 *   https://thetvdb.com/series/<slug>/seasons/official/1
 *   https://thetvdb.com/series/<slug>/episodes/<episode-id>
 *   https://thetvdb.com/dereferrer/series/<id>
 *   https://thetvdb.com/?tab=series&id=<id>
 *   https://thetvdb.com/dereferrer/episode/<episode-id>
 */
interface ParsedTvdbUrl {
  seriesSlug?: string;
  seriesId?: number;
  episodeId?: number;
  seasonNumber?: number;
}

function parseTvdbUrl(url: string): ParsedTvdbUrl | null {
  try {
    const u = new URL(url);
    if (!/thetvdb\.com$/.test(u.hostname.replace(/^www\./, ""))) return null;

    // /dereferrer/series/123  or  /dereferrer/episode/456
    const deref = u.pathname.match(/\/dereferrer\/(series|episode)\/(\d+)/i);
    if (deref) {
      if (deref[1].toLowerCase() === "episode") {
        return { episodeId: Number.parseInt(deref[2], 10) };
      }
      return { seriesId: Number.parseInt(deref[2], 10) };
    }

    // ?tab=series&id=123
    if (u.pathname === "/" || u.pathname === "") {
      const tab = u.searchParams.get("tab");
      const id = u.searchParams.get("id");
      if ((tab === "series" || tab === "seriesid") && id) {
        return { seriesId: Number.parseInt(id, 10) };
      }
    }

    // /series/<slug>/...
    const seriesMatch = u.pathname.match(/\/series\/([^/]+)/i);
    if (seriesMatch) {
      const slug = decodeURIComponent(seriesMatch[1]);
      // /series/<slug>/seasons/official/<n>
      const seasonMatch = u.pathname.match(/\/seasons\/[^/]+\/(\d+)/i);
      // /series/<slug>/episodes/<id>
      const episodeMatch = u.pathname.match(/\/episodes\/(\d+)/i);
      return {
        seriesSlug: slug,
        seasonNumber: seasonMatch ? Number.parseInt(seasonMatch[1], 10) : undefined,
        episodeId: episodeMatch ? Number.parseInt(episodeMatch[1], 10) : undefined,
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Query normalisation + scoring ────────────────────────────────

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
  for (const tok of ta) if (tb.has(tok)) inter += 1;
  const union = new Set([...ta, ...tb]).size;
  return inter / union;
}

function searchHitId(hit: TvdbSearchHit): number | null {
  // /search returns `tvdb_id` as the canonical numeric id. `id` is
  // the search-result record id (e.g. "series-71663") and not useful
  // for /series/{id} lookups.
  const raw = hit.tvdb_id ?? hit.id ?? hit.objectID;
  if (!raw) return null;
  const m = String(raw).match(/(\d+)$/);
  return m ? Number.parseInt(m[1], 10) : null;
}

function searchHitToCandidate(hit: TvdbSearchHit): Record<string, unknown> {
  const id = searchHitId(hit);
  return {
    externalIds: id ? { tvdb: String(id) } : {},
    title: hit.name ?? "",
    year: hit.year ? Number.parseInt(hit.year, 10) : null,
    overview:
      hit.overview ??
      hit.overviews?.eng ??
      (hit.overviews ? Object.values(hit.overviews)[0] : null) ??
      null,
    posterUrl: hit.image_url ?? hit.thumbnail ?? null,
    popularity: null,
  };
}

function extractTvdbIdOverride(input: Record<string, unknown>): number | null {
  const ext = input.externalIds;
  if (ext && typeof ext === "object") {
    const v = (ext as Record<string, unknown>).tvdb;
    if (typeof v === "string") {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) return n;
    }
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  const legacy = input.externalId;
  if (typeof legacy === "string") {
    const m = legacy.match(/^tvdb:(\d+)$/);
    if (m) return Number.parseInt(m[1], 10);
  }
  return null;
}

// ─── Series → normalized cascade ──────────────────────────────────

async function folderSeriesFromSeriesExtended(
  detail: TvdbSeriesExtended,
  input: Record<string, unknown>,
  apiKey: string,
  candidates?: Array<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const genres = (detail.genres ?? []).map((g) => g.name).filter(Boolean);
  const network =
    detail.originalNetwork?.name ??
    detail.latestNetwork?.name ??
    detail.companies?.[0]?.name ??
    null;

  // TVDB's /series/{id}/extended returns most artworks inline, but we
  // explicitly request the full artwork set (`meta=artworks`) below so
  // we get backdrops + clearart + logos the base response omits.
  const posterCandidates = mergeFallbackCandidate(
    artworkCandidates(detail.artworks, [ARTWORK_SERIES_POSTER]),
    detail.image ?? null,
    5,
  );
  const backdropCandidates = artworkCandidates(detail.artworks, [
    ARTWORK_SERIES_BACKGROUND,
    ARTWORK_SERIES_BANNER,
  ]);
  const logoCandidates = artworkCandidates(detail.artworks, [
    ARTWORK_SERIES_CLEARLOGO,
    ARTWORK_SERIES_CLEARART,
    ARTWORK_SERIES_ICON,
  ]);

  const seasonsOut: Array<Record<string, unknown>> = [];
  const local = parseLocalSeasons(input);

  if (local) {
    // Map local season numbers to TVDB season ids using the series's
    // "official" season-type entries. TVDB publishes multiple season
    // trees (official/dvd/absolute); we default to official.
    const officialSeasons =
      detail.seasons?.filter(
        (s) => s.type.type === "official" || s.type.name.toLowerCase() === "aired order",
      ) ?? detail.seasons ?? [];

    for (const loc of local) {
      const seasonStub = officialSeasons.find((s) => s.number === loc.seasonNumber);

      let seasonDetail: TvdbSeasonExtended | null = null;
      if (seasonStub) {
        try {
          seasonDetail = await tvdbFetch<TvdbSeasonExtended>(
            `/seasons/${seasonStub.id}/extended`,
            apiKey,
          );
        } catch {
          seasonDetail = null;
        }
      }

      const tvdbEps = seasonDetail?.episodes ?? [];

      const seasonPosterCandidates = mergeFallbackCandidate(
        artworkCandidates(seasonDetail?.artwork, [
          ARTWORK_SEASON_POSTER,
          ARTWORK_SEASON_BANNER,
        ]),
        seasonDetail?.image ?? seasonStub?.image ?? null,
        4,
      );

      const episodesOut = loc.episodes.map((le) => {
        const t = tvdbEps.find(
          (e) => (e.seasonNumber ?? loc.seasonNumber) === loc.seasonNumber && e.number === le.episodeNumber,
        );
        const matched = Boolean(t);
        return {
          seasonNumber: loc.seasonNumber,
          episodeNumber: le.episodeNumber,
          title: (t?.name ?? le.title) || null,
          overview: t?.overview ?? null,
          airDate: t?.aired ?? null,
          runtime: t?.runtime ?? null,
          stillCandidates: t?.image
            ? [{ url: t.image, source: "tvdb", rank: 5 }]
            : [],
          guestStars: [],
          externalIds: t?.id ? { tvdb: String(t.id) } : {},
          matched,
          localFilePath: le.localFilePath || null,
        };
      });

      seasonsOut.push({
        seasonNumber: loc.seasonNumber,
        title:
          seasonDetail?.name ??
          seasonStub?.name ??
          (loc.seasonNumber === 0 ? "Specials" : `Season ${loc.seasonNumber}`),
        overview: seasonDetail?.overview ?? null,
        airDate: null,
        posterCandidates: seasonPosterCandidates,
        externalIds: seasonStub?.id
          ? { tvdb: String(seasonStub.id) }
          : { tvdb: `${detail.id}_s${loc.seasonNumber}` },
        episodes: episodesOut,
      });
    }
  }

  const seriesUrl = detail.slug
    ? `https://thetvdb.com/series/${detail.slug}`
    : `https://thetvdb.com/dereferrer/series/${detail.id}`;

  return {
    title: detail.name,
    originalTitle:
      detail.translations?.nameTranslations?.find(
        (t) => t.language === detail.originalLanguage,
      )?.name ?? null,
    overview:
      detail.overview ??
      detail.translations?.overviewTranslations?.[0]?.overview ??
      null,
    tagline: null,
    firstAirDate: detail.firstAired ?? null,
    endAirDate: detail.lastAired ?? null,
    status: mapTvdbSeriesStatus(detail.status?.name),
    genres,
    studioName: network,
    cast: topCast(detail.characters),
    posterCandidates,
    backdropCandidates,
    logoCandidates,
    externalIds: { tvdb: String(detail.id) },
    seasons: seasonsOut,
    ...(candidates && candidates.length > 1 ? { candidates } : {}),
    // Legacy flat keys (identify row + rawResult consumers)
    name: detail.name,
    details: detail.overview ?? null,
    date: detail.firstAired ?? null,
    imageUrl:
      firstArtwork(detail.artworks, [ARTWORK_SERIES_POSTER]) ?? detail.image ?? null,
    backdropUrl: firstArtwork(detail.artworks, [
      ARTWORK_SERIES_BACKGROUND,
      ARTWORK_SERIES_BANNER,
    ]),
    tagNames: genres,
    urls: [seriesUrl],
    seriesExternalId: `tvdb:${detail.id}`,
    seasonCount: detail.seasons?.filter((s) => s.type.type === "official").length,
    totalEpisodes: undefined,
    folderByName: true,
  };
}

// ─── Actions ──────────────────────────────────────────────────────

async function folderByName(
  input: Record<string, unknown>,
  apiKey: string,
): Promise<Record<string, unknown> | null> {
  const override = extractTvdbIdOverride(input);
  if (override !== null) {
    const detail = await tvdbFetch<TvdbSeriesExtended>(
      `/series/${override}/extended`,
      apiKey,
      { meta: "translations" },
    );
    return folderSeriesFromSeriesExtended(detail, input, apiKey);
  }

  const query = (input.name as string) ?? (input.title as string) ?? "";
  if (!query) return null;
  const cleanQuery = normalizeQueryForMatch(query);
  if (!cleanQuery) return null;

  const hits = await tvdbFetch<TvdbSearchHit[]>(`/search`, apiKey, {
    query: cleanQuery,
    type: "series",
    limit: "20",
  });

  if (!hits || hits.length === 0) return null;

  const scored = hits
    .map((r, i) => ({
      r,
      score: titleSimilarity(query, r.name ?? ""),
      order: i,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.order - b.order;
    });

  const bestId = searchHitId(scored[0].r);
  if (bestId === null) return null;

  const candidates = scored
    .slice(0, 10)
    .map((s) => searchHitToCandidate(s.r))
    .filter((c) => (c.externalIds as Record<string, string>).tvdb);

  const detail = await tvdbFetch<TvdbSeriesExtended>(
    `/series/${bestId}/extended`,
    apiKey,
    { meta: "translations" },
  );

  return folderSeriesFromSeriesExtended(detail, input, apiKey, candidates);
}

async function videoByURL(
  input: Record<string, unknown>,
  apiKey: string,
): Promise<Record<string, unknown> | null> {
  const url = input.url as string;
  if (!url) return null;

  const parsed = parseTvdbUrl(url);
  if (!parsed) return null;

  // Episode URLs → fetch the single episode and build a scene-shaped
  // result the identify row can render.
  if (parsed.episodeId) {
    const ep = await tvdbFetch<TvdbEpisodeExtended>(
      `/episodes/${parsed.episodeId}/extended`,
      apiKey,
    );
    const series =
      ep.seriesId != null
        ? await tvdbFetch<TvdbSeriesExtended>(
            `/series/${ep.seriesId}/extended`,
            apiKey,
          ).catch(() => null)
        : null;
    const seriesName = series?.name ?? null;
    return {
      title: ep.name ?? null,
      date: ep.aired ?? null,
      details: ep.overview ?? null,
      urls: [
        series?.slug
          ? `https://thetvdb.com/series/${series.slug}/episodes/${ep.id}`
          : `https://thetvdb.com/dereferrer/episode/${ep.id}`,
      ],
      studioName: series?.originalNetwork?.name ?? null,
      cast: topCast(ep.characters ?? series?.characters),
      performerNames: topCast(ep.characters ?? series?.characters).map((c) => c.name),
      tagNames: (series?.genres ?? []).map((g) => g.name).filter(Boolean),
      imageUrl: ep.image ?? null,
      episodeNumber: ep.number ?? null,
      series: seriesName
        ? {
            name: seriesName,
            externalId: `tvdb:${ep.seriesId}`,
            season: ep.seasonNumber ?? undefined,
            episode: ep.number ?? undefined,
          }
        : null,
      code: null,
      director: null,
    };
  }

  // Series URLs — resolve slug or id, then return the normalized
  // series cascade (same shape as folderByName).
  let seriesId = parsed.seriesId ?? null;
  if (seriesId == null && parsed.seriesSlug) {
    const hits = await tvdbFetch<TvdbSearchHit[]>(`/search`, apiKey, {
      query: parsed.seriesSlug.replace(/-/g, " "),
      type: "series",
      limit: "5",
    });
    const slugHit = hits?.find((h) => h.slug === parsed.seriesSlug) ?? hits?.[0];
    if (slugHit) seriesId = searchHitId(slugHit);
  }
  if (seriesId == null) return null;

  const detail = await tvdbFetch<TvdbSeriesExtended>(
    `/series/${seriesId}/extended`,
    apiKey,
    { meta: "translations" },
  );
  return folderSeriesFromSeriesExtended(detail, input, apiKey);
}

async function folderCascade(
  input: Record<string, unknown>,
  apiKey: string,
): Promise<Record<string, unknown> | null> {
  const externalId = input.externalId as string;
  const seasonNumber = (input.seasonNumber as number | undefined) ?? 1;
  if (!externalId) return null;

  const idMatch = externalId.match(/^tvdb:(\d+)$/);
  if (!idMatch) return null;
  const seriesId = Number.parseInt(idMatch[1], 10);

  // Pull the series so we can locate the season-id for the requested
  // season number. TVDB needs the season id, not the number, to
  // fetch episodes.
  const detail = await tvdbFetch<TvdbSeriesExtended>(
    `/series/${seriesId}/extended`,
    apiKey,
  );

  const seasonStub = (detail.seasons ?? []).find(
    (s) =>
      s.number === seasonNumber &&
      (s.type.type === "official" || s.type.name.toLowerCase() === "aired order"),
  );

  if (!seasonStub) return null;

  const seasonDetail = await tvdbFetch<TvdbSeasonExtended>(
    `/seasons/${seasonStub.id}/extended`,
    apiKey,
  );

  if (!seasonDetail.episodes?.length) return null;

  const episodeMap: Record<string, Record<string, unknown>> = {};
  for (const ep of seasonDetail.episodes) {
    if (ep.number == null) continue;
    episodeMap[String(ep.number)] = {
      episodeNumber: ep.number,
      seasonNumber,
      title: ep.name ?? null,
      date: ep.aired ?? null,
      details: ep.overview ?? null,
    };
  }

  const seriesUrl = detail.slug
    ? `https://thetvdb.com/series/${detail.slug}`
    : `https://thetvdb.com/dereferrer/series/${detail.id}`;

  return {
    name: detail.name,
    details: detail.overview ?? null,
    date: detail.firstAired ?? null,
    imageUrl:
      firstArtwork(detail.artworks, [ARTWORK_SERIES_POSTER]) ?? detail.image ?? null,
    backdropUrl: firstArtwork(detail.artworks, [
      ARTWORK_SERIES_BACKGROUND,
      ARTWORK_SERIES_BANNER,
    ]),
    studioName: detail.originalNetwork?.name ?? null,
    tagNames: (detail.genres ?? []).map((g) => g.name).filter(Boolean),
    urls: [seriesUrl],
    seriesExternalId: `tvdb:${detail.id}`,
    seasonNumber,
    totalEpisodes: seasonDetail.episodes.length,
    episodeMap,
  };
}

// ─── Plugin export ────────────────────────────────────────────────

export default {
  capabilities: {
    videoByURL: true,
    folderByName: true,
    folderCascade: true,
    seriesByURL: true,
    seriesByName: true,
    seriesCascade: true,
  },

  async execute(
    action: string,
    input: Record<string, unknown>,
    auth: Record<string, string>,
  ): Promise<Record<string, unknown> | null> {
    const apiKey = auth.TVDB_API_KEY;
    if (!apiKey) throw new Error("TVDB_API_KEY is required");

    switch (action) {
      // Scene / video
      case "videoByURL":
        return videoByURL(input, apiKey);

      // Folder (pre-plan-C naming)
      case "folderByName":
      case "seriesByName":
        return folderByName(input, apiKey);
      case "folderCascade":
      case "seriesCascade":
        return folderCascade(input, apiKey);

      // Plan-C series-by-URL resolves to the same cascade as folderByName.
      case "seriesByURL":
        return videoByURL(input, apiKey);

      default:
        return null;
    }
  },
};
