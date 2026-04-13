/**
 * YouTube Plugin for Obscura
 *
 * Fetches video and audio metadata from YouTube URLs using the Data API v3.
 * Supports: videoByURL, audioByURL, batch mode
 */

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";

// Extract video ID from various YouTube URL formats
function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

interface YTVideo {
  snippet: {
    title: string;
    description: string;
    publishedAt: string;
    channelTitle: string;
    tags?: string[];
    thumbnails: {
      maxres?: { url: string };
      high?: { url: string };
      medium?: { url: string };
    };
  };
  contentDetails?: {
    duration: string;
  };
}

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
  ) {
    const apiKey = auth.YOUTUBE_API_KEY;
    if (!apiKey) throw new Error("YOUTUBE_API_KEY is required");

    if (action === "videoByURL" || action === "audioByURL") {
      const url = input.url as string;
      if (!url) return null;

      const videoId = extractVideoId(url);
      if (!videoId) return null;

      const res = await fetch(
        `${YT_API_BASE}/videos?id=${videoId}&part=snippet,contentDetails&key=${apiKey}`,
      );
      if (!res.ok) return null;

      const data = (await res.json()) as { items: YTVideo[] };
      const video = data.items?.[0];
      if (!video) return null;

      const thumb =
        video.snippet.thumbnails.maxres?.url ??
        video.snippet.thumbnails.high?.url ??
        video.snippet.thumbnails.medium?.url ??
        null;

      const date = video.snippet.publishedAt
        ? video.snippet.publishedAt.slice(0, 10)
        : null;

      return {
        title: video.snippet.title,
        date,
        details: video.snippet.description?.slice(0, 2000) ?? null,
        urls: [`https://www.youtube.com/watch?v=${videoId}`],
        studioName: video.snippet.channelTitle ?? null,
        performerNames: [],
        tagNames: video.snippet.tags?.slice(0, 20) ?? [],
        imageUrl: thumb,
        episodeNumber: null,
        series: null,
        code: null,
        director: null,
      };
    }

    return null;
  },

  async executeBatch(
    action: string,
    items: Array<{ id: string; input: Record<string, unknown> }>,
    auth: Record<string, string>,
  ) {
    // Fan out individual calls for simplicity
    const results = [];
    for (const item of items) {
      try {
        const result = await this.execute(action, item.input, auth);
        results.push({ id: item.id, result });
      } catch {
        results.push({ id: item.id, result: null });
      }
    }
    return results;
  },
};
