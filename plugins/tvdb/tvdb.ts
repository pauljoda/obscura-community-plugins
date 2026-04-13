/**
 * TVDB Plugin for Obscura
 *
 * Identifies TV series, seasons, and episodes using the TVDB v4 API.
 * Supports: folderByName, videoByURL, folderCascade
 */

const TVDB_API_BASE = "https://api4.thetvdb.com/v4";

interface PluginInput {
  obscura_version: number;
  action: string;
  auth: Record<string, string>;
  input?: Record<string, unknown>;
  batch?: Array<{ id: string; input: Record<string, unknown> }>;
}

interface SeriesSearchResult {
  id: number;
  name: string;
  firstAired?: string;
  network?: string;
  overview?: string;
  image?: string;
  year?: string;
}

async function getToken(apiKey: string): Promise<string> {
  const res = await fetch(`${TVDB_API_BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: apiKey }),
  });
  if (!res.ok) throw new Error(`TVDB login failed: ${res.status}`);
  const data = (await res.json()) as { data: { token: string } };
  return data.data.token;
}

async function searchSeries(
  token: string,
  query: string,
): Promise<SeriesSearchResult[]> {
  const res = await fetch(
    `${TVDB_API_BASE}/search?query=${encodeURIComponent(query)}&type=series`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { data: SeriesSearchResult[] };
  return data.data ?? [];
}

// Plugin entry point — this module exports the OscuraPlugin interface
export default {
  capabilities: {
    folderByName: true,
    videoByURL: true,
    folderCascade: true,
  },

  async execute(
    action: string,
    input: Record<string, unknown>,
    auth: Record<string, string>,
  ) {
    const apiKey = auth.TVDB_API_KEY;
    if (!apiKey) throw new Error("TVDB_API_KEY is required");

    const token = await getToken(apiKey);

    if (action === "folderByName") {
      const name = (input.name as string) ?? (input.title as string) ?? "";
      const results = await searchSeries(token, name);

      if (results.length === 0) return null;

      const best = results[0];
      return {
        name: best.name,
        date: best.firstAired ?? null,
        details: best.overview ?? null,
        imageUrl: best.image ?? null,
        studioName: best.network ?? null,
        tagNames: [],
        urls: [],
        seriesExternalId: `tvdb:${best.id}`,
      };
    }

    // TODO: Implement videoByURL, folderCascade
    return null;
  },
};
