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
 * - folderByName:   search for a series by folder name; auto-merges
 *                   AniList's separate-Media-per-cour entries (S1/S2/S3)
 *                   into a single series via PREQUEL/SEQUEL chain walking
 * - folderCascade:  return per-episode metadata for a given season of a chain
 *
 * Rate limit: 30 req/min per IP. Each handler does at most ~1 fetch per
 * season in the chain (capped at MAX_CHAIN_DEPTH).
 */
Object.defineProperty(exports, "__esModule", { value: true });
const ANILIST_API = "https://graphql.anilist.co";
const ANILIST_WEB = "https://anilist.co";
const USER_AGENT = "Obscura-AniList-Plugin/0.3.0";
// Stop walking the SEQUEL/PREQUEL chain after this many entries to
// bound API calls and protect against pathological cycles.
const MAX_CHAIN_DEPTH = 10;
// Only relations whose linked Media has these formats count as "next
// season" hops. Movies/ONAs/specials remain as separate disambiguation
// candidates rather than getting folded in as a season.
const TV_CHAIN_FORMATS = new Set(["TV", "TV_SHORT"]);
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
/**
 * AniList descriptions still contain HTML even with `asHtml: false` —
 * `<br>`, `<i>`, `<b>`, occasional `<p>`, plus the usual entity escapes.
 * Convert to plain text the UI can render directly: `<br>` becomes a
 * newline, paragraph structure is preserved, other tags are dropped.
 */
function stripHtml(s) {
    if (!s)
        return null;
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
        overview: stripHtml(m.description),
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
    const byNum = new Map();
    if (trustStreaming) {
        for (const se of seList) {
            const n = parseStreamingEpisodeNumber(se.title);
            if (n !== null && !byNum.has(n))
                byNum.set(n, se);
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
// ─── Season chain walking ─────────────────────────────────────────
/** Find the first ANIME-type relation edge of a given type, any format. */
function pickAnyAnimeRelation(m, relationType) {
    for (const e of m.relations?.edges ?? []) {
        if (e.relationType !== relationType)
            continue;
        if (e.node?.type !== "ANIME")
            continue;
        return e.node.id;
    }
    return null;
}
/**
 * Walk SEQUEL/PREQUEL relations to assemble a default seasons list.
 *
 * Anime sequel chains aren't always pure TV → TV. Dr. STONE has a
 * 1-episode SPECIAL (RYUSUI) bridging S2 and S3; if we filtered out
 * non-TV during traversal we'd stop at S2 and miss everything after.
 * So we walk through *any* anime format but only include TV/TV_SHORT
 * in the returned chain. Bridges (movies, specials, OVAs) get
 * traversed silently and surfaced separately via `seasonOptions`.
 *
 * Returns the chain in season order — index 0 is "Season 1".
 */
async function walkSeasonChain(rootMedia, fetchById = fetchMediaById) {
    const cache = new Map([[rootMedia.id, rootMedia]]);
    // Walk PREQUEL backward through any anime format.
    let earliest = rootMedia;
    for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
        const prequelId = pickAnyAnimeRelation(earliest, "PREQUEL");
        if (prequelId === null || cache.has(prequelId))
            break;
        const prev = await fetchById(prequelId);
        if (!prev)
            break;
        cache.set(prev.id, prev);
        earliest = prev;
    }
    // The earliest entry might itself be a non-TV bridge (e.g. a
    // prequel movie). Skip forward until we land on TV-format.
    for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
        if (TV_CHAIN_FORMATS.has(earliest.format ?? ""))
            break;
        const nextId = pickAnyAnimeRelation(earliest, "SEQUEL");
        if (nextId === null || cache.has(nextId))
            break;
        const next = await fetchById(nextId);
        if (!next)
            break;
        cache.set(next.id, next);
        earliest = next;
    }
    // Walk SEQUEL forward, traversing through any anime format but
    // collecting only TV/TV_SHORT into the returned chain.
    const chain = [];
    const seen = new Set([earliest.id]);
    if (TV_CHAIN_FORMATS.has(earliest.format ?? ""))
        chain.push(earliest);
    let current = earliest;
    for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
        const sequelId = pickAnyAnimeRelation(current, "SEQUEL");
        if (sequelId === null || seen.has(sequelId))
            break;
        seen.add(sequelId);
        let next = cache.get(sequelId) ?? null;
        if (!next) {
            next = await fetchById(sequelId);
            if (!next)
                break;
            cache.set(next.id, next);
        }
        if (TV_CHAIN_FORMATS.has(next.format ?? ""))
            chain.push(next);
        current = next;
        if (chain.length >= MAX_CHAIN_DEPTH)
            break;
    }
    // Always return at least the root if it's TV-format and we somehow
    // ended up with an empty chain (root with no SEQUEL/PREQUEL).
    if (chain.length === 0 && TV_CHAIN_FORMATS.has(rootMedia.format ?? "")) {
        chain.push(rootMedia);
    }
    return chain;
}
// ─── Related Media gather (for seasonOptions picker) ──────────────
/**
 * Lightweight Media projection used in the seasonOptions picker.
 * Just enough for the host UI to render a card and let the user pick
 * which AniList Media maps to which season on disk.
 */
const RELATED_MEDIA_FIELDS = `
  id
  title { romaji english native }
  format
  episodes
  status
  startDate { year }
  seasonYear
  coverImage { large medium }
  averageScore
  popularity
  siteUrl
  description(asHtml: false)
`;
const RELATED_MEDIA_QUERY = `
  query ($ids: [Int]) {
    Page(perPage: 50) {
      media(id_in: $ids, type: ANIME) {
        ${RELATED_MEDIA_FIELDS}
      }
    }
  }
`;
/**
 * One-hop neighborhood of the chain: every ANIME-type Media linked
 * from any chain entry's `relations` (sequels, prequels, side stories,
 * alternative versions, recap movies, specials, etc.) that isn't
 * already in the chain. Bulk-fetched in a single Page query.
 */
async function fetchRelatedAnime(chain) {
    const chainIds = new Set(chain.map((m) => m.id));
    const relatedIds = new Set();
    for (const m of chain) {
        for (const e of m.relations?.edges ?? []) {
            const node = e.node;
            if (!node || node.type !== "ANIME")
                continue;
            if (chainIds.has(node.id))
                continue;
            relatedIds.add(node.id);
        }
    }
    if (relatedIds.size === 0)
        return [];
    const data = await anilistFetch(RELATED_MEDIA_QUERY, { ids: [...relatedIds] });
    return data.Page?.media ?? [];
}
function mediaToSeasonOption(m, relationLabel) {
    return {
        externalIds: { anilist: String(m.id) },
        title: pickTitle(m.title),
        year: m.seasonYear ?? m.startDate?.year ?? null,
        format: m.format ?? null,
        episodes: typeof m.episodes === "number" ? m.episodes : null,
        status: mapStatus(m.status),
        posterUrl: pickPosterUrl(m.coverImage),
        overview: stripHtml(m.description),
        siteUrl: m.siteUrl ?? null,
        averageScore: typeof m.averageScore === "number" ? m.averageScore : null,
        popularity: typeof m.popularity === "number" ? m.popularity : null,
        relation: relationLabel ?? null,
    };
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
        series: m.format && m.format !== "MOVIE"
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
function buildLocalOnlySeasonRecord(ls) {
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
function buildSeasonRecord(m, seasonNumber, localEpisodes) {
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
 *
 * `seasonOptions` exposes every related anime Media (chain members
 * plus one-hop relations of any format) so the host UI can let the
 * user manually re-map any season to a different AniList entry —
 * essential for anime where specials, OVAs, recap movies, and
 * alternative versions blur the "season" concept.
 */
function chainToFolderResult(chain, input, candidates, related) {
    const head = chain[0];
    const title = pickTitle(head.title);
    const genres = head.genres ?? [];
    const cast = castFromCharacters(head.characters?.edges);
    const studio = pickStudio(head.studios);
    const local = parseLocalSeasons(input);
    const seasons = [];
    const claimedSeasonNumbers = new Set();
    chain.forEach((m, i) => {
        const seasonNumber = i + 1;
        claimedSeasonNumbers.add(seasonNumber);
        const localForSeason = local?.find((s) => s.seasonNumber === seasonNumber)?.episodes ?? null;
        seasons.push(buildSeasonRecord(m, seasonNumber, localForSeason));
    });
    // The chain only covers what AniList knows about. If the user has
    // local seasons numbered outside the chain (mis-numbered folders,
    // an OVA collection labeled "Season 4", etc.), surface them too so
    // the cascade UI doesn't silently drop the user's files.
    if (local) {
        for (const ls of local) {
            if (claimedSeasonNumbers.has(ls.seasonNumber))
                continue;
            seasons.push(buildLocalOnlySeasonRecord(ls));
        }
        seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);
    }
    // Headline air dates span the chain.
    const firstAirDate = fuzzyDateToString(head.startDate);
    const endAirDate = fuzzyDateToString(chain[chain.length - 1].endDate);
    const totalEpisodes = chain.reduce((acc, m) => acc + (m.episodes ?? 0), 0);
    const lastStatus = mapStatus(chain[chain.length - 1].status);
    // Build the per-season picker list: chain entries first (in season
    // order), then related Media sorted by year so the user can pick
    // logical "this is my season X" mappings.
    const chainOptions = chain.map((m, i) => mediaToSeasonOption(m, `Season ${i + 1}`));
    const relatedOptions = (related ?? [])
        .slice()
        .sort((a, b) => {
        const ay = a.seasonYear ?? a.startDate?.year ?? 9999;
        const by = b.seasonYear ?? b.startDate?.year ?? 9999;
        return ay - by;
    })
        .map((m) => mediaToSeasonOption(m));
    const seasonOptions = [...chainOptions, ...relatedOptions];
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
        seasonOptions,
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
 * Build the cascade response for a single picked Media. The host is
 * expected to pass the per-season `externalIds.anilist` from the
 * `seasons[]` array (or a user-overridden pick from `seasonOptions`),
 * so we trust the externalId literally and emit the episode map for
 * that exact Media — no chain walking. This lets users manually map
 * any AniList Media (a special, a recap movie, an alternative
 * version) to any season slot on disk.
 */
function mediaToCascadeResult(m, seasonNumber) {
    const episodes = buildEpisodeRecords(m, null);
    const episodeMap = {};
    for (const e of episodes) {
        episodeMap[String(e.episodeNumber)] = {
            episodeNumber: e.episodeNumber,
            seasonNumber,
            title: e.title,
            date: null,
            details: null,
        };
    }
    return {
        name: pickTitle(m.title),
        details: stripHtml(m.description),
        date: fuzzyDateToString(m.startDate),
        imageUrl: pickPosterUrl(m.coverImage),
        backdropUrl: m.bannerImage ?? null,
        studioName: pickStudio(m.studios),
        tagNames: m.genres ?? [],
        urls: [mediaSiteUrl(m)],
        seriesExternalId: `anilist:${m.id}`,
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
    // The cascade drawer re-resolves with `externalIds.anilist` when
    // the user picks a candidate. Respect that pick literally — return
    // a single-Media folder result rather than walking the chain, or
    // the user's selection silently re-anchors back to chain head and
    // the UI shows no change. We still gather related Media so the
    // seasonOptions picker stays populated.
    const override = extractAniListIdOverride(input);
    if (override !== null) {
        const m = await fetchMediaById(override);
        if (!m)
            return null;
        const related = await fetchRelatedAnime([m]).catch(() => []);
        return chainToFolderResult([m], input, undefined, related);
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
    // Only expand to a chain when the best match is TV-format. A movie
    // or OVA pick stands alone as a single "season"; the user can
    // still see the related TV series via seasonOptions.
    const chain = TV_CHAIN_FORMATS.has(best.format ?? "")
        ? await walkSeasonChain(best)
        : [best];
    // Walk the relations of every chain entry so seasonOptions covers
    // bridges and side stories the chain hides.
    const related = await fetchRelatedAnime(chain).catch(() => []);
    // Filter chain members out of the candidates list — they're folded
    // into the seasons array now, so showing them as separate picks is
    // confusing. Movies, OVAs, and specials remain.
    const chainIds = new Set(chain.map((m) => m.id));
    const candidates = scored
        .slice(0, 10)
        .filter((s) => !chainIds.has(s.m.id))
        .map((s) => mediaToCandidate(s.m));
    return chainToFolderResult(chain, input, candidates, related);
}
async function folderCascade(input) {
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
    if (!media)
        return null;
    // The host is expected to pass the per-season `externalIds.anilist`
    // from `seasons[]` (or a user override from `seasonOptions`); we
    // trust it literally rather than re-deriving via chain walking,
    // which would silently override user picks.
    const seasonNumber = typeof input.seasonNumber === "number" ? input.seasonNumber : 1;
    return mediaToCascadeResult(media, seasonNumber);
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
