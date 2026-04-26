"use strict";
/**
 * AniList Plugin for Obscura
 *
 * Identifies anime (TV series, movies, OVAs, ONAs, specials) using the
 * AniList public GraphQL API. No authentication required.
 *
 * Capabilities:
 * - videoByName:    search anime by title, return single best match
 * - videoByURL:     resolve https://anilist.co/anime/{id} URLs
 * - folderByName:   search for a series by folder name with disambiguation candidates
 * - folderCascade:  re-resolve a chosen series + return per-episode metadata
 *
 * Rate limit: 30 req/min per IP. Each call is a single POST.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const ANILIST_API = "https://graphql.anilist.co";
const ANILIST_WEB = "https://anilist.co";
const USER_AGENT = "Obscura-AniList-Plugin/0.1.0";
// ─── GraphQL helper ───────────────────────────────────────────────
async function anilistFetch(query, variables) {
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
        throw new Error(`AniList API error: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    const json = (await res.json());
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
function parseAniListUrl(url) {
    // https://anilist.co/anime/12345 or .../anime/12345/Slug
    const m = url.match(/anilist\.co\/anime\/(\d+)/i);
    if (!m)
        return null;
    return { id: Number.parseInt(m[1], 10) };
}
function extractAniListIdOverride(input) {
    const ext = input.externalIds;
    if (ext && typeof ext === "object") {
        const v = ext.anilist;
        if (typeof v === "string") {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n))
                return n;
        }
        if (typeof v === "number" && Number.isFinite(v))
            return v;
    }
    const legacy = input.externalId;
    if (typeof legacy === "string") {
        const m = legacy.match(/^anilist:(\d+)$/);
        if (m)
            return Number.parseInt(m[1], 10);
    }
    return null;
}
// ─── Mappers ──────────────────────────────────────────────────────
function pickTitle(t) {
    if (!t)
        return "";
    return t.english || t.romaji || t.native || "";
}
function originalTitle(t) {
    if (!t)
        return null;
    // If we displayed english as the canonical title, prefer romaji as
    // the "original"; otherwise fall back to native.
    if (t.english && t.romaji && t.english !== t.romaji)
        return t.romaji ?? null;
    return t.native ?? t.romaji ?? null;
}
function fuzzyDateToString(d) {
    if (!d || !d.year)
        return null;
    const y = String(d.year).padStart(4, "0");
    if (!d.month)
        return y;
    const mo = String(d.month).padStart(2, "0");
    if (!d.day)
        return `${y}-${mo}`;
    const da = String(d.day).padStart(2, "0");
    return `${y}-${mo}-${da}`;
}
function mapStatus(s) {
    if (!s)
        return null;
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
function coverCandidates(img) {
    if (!img)
        return [];
    const out = [];
    if (img.extraLarge)
        out.push({ url: img.extraLarge, source: "anilist", rank: 10 });
    if (img.large && img.large !== img.extraLarge) {
        out.push({ url: img.large, source: "anilist", rank: 8 });
    }
    if (img.medium && img.medium !== img.large && img.medium !== img.extraLarge) {
        out.push({ url: img.medium, source: "anilist", rank: 5 });
    }
    return out;
}
function bannerCandidates(banner) {
    if (!banner)
        return [];
    return [{ url: banner, source: "anilist", rank: 9 }];
}
function pickPosterUrl(img) {
    if (!img)
        return null;
    return img.extraLarge || img.large || img.medium || null;
}
function pickStudio(studios) {
    const nodes = studios?.nodes ?? [];
    const animation = nodes.find((s) => s.isAnimationStudio);
    return animation?.name ?? nodes[0]?.name ?? null;
}
function castFromCharacters(edges) {
    if (!edges || edges.length === 0)
        return [];
    const ROLE_ORDER = {
        MAIN: 0,
        SUPPORTING: 1,
        BACKGROUND: 2,
    };
    return edges
        .map((e, i) => {
        const va = e.voiceActors?.[0];
        // Skip entries without a voice actor — for cast purposes the seiyuu
        // is the "name". The character name lives in the `character` field.
        if (!va)
            return null;
        const name = va.name?.full ?? null;
        if (!name)
            return null;
        return {
            name,
            character: e.node?.name?.full ?? null,
            order: (ROLE_ORDER[e.role ?? ""] ?? 9) * 1000 + i,
            profileUrl: va.image?.large ?? null,
        };
    })
        .filter((x) => x !== null)
        .sort((a, b) => a.order - b.order)
        .slice(0, 25);
}
function mediaSiteUrl(m) {
    return m.siteUrl || `${ANILIST_WEB}/anime/${m.id}`;
}
function mediaToCandidate(m) {
    return {
        externalIds: { anilist: String(m.id) },
        title: pickTitle(m.title),
        year: m.seasonYear ?? m.startDate?.year ?? null,
        overview: m.description ?? null,
        posterUrl: pickPosterUrl(m.coverImage),
        popularity: typeof m.averageScore === "number" ? m.averageScore : null,
        format: m.format ?? null,
    };
}
// ─── Title scoring (mirrors tmdb.ts) ──────────────────────────────
function normalizeQueryForMatch(raw) {
    return raw
        .toLowerCase()
        .replace(/[!?.'"`]/g, "")
        .replace(/[^a-z0-9\s]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function titleSimilarity(a, b) {
    const ta = new Set(normalizeQueryForMatch(a).split(" ").filter(Boolean));
    const tb = new Set(normalizeQueryForMatch(b).split(" ").filter(Boolean));
    if (ta.size === 0 || tb.size === 0)
        return 0;
    let inter = 0;
    for (const tok of ta) {
        if (tb.has(tok))
            inter += 1;
    }
    const union = new Set([...ta, ...tb]).size;
    return inter / union;
}
/** Best similarity across romaji/english/native. */
function bestTitleSimilarity(query, t) {
    if (!t)
        return 0;
    const candidates = [t.english, t.romaji, t.native].filter((x) => typeof x === "string" && x.length > 0);
    let best = 0;
    for (const c of candidates) {
        const s = titleSimilarity(query, c);
        if (s > best)
            best = s;
    }
    return best;
}
function parseLocalSeasons(input) {
    const raw = input.localSeasons;
    if (!Array.isArray(raw) || raw.length === 0)
        return null;
    const bySeason = new Map();
    for (const item of raw) {
        if (typeof item !== "object" || !item)
            continue;
        const o = item;
        const sn = typeof o.seasonNumber === "number" ? o.seasonNumber : Number(o.seasonNumber);
        if (!Number.isFinite(sn))
            continue;
        const acc = bySeason.get(sn) ?? [];
        const epsRaw = o.episodes;
        if (Array.isArray(epsRaw)) {
            for (const e of epsRaw) {
                if (typeof e !== "object" || !e)
                    continue;
                const er = e;
                const en = typeof er.episodeNumber === "number" ? er.episodeNumber : Number(er.episodeNumber);
                if (!Number.isFinite(en))
                    continue;
                acc.push({
                    episodeNumber: en,
                    localFilePath: typeof er.localFilePath === "string" ? er.localFilePath : "",
                    title: typeof er.title === "string" ? er.title : null,
                });
            }
        }
        bySeason.set(sn, acc);
    }
    if (bySeason.size === 0)
        return null;
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
function parseStreamingEpisodeNumber(title) {
    if (!title)
        return null;
    const m = title.match(/^\s*(?:episode|ep\.?)\s*(\d+)/i);
    return m ? Number.parseInt(m[1], 10) : null;
}
function streamingEpisodeTitle(title) {
    if (!title)
        return null;
    // Strip "Episode N - " prefix so the title is just the episode name.
    return title.replace(/^\s*(?:episode|ep\.?)\s*\d+\s*[-–:]\s*/i, "").trim() || title;
}
function buildEpisodeRecords(m, local) {
    // Index AniList's streaming episodes by number for O(1) lookup.
    const byNum = new Map();
    for (const se of m.streamingEpisodes ?? []) {
        const n = parseStreamingEpisodeNumber(se.title);
        if (n !== null && !byNum.has(n))
            byNum.set(n, se);
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
            };
        });
    }
    // No local layout: emit one record per known episode number, taking
    // the count from the streaming list's max or `m.episodes`.
    const total = Math.max(m.episodes ?? 0, byNum.size > 0 ? Math.max(...byNum.keys()) : 0);
    if (total === 0)
        return [];
    const out = [];
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
// ─── Result builders ──────────────────────────────────────────────
function mediaToVideoResult(m) {
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
        overview: m.description ?? null,
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
        details: m.description ?? null,
        urls: [url],
        performerNames: cast.map((c) => c.name),
        tagNames: genres,
        imageUrl: poster,
        episodeNumber: null,
        series: m.format && m.format !== "MOVIE"
            ? { name: title, externalId: `anilist:${m.id}` }
            : null,
        code: null,
        director: null,
    };
}
function mediaToFolderResult(m, input, candidates) {
    const title = pickTitle(m.title);
    const genres = m.genres ?? [];
    const cast = castFromCharacters(m.characters?.edges);
    const studio = pickStudio(m.studios);
    const local = parseLocalSeasons(input);
    // AniList models each "season" of an anime as its own Media entry
    // (Attack on Titan S1 / S2 / Final etc. have separate IDs), so the
    // series we resolved IS one season. Surface a single seasonNumber: 1
    // populated either from the user's local layout or from streamingEpisodes.
    const localSeason1 = local?.find((s) => s.seasonNumber === 1) ?? local?.[0];
    const episodes = buildEpisodeRecords(m, localSeason1?.episodes);
    const seasons = episodes.length > 0
        ? [
            {
                seasonNumber: 1,
                title: title || "Season 1",
                overview: m.description ?? null,
                airDate: fuzzyDateToString(m.startDate),
                posterCandidates: coverCandidates(m.coverImage),
                externalIds: { anilist: String(m.id) },
                episodes,
            },
        ]
        : [];
    return {
        title,
        originalTitle: originalTitle(m.title),
        overview: m.description ?? null,
        tagline: null,
        firstAirDate: fuzzyDateToString(m.startDate),
        endAirDate: fuzzyDateToString(m.endDate),
        status: mapStatus(m.status),
        genres,
        studioName: studio,
        cast,
        posterCandidates: coverCandidates(m.coverImage),
        backdropCandidates: bannerCandidates(m.bannerImage),
        logoCandidates: [],
        externalIds: { anilist: String(m.id), ...(m.idMal ? { mal: String(m.idMal) } : {}) },
        seasons,
        ...(candidates && candidates.length > 1 ? { candidates } : {}),
        // Legacy flat keys
        name: title,
        details: m.description ?? null,
        date: fuzzyDateToString(m.startDate),
        imageUrl: pickPosterUrl(m.coverImage),
        backdropUrl: m.bannerImage ?? null,
        tagNames: genres,
        urls: [mediaSiteUrl(m)],
        seriesExternalId: `anilist:${m.id}`,
        seasonCount: 1,
        totalEpisodes: m.episodes ?? undefined,
        folderByName: true,
    };
}
function mediaToCascadeResult(m) {
    const episodes = buildEpisodeRecords(m, null);
    const episodeMap = {};
    for (const e of episodes) {
        episodeMap[String(e.episodeNumber)] = {
            episodeNumber: e.episodeNumber,
            seasonNumber: 1,
            title: e.title,
            date: null,
            details: null,
        };
    }
    const title = pickTitle(m.title);
    return {
        name: title,
        details: m.description ?? null,
        date: fuzzyDateToString(m.startDate),
        imageUrl: pickPosterUrl(m.coverImage),
        backdropUrl: m.bannerImage ?? null,
        studioName: pickStudio(m.studios),
        tagNames: m.genres ?? [],
        urls: [mediaSiteUrl(m)],
        seriesExternalId: `anilist:${m.id}`,
        seasonCount: 1,
        totalEpisodes: m.episodes ?? undefined,
        episodeMap,
    };
}
// ─── Action handlers ──────────────────────────────────────────────
function getAllowNsfw(input) {
    return input.allowNsfw === true;
}
async function fetchMediaById(id) {
    const data = await anilistFetch(MEDIA_DETAIL_QUERY, { id });
    return data.Media ?? null;
}
async function searchMedia(query, allowNsfw) {
    const data = await anilistFetch(allowNsfw ? MEDIA_SEARCH_QUERY_ALL : MEDIA_SEARCH_QUERY_SFW, { search: query });
    return data.Page?.media ?? [];
}
async function videoByName(input) {
    const query = input.name ?? input.title ?? "";
    if (!query)
        return null;
    const cleanQuery = normalizeQueryForMatch(query) || query;
    const results = await searchMedia(cleanQuery, getAllowNsfw(input));
    if (results.length === 0)
        return null;
    // Re-rank by title similarity to be robust against AniList's fuzzy
    // search occasionally surfacing a sequel ahead of the original.
    const best = results
        .map((m, i) => ({ m, score: bestTitleSimilarity(query, m.title), i }))
        .sort((a, b) => (b.score - a.score) || (a.i - b.i))[0].m;
    return mediaToVideoResult(best);
}
async function videoByURL(input) {
    const url = input.url;
    if (!url)
        return null;
    const parsed = parseAniListUrl(url);
    if (!parsed)
        return null;
    const media = await fetchMediaById(parsed.id);
    return media ? mediaToVideoResult(media) : null;
}
async function folderByName(input) {
    // Cascade drawer re-resolves with explicit ID after disambiguation —
    // skip the search and go straight to /Media.
    const override = extractAniListIdOverride(input);
    if (override !== null) {
        const m = await fetchMediaById(override);
        return m ? mediaToFolderResult(m, input) : null;
    }
    const query = input.name ?? input.title ?? "";
    if (!query)
        return null;
    const cleanQuery = normalizeQueryForMatch(query) || query;
    const results = await searchMedia(cleanQuery, getAllowNsfw(input));
    if (results.length === 0)
        return null;
    const scored = results
        .map((m, i) => ({ m, score: bestTitleSimilarity(query, m.title), order: i }))
        .sort((a, b) => (b.score - a.score) || (a.order - b.order));
    const best = scored[0].m;
    const candidates = scored.slice(0, 10).map((s) => mediaToCandidate(s.m));
    return mediaToFolderResult(best, input, candidates);
}
async function folderCascade(input) {
    // `seasonNumber` from the host is intentionally ignored — AniList
    // models each anime cour/season as its own Media entry, so the
    // externalId already pins us to the right season.
    const override = extractAniListIdOverride(input);
    let id = override;
    if (id === null) {
        const externalId = input.externalId;
        if (!externalId)
            return null;
        const m = externalId.match(/^anilist:(\d+)$/);
        if (!m)
            return null;
        id = Number.parseInt(m[1], 10);
    }
    const media = await fetchMediaById(id);
    return media ? mediaToCascadeResult(media) : null;
}
// ─── Plugin export ────────────────────────────────────────────────
exports.default = {
    capabilities: {
        videoByURL: true,
        videoByName: true,
        folderByName: true,
        folderCascade: true,
    },
    async execute(action, input, _auth) {
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
