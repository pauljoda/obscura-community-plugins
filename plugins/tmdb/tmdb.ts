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
  networks?: Array<{ name: string }>;
  production_companies?: Array<{ name: string }>;
  seasons?: Array<{
    season_number: number;
    episode_count: number;
    name: string;
    air_date?: string;
    poster_path?: string;
  }>;
}

interface TmdbSeasonDetail {
  season_number: number;
  episodes: Array<{
    episode_number: number;
    name: string;
    overview?: string;
    air_date?: string;
    still_path?: string;
    runtime?: number;
  }>;
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

async function folderByName(
  input: Record<string, unknown>,
  apiKey: string,
): Promise<Record<string, unknown> | null> {
  const query = (input.name as string) ?? (input.title as string) ?? "";
  if (!query) return null;

  // Search specifically for TV shows
  const data = await tmdbFetch<{ results: TmdbSearchResult[] }>(
    "/search/tv",
    apiKey,
    { query, include_adult: "true" },
  );

  if (!data.results?.length) {
    // Fallback: try multi-search in case it's a movie franchise folder
    const multiData = await tmdbFetch<{ results: TmdbSearchResult[] }>(
      "/search/multi",
      apiKey,
      { query, include_adult: "true" },
    );
    const tvResult = multiData.results?.find((r) => r.media_type === "tv");
    if (!tvResult) return null;

    const detail = await tmdbFetch<TmdbTvDetail>(`/tv/${tvResult.id}`, apiKey);
    return tvToFolderResult(detail);
  }

  const best = data.results[0];
  const detail = await tmdbFetch<TmdbTvDetail>(`/tv/${best.id}`, apiKey);
  return tvToFolderResult(detail);
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
    ...tvToFolderResult(tvDetail),
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

function tvToFolderResult(detail: TmdbTvDetail): Record<string, unknown> {
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
    seasonNumber: detail.number_of_seasons ?? undefined,
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
