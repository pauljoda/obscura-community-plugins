/**
 * TMDB Plugin for Obscura
 *
 * Identifies movies and TV series using The Movie Database API v3.
 * Supports: folderByName, videoByURL, videoByName, folderCascade
 */

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

interface SearchResult {
  id: number;
  name?: string;
  title?: string;
  first_air_date?: string;
  release_date?: string;
  overview?: string;
  poster_path?: string;
  backdrop_path?: string;
  media_type?: string;
}

export default {
  capabilities: {
    folderByName: true,
    videoByURL: true,
    videoByName: true,
    folderCascade: true,
  },

  async execute(
    action: string,
    input: Record<string, unknown>,
    auth: Record<string, string>,
  ) {
    const apiKey = auth.TMDB_API_KEY;
    if (!apiKey) throw new Error("TMDB_API_KEY is required");

    if (action === "folderByName" || action === "videoByName") {
      const query = (input.name as string) ?? (input.title as string) ?? "";
      const res = await fetch(
        `${TMDB_API_BASE}/search/multi?api_key=${apiKey}&query=${encodeURIComponent(query)}`,
      );
      if (!res.ok) return null;

      const data = (await res.json()) as { results: SearchResult[] };
      const best = data.results?.[0];
      if (!best) return null;

      const title = best.name ?? best.title ?? null;
      const date = best.first_air_date ?? best.release_date ?? null;
      const posterUrl = best.poster_path
        ? `${TMDB_IMAGE_BASE}/w500${best.poster_path}`
        : null;
      const backdropUrl = best.backdrop_path
        ? `${TMDB_IMAGE_BASE}/w1280${best.backdrop_path}`
        : null;

      if (action === "folderByName") {
        return {
          name: title,
          date,
          details: best.overview ?? null,
          imageUrl: posterUrl,
          backdropUrl,
          studioName: null,
          tagNames: [],
          urls: [`https://www.themoviedb.org/${best.media_type ?? "movie"}/${best.id}`],
          seriesExternalId: `tmdb:${best.id}`,
        };
      }

      return {
        title,
        date,
        details: best.overview ?? null,
        urls: [`https://www.themoviedb.org/${best.media_type ?? "movie"}/${best.id}`],
        studioName: null,
        performerNames: [],
        tagNames: [],
        imageUrl: posterUrl,
        episodeNumber: null,
        series: null,
        code: null,
        director: null,
      };
    }

    // TODO: Implement videoByURL, folderCascade
    return null;
  },
};
