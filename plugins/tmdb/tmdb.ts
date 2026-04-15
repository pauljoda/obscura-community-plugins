/**
 * TMDB Plugin for Obscura
 *
 * Identifies movies, TV series, seasons, and episodes using The Movie Database API v3.
 *
 * Capabilities:
 * - videoByName: search for movies/TV by title
 * - videoByURL: extract metadata from TMDB URLs
 * - folderByName: search for TV series by folder name
 * - folderCascade: map a resolved series+season to episode metadata for child scenes
 */

const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p";

// ─── TMDB API response types ──────────────────────────────────────

interface TmdbSearchResult {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string;
  backdrop_path?: string;
  genre_ids?: number[];
  vote_average?: number;
}

interface TmdbMovieDetail {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  overview?: string;
  poster_path?: string;
  backdrop_path?: string;
  genres?: Array<{ id: number; name: string }>;
  runtime?: number;
  tagline?: string;
  production_companies?: Array<{ name: string }>;
  credits?: {
    cast?: Array<{ name: string; character?: string; order: number }>;
    crew?: Array<{ name: string; job: string }>;
  };
}

interface TmdbTvDetail {
  id: number;
  name: string;
  original_name?: string;
  first_air_date?: string;
  last_air_date?: string;
  overview?: string;
  poster_path?: string;
  backdrop_path?: string;
  genres?: Array<{ id: number; name: string }>;
  number_of_seasons?: number;
  number_of_episodes?: number;
  status?: string;
  networks?: Array<{ name: string }>;
  production_companies?: Array<{ name: string }>;
  seasons?: Array<{
    season_number: number;
    episode_count: number;
    name: string;
    air_date?: string;
    poster_path?: string;
  }>;
  credits?: {
    cast?: Array<{ name: string; character?: string; order: number }>;
  };
}

interface TmdbSeasonDetail {
  id?: number;
  season_number: number;
  name?: string;
  overview?: string;
  air_date?: string;
  poster_path?: string;
  episodes: Array<{
    id: number;
    episode_number: number;
    name: string;
    overview?: string;
    air_date?: string;
    still_path?: string;
    runtime?: number;
  }>;
}

/** TMDB `/images` endpoint response shape — same for tv / movie / season. */
interface TmdbImagesResponse {
  posters?: TmdbImageEntry[];
  backdrops?: TmdbImageEntry[];
  logos?: TmdbImageEntry[];
  stills?: TmdbImageEntry[];
}

interface TmdbImageEntry {
  file_path: string;
  width?: number;
  height?: number;
  aspect_ratio?: number;
  iso_639_1?: string | null;
  vote_average?: number;
  vote_count?: number;
}

// ─── API helpers ──────────────────────────────────────────────────

async function tmdbFetch<T>(path: string, apiKey: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${TMDB_API}${path}`);
  url.searchParams.set("api_key", apiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`TMDB API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

function posterUrl(path: string | null | undefined, size = "w500"): string | null {
  return path ? `${TMDB_IMG}/${size}${path}` : null;
}

function backdropUrl(path: string | null | undefined, size = "w1280"): string | null {
  return path ? `${TMDB_IMG}/${size}${path}` : null;
}

function tmdbUrl(mediaType: string, id: number): string {
  return `https://www.themoviedb.org/${mediaType}/${id}`;
}

function stillUrl(path: string | null | undefined, size = "w780"): string | null {
  return path ? `${TMDB_IMG}/${size}${path}` : null;
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

/**
 * Legacy single-candidate helper kept for the flat legacy fields
 * below. Prefer `imgCandidatesFrom()` / `mapImageEntries()` for real
 * cascade results where TMDB exposes multiple images.
 */
function imgCand(url: string | null | undefined, rank = 5): ImageCandidate[] {
  if (!url) return [];
  return [{ url, source: "tmdb", rank }];
}

/** Map a TMDB `posters[]` / `backdrops[]` / `stills[]` / `logos[]` array. */
function mapImageEntries(
  entries: TmdbImageEntry[] | undefined,
  imageKind: "poster" | "backdrop" | "logo" | "still",
): ImageCandidate[] {
  if (!entries || entries.length === 0) return [];
  // Pick a reasonable render size per kind. `original` is
  // appropriate for posters and backdrops since the cascade drawer
  // shows them full-size; stills are much smaller so `w780` saves
  // bandwidth without visibly degrading the preview.
  const size =
    imageKind === "still"
      ? "w780"
      : imageKind === "logo"
        ? "w500"
        : "original";
  return entries
    .filter((e) => typeof e.file_path === "string" && e.file_path)
    .map<ImageCandidate>((e) => ({
      url: `${TMDB_IMG}/${size}${e.file_path}`,
      source: "tmdb",
      // TMDB's vote_average is a rough popularity/quality signal in
      // [0, 10]. The picker sorts descending by rank, so surfacing it
      // directly gives us a sensible default ordering.
      rank: typeof e.vote_average === "number" ? e.vote_average : 0,
      language: e.iso_639_1 ?? null,
      width: typeof e.width === "number" ? e.width : undefined,
      height: typeof e.height === "number" ? e.height : undefined,
      aspectRatio:
        typeof e.aspect_ratio === "number" ? e.aspect_ratio : undefined,
    }));
}

/**
 * Merge a fallback single-URL (e.g. the poster_path on the main
 * detail response) into an image-candidate list if that URL isn't
 * already present. Ensures we always have *something* in the slot
 * even if the `/images` endpoint is missing or filtered empty.
 */
function mergeFallbackCandidate(
  candidates: ImageCandidate[],
  fallbackUrl: string | null,
  rank: number,
): ImageCandidate[] {
  if (!fallbackUrl) return candidates;
  if (candidates.some((c) => c.url === fallbackUrl)) return candidates;
  return [...candidates, { url: fallbackUrl, source: "tmdb", rank }];
}

function mapTmdbSeriesStatus(
  s: string | undefined,
): "returning" | "ended" | "canceled" | "unknown" | null {
  if (!s) return null;
  const l = s.toLowerCase();
  if (l.includes("canceled") || l.includes("cancelled")) return "canceled";
  if (l.includes("ended")) return "ended";
  if (
    l.includes("return") ||
    l.includes("production") ||
    l.includes("pilot") ||
    l.includes("planned")
  ) {
    return "returning";
  }
  return "unknown";
}

function topCast(detail: TmdbTvDetail): Array<{
  name: string;
  character?: string | null;
  order?: number | null;
}> {
  const rows = detail.credits?.cast ?? [];
  return rows
    .sort((a, b) => a.order - b.order)
    .slice(0, 25)
    .map((c) => ({
      name: c.name,
      character: c.character ?? null,
      order: c.order,
    }));
}

interface LocalEpisodeDef {
  episodeNumber: number;
  localFilePath: string;
  title: string | null;
}

interface LocalSeasonDef {
  seasonNumber: number;
  episodes: LocalEpisodeDef[];
}

/** Parsed from Obscura identify — only seasons/episodes the user actually has on disk. */
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
        const en = typeof er.episodeNumber === "number" ? er.episodeNumber : Number(er.episodeNumber);
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

function parseTmdbUrl(url: string): { mediaType: string; id: number } | null {
  // https://www.themoviedb.org/movie/12345-slug
  // https://www.themoviedb.org/tv/12345-slug
  // https://www.themoviedb.org/tv/12345/season/1/episode/3
  const match = url.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);
  if (!match) return null;
  return { mediaType: match[1], id: parseInt(match[2], 10) };
}

// ─── Action implementations ───────────────────────────────────────

async function videoByName(
  input: Record<string, unknown>,
  apiKey: string,
): Promise<Record<string, unknown> | null> {
  const query = (input.name as string) ?? (input.title as string) ?? "";
  if (!query) return null;

  const data = await tmdbFetch<{ results: TmdbSearchResult[] }>(
    "/search/multi",
    apiKey,
    { query, include_adult: "true" },
  );

  const results = (data.results ?? []).filter(
    (r) => r.media_type === "movie" || r.media_type === "tv",
  );

  if (results.length === 0) return null;

  const best = results[0];
  const isMovie = best.media_type === "movie";

  // Fetch full details for credits
  if (isMovie) {
    const detail = await tmdbFetch<TmdbMovieDetail>(
      `/movie/${best.id}`,
      apiKey,
      { append_to_response: "credits" },
    );
    return movieToVideoResult(detail);
  } else {
    const detail = await tmdbFetch<TmdbTvDetail>(`/tv/${best.id}`, apiKey);
    return tvToVideoResult(detail);
  }
}

async function videoByURL(
  input: Record<string, unknown>,
  apiKey: string,
): Promise<Record<string, unknown> | null> {
  const url = input.url as string;
  if (!url) return null;

  const parsed = parseTmdbUrl(url);
  if (!parsed) return null;

  if (parsed.mediaType === "movie") {
    const detail = await tmdbFetch<TmdbMovieDetail>(
      `/movie/${parsed.id}`,
      apiKey,
      { append_to_response: "credits" },
    );
    return movieToVideoResult(detail);
  } else {
    const detail = await tmdbFetch<TmdbTvDetail>(`/tv/${parsed.id}`, apiKey);
    return tvToVideoResult(detail);
  }
}

async function folderSeriesFromTvDetail(
  detail: TmdbTvDetail,
  input: Record<string, unknown>,
  apiKey: string,
  candidates?: Array<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const genres = (detail.genres ?? []).map((g) => g.name);
  const network =
    detail.networks?.[0]?.name ?? detail.production_companies?.[0]?.name ?? null;

  // Fetch the full series image set up front — TMDB exposes a
  // `/tv/{id}/images` endpoint with arrays of posters, backdrops,
  // and logos at multiple sizes and languages. Without this call we
  // only get the single poster_path / backdrop_path on the detail
  // response, which is the bug users saw as "only one image to
  // select." Failure here is non-fatal: we fall through to the
  // single-URL fields.
  let seriesImages: TmdbImagesResponse = {};
  try {
    seriesImages = await tmdbFetch<TmdbImagesResponse>(
      `/tv/${detail.id}/images`,
      apiKey,
      // `include_image_language=en,null` gives us English + untagged
      // language-agnostic art. The picker can still filter language
      // client-side if the user wants a specific locale.
      { include_image_language: "en,null" },
    );
  } catch {
    // Treat as best-effort; fall back to the single-URL paths below.
  }
  const posterCandidates = mergeFallbackCandidate(
    mapImageEntries(seriesImages.posters, "poster"),
    posterUrl(detail.poster_path, "original"),
    10,
  );
  const backdropCandidates = mergeFallbackCandidate(
    mapImageEntries(seriesImages.backdrops, "backdrop"),
    backdropUrl(detail.backdrop_path, "original"),
    9,
  );
  const logoCandidates = mapImageEntries(seriesImages.logos, "logo");

  const seasonsOut: Array<Record<string, unknown>> = [];
  const local = parseLocalSeasons(input);

  if (local) {
    for (const loc of local) {
      let seasonDetail: TmdbSeasonDetail;
      try {
        seasonDetail = await tmdbFetch<TmdbSeasonDetail>(
          `/tv/${detail.id}/season/${loc.seasonNumber}`,
          apiKey,
        );
      } catch {
        seasonsOut.push({
          seasonNumber: loc.seasonNumber,
          title: loc.seasonNumber === 0 ? "Specials" : `Season ${loc.seasonNumber}`,
          overview: null,
          airDate: null,
          posterCandidates: [],
          externalIds: { tmdb: `${detail.id}_s${loc.seasonNumber}` },
          episodes: loc.episodes.map((le) => ({
            seasonNumber: loc.seasonNumber,
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
          })),
        });
        continue;
      }

      const stub = detail.seasons?.find((s) => s.season_number === loc.seasonNumber);
      const tmdbEps = seasonDetail.episodes ?? [];

      // Best-effort per-season image set. Same failure model as the
      // series-level fetch: on error we fall through to the single
      // `seasonDetail.poster_path` URL so the picker is never empty.
      let seasonImages: TmdbImagesResponse = {};
      try {
        seasonImages = await tmdbFetch<TmdbImagesResponse>(
          `/tv/${detail.id}/season/${loc.seasonNumber}/images`,
          apiKey,
          { include_image_language: "en,null" },
        );
      } catch {
        // leave empty
      }
      const seasonPosterCandidates = mergeFallbackCandidate(
        mapImageEntries(seasonImages.posters, "poster"),
        posterUrl(seasonDetail.poster_path, "original"),
        6,
      );

      const episodesOut = loc.episodes.map((le) => {
        const t = tmdbEps.find((e) => e.episode_number === le.episodeNumber);
        const matched = Boolean(t);
        const still = stillUrl(t?.still_path);
        return {
          seasonNumber: loc.seasonNumber,
          episodeNumber: le.episodeNumber,
          title: (t?.name ?? le.title) || null,
          overview: t?.overview ?? null,
          airDate: t?.air_date ?? null,
          runtime: t?.runtime ?? null,
          stillCandidates: imgCand(still, 8),
          guestStars: [] as Array<Record<string, unknown>>,
          externalIds: t?.id ? { tmdb: String(t.id) } : {},
          matched,
          localFilePath: le.localFilePath || null,
        };
      });

      seasonsOut.push({
        seasonNumber: loc.seasonNumber,
        title:
          seasonDetail.name ??
          stub?.name ??
          (loc.seasonNumber === 0 ? "Specials" : `Season ${loc.seasonNumber}`),
        overview: seasonDetail.overview ?? null,
        airDate: seasonDetail.air_date ?? stub?.air_date ?? null,
        posterCandidates: seasonPosterCandidates,
        externalIds: seasonDetail.id
          ? { tmdb: String(seasonDetail.id) }
          : { tmdb: `${detail.id}_s${loc.seasonNumber}` },
        episodes: episodesOut,
      });
    }
  }

  return {
    title: detail.name,
    originalTitle: detail.original_name ?? null,
    overview: detail.overview ?? null,
    tagline: null,
    firstAirDate: detail.first_air_date ?? null,
    endAirDate: detail.last_air_date ?? null,
    status: mapTmdbSeriesStatus(detail.status),
    genres,
    studioName: network,
    cast: topCast(detail),
    posterCandidates,
    backdropCandidates,
    logoCandidates,
    externalIds: { tmdb: String(detail.id) },
    seasons: seasonsOut,
    // Disambiguation candidates — populated only when the caller
    // passed more than one search result through. The review drawer
    // uses this to render a picker above the series header.
    ...(candidates && candidates.length > 1 ? { candidates } : {}),
    // Legacy flat keys (identify row + rawResult consumers)
    name: detail.name,
    details: detail.overview ?? null,
    date: detail.first_air_date ?? null,
    imageUrl: posterUrl(detail.poster_path),
    backdropUrl: backdropUrl(detail.backdrop_path),
    tagNames: genres,
    urls: [tmdbUrl("tv", detail.id)],
    seriesExternalId: `tmdb:${detail.id}`,
    seasonCount: detail.number_of_seasons ?? undefined,
    totalEpisodes: detail.number_of_episodes ?? undefined,
    folderByName: true,
  };
}

/** Tokenize + normalize a query so we can score candidates manually. */
function normalizeQueryForMatch(raw: string): string {
  return raw
    .toLowerCase()
    // Strip trailing bangs and stray punctuation that TMDB search handles
    // as wildcards rather than exact matches.
    .replace(/[!?.'"`]/g, "")
    // Collapse "Blue's Clues and You!" → "blues clues and you".
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Simple token-set similarity in [0, 1]. */
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

/**
 * Extract a TMDB id out of either an explicit `externalIds.tmdb`
 * override or the `externalId: "tmdb:12345"` flat key the legacy
 * folder-cascade action used. The cascade review drawer passes
 * `externalIds.tmdb` when the user picks a disambiguation candidate.
 */
function extractTmdbIdOverride(input: Record<string, unknown>): number | null {
  const ext = input.externalIds;
  if (ext && typeof ext === "object") {
    const tmdb = (ext as Record<string, unknown>).tmdb;
    if (typeof tmdb === "string") {
      const n = Number.parseInt(tmdb, 10);
      if (Number.isFinite(n)) return n;
    }
    if (typeof tmdb === "number" && Number.isFinite(tmdb)) return tmdb;
  }
  const legacy = input.externalId;
  if (typeof legacy === "string") {
    const m = legacy.match(/^tmdb:(\d+)$/);
    if (m) return Number.parseInt(m[1], 10);
  }
  return null;
}

function searchResultToCandidate(r: TmdbSearchResult): Record<string, unknown> {
  return {
    externalIds: { tmdb: String(r.id) },
    title: r.name ?? r.title ?? "",
    year: r.first_air_date
      ? Number.parseInt(r.first_air_date.slice(0, 4), 10)
      : null,
    overview: r.overview ?? null,
    posterUrl: posterUrl(r.poster_path, "w342"),
    popularity: typeof r.vote_average === "number" ? r.vote_average : null,
  };
}

async function folderByName(
  input: Record<string, unknown>,
  apiKey: string,
): Promise<Record<string, unknown> | null> {
  // Direct-fetch bypass: the cascade review drawer re-runs this
  // action with `{ externalIds: { tmdb } }` when the user picks a
  // disambiguation candidate. When that's set we skip the search
  // entirely and go straight to `/tv/{id}`.
  const override = extractTmdbIdOverride(input);
  if (override !== null) {
    const detail = await tmdbFetch<TmdbTvDetail>(`/tv/${override}`, apiKey, {
      append_to_response: "credits",
    });
    return folderSeriesFromTvDetail(detail, input, apiKey);
  }

  const query = (input.name as string) ?? (input.title as string) ?? "";
  if (!query) return null;

  // Clean the query before hitting TMDB. A trailing "!" or stray
  // punctuation turns TMDB's search into a fuzzy wildcard match —
  // which is how "Blue's Clues and You!" ends up returning "Blue's
  // Clues and You! Nursery Rhymes" as the top hit. Normalizing to
  // plain words gives the search scorer something deterministic to
  // work with.
  const cleanQuery = normalizeQueryForMatch(query);

  let searchResults: TmdbSearchResult[] = [];

  if (cleanQuery) {
    const data = await tmdbFetch<{ results: TmdbSearchResult[] }>(
      "/search/tv",
      apiKey,
      { query: cleanQuery, include_adult: "true" },
    );
    searchResults = data.results ?? [];
  }
  if (searchResults.length === 0) {
    const multiData = await tmdbFetch<{ results: TmdbSearchResult[] }>(
      "/search/multi",
      apiKey,
      { query: cleanQuery || query, include_adult: "true" },
    );
    searchResults = (multiData.results ?? []).filter(
      (r) => r.media_type === "tv",
    );
  }
  if (searchResults.length === 0) return null;

  // Re-score the top results against the normalized query and sort
  // by similarity descending; fall back to TMDB's own ordering as
  // the tiebreaker. Take the highest-scoring match as the "best"
  // result, and hand the top 10 back to the UI so the user can
  // correct the match if our pick is wrong.
  const scored = searchResults
    .slice(0, 20)
    .map((r, i) => ({
      r,
      score: titleSimilarity(query, r.name ?? r.title ?? ""),
      order: i,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.order - b.order;
    });

  const best = scored[0].r;
  const candidates = scored.slice(0, 10).map((s) => searchResultToCandidate(s.r));

  const detail = await tmdbFetch<TmdbTvDetail>(`/tv/${best.id}`, apiKey, {
    append_to_response: "credits",
  });

  return folderSeriesFromTvDetail(detail, input, apiKey, candidates);
}

async function folderCascade(
  input: Record<string, unknown>,
  apiKey: string,
): Promise<Record<string, unknown> | null> {
  const externalId = input.externalId as string;
  const seasonNumber = input.seasonNumber as number | undefined;

  if (!externalId) return null;

  // Parse "tmdb:12345" format
  const idMatch = externalId.match(/^tmdb:(\d+)$/);
  if (!idMatch) return null;
  const tvId = parseInt(idMatch[1], 10);

  // If no season specified, get season 1
  const season = seasonNumber ?? 1;

  const seasonDetail = await tmdbFetch<TmdbSeasonDetail>(
    `/tv/${tvId}/season/${season}`,
    apiKey,
  );

  if (!seasonDetail.episodes?.length) return null;

  // Build episode map keyed by episode number (as string)
  const episodeMap: Record<string, Record<string, unknown>> = {};
  for (const ep of seasonDetail.episodes) {
    episodeMap[String(ep.episode_number)] = {
      episodeNumber: ep.episode_number,
      seasonNumber: season,
      title: ep.name ?? null,
      date: ep.air_date ?? null,
      details: ep.overview ?? null,
    };
  }

  // Also get the series info for the folder result
  const tvDetail = await tmdbFetch<TmdbTvDetail>(`/tv/${tvId}`, apiKey);

  return {
    ...tvFlatLegacy(tvDetail),
    episodeMap,
  };
}

// ─── Result builders ──────────────────────────────────────────────

function movieToVideoResult(detail: TmdbMovieDetail): Record<string, unknown> {
  const director = detail.credits?.crew?.find((c) => c.job === "Director")?.name ?? null;
  const cast = (detail.credits?.cast ?? [])
    .sort((a, b) => a.order - b.order)
    .slice(0, 20)
    .map((c) => c.name);
  const studio = detail.production_companies?.[0]?.name ?? null;
  const genres = (detail.genres ?? []).map((g) => g.name);

  return {
    title: detail.title,
    date: detail.release_date ?? null,
    details: detail.overview ?? null,
    urls: [tmdbUrl("movie", detail.id)],
    studioName: studio,
    performerNames: cast,
    tagNames: genres,
    imageUrl: posterUrl(detail.poster_path),
    episodeNumber: null,
    series: null,
    code: null,
    director,
  };
}

function tvToVideoResult(detail: TmdbTvDetail): Record<string, unknown> {
  const network = detail.networks?.[0]?.name ?? detail.production_companies?.[0]?.name ?? null;
  const genres = (detail.genres ?? []).map((g) => g.name);

  return {
    title: detail.name,
    date: detail.first_air_date ?? null,
    details: detail.overview ?? null,
    urls: [tmdbUrl("tv", detail.id)],
    studioName: network,
    performerNames: [],
    tagNames: genres,
    imageUrl: posterUrl(detail.poster_path),
    episodeNumber: null,
    series: {
      name: detail.name,
      externalId: `tmdb:${detail.id}`,
    },
    code: null,
    director: null,
  };
}

/** Flat folder-shaped fields without the full `NormalizedSeriesResult` cascade. */
function tvFlatLegacy(detail: TmdbTvDetail): Record<string, unknown> {
  const network = detail.networks?.[0]?.name ?? detail.production_companies?.[0]?.name ?? null;
  const genres = (detail.genres ?? []).map((g) => g.name);

  return {
    name: detail.name,
    details: detail.overview ?? null,
    date: detail.first_air_date ?? null,
    imageUrl: posterUrl(detail.poster_path),
    backdropUrl: backdropUrl(detail.backdrop_path),
    studioName: network,
    tagNames: genres,
    urls: [tmdbUrl("tv", detail.id)],
    seriesExternalId: `tmdb:${detail.id}`,
    seasonCount: detail.number_of_seasons ?? undefined,
    totalEpisodes: detail.number_of_episodes ?? undefined,
  };
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
    auth: Record<string, string>,
  ): Promise<Record<string, unknown> | null> {
    const apiKey = auth.TMDB_API_KEY;
    if (!apiKey) throw new Error("TMDB_API_KEY is required");

    switch (action) {
      case "videoByName":
        return videoByName(input, apiKey);
      case "videoByURL":
        return videoByURL(input, apiKey);
      case "folderByName":
        return folderByName(input, apiKey);
      case "folderCascade":
        return folderCascade(input, apiKey);
      default:
        return null;
    }
  },
};
