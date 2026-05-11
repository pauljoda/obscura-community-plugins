/**
 * MangaDex Plugin for Obscura
 *
 * Identifies manga/comic books using MangaDex title and chapter metadata.
 */

const MANGADEX_API = "https://api.mangadex.org";
const MANGADEX_AUTH =
  "https://auth.mangadex.org/realms/mangadex/protocol/openid-connect/token";
const MANGADEX_WEB = "https://mangadex.org";
const MANGADEX_UPLOADS = "https://uploads.mangadex.org";
const USER_AGENT = "Obscura-MangaDex-Plugin/0.1.9";
const SFW_CONTENT_RATINGS = ["safe", "suggestive"];
const ALL_CONTENT_RATINGS = ["safe", "suggestive", "erotica", "pornographic"];
const DEFAULT_LANGUAGE = "en";
const MAX_CANDIDATES = 20;
const MAX_IMAGE_CANDIDATES = 20;
const CHAPTER_FEED_PAGE_SIZE = 100;
const CHAPTER_COVER_FETCH_CONCURRENCY = 4;

interface MangaDexRelationship {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

interface MangaDexTag {
  id: string;
  type: "tag";
  attributes?: {
    name?: Record<string, string>;
    group?: string;
  };
}

interface MangaAttributes {
  title?: Record<string, string>;
  altTitles?: Array<Record<string, string>>;
  description?: Record<string, string>;
  year?: number | null;
  status?: string | null;
  contentRating?: string | null;
  publicationDemographic?: string | null;
  originalLanguage?: string | null;
  tags?: MangaDexTag[];
}

interface MangaResource {
  id: string;
  type: "manga";
  attributes?: MangaAttributes;
  relationships?: MangaDexRelationship[];
}

interface ChapterAttributes {
  title?: string | null;
  volume?: string | null;
  chapter?: string | null;
  translatedLanguage?: string | null;
  publishAt?: string | null;
  readableAt?: string | null;
}

interface ChapterResource {
  id: string;
  type: "chapter";
  attributes?: ChapterAttributes;
  relationships?: MangaDexRelationship[];
}

interface CoverResource {
  id: string;
  type: "cover_art";
  attributes?: {
    fileName?: string | null;
    volume?: string | null;
    locale?: string | null;
  };
  relationships?: MangaDexRelationship[];
}

interface ApiSingle<T> {
  result: string;
  data: T;
}

interface ApiList<T> {
  result: string;
  data: T[];
  limit?: number;
  offset?: number;
  total?: number;
}

interface BookCandidate {
  externalIds: Record<string, string>;
  title: string;
  year?: number | null;
  overview?: string | null;
  posterUrl?: string | null;
  language?: string | null;
  contentRating?: string | null;
  source?: string | null;
}

interface ImageCandidate {
  url: string;
  language?: string | null;
  width?: number;
  height?: number;
  aspectRatio?: number;
  rank?: number;
  source: string;
}

interface VolumeCover extends ImageCandidate {
  volumeNumber: string;
  title?: string | null;
  externalIds?: Record<string, string>;
}

interface AtHomeServerResponse {
  result?: string;
  baseUrl: string;
  chapter?: {
    hash?: string;
    data?: string[];
    dataSaver?: string[];
  };
}

interface AggregateChapter {
  chapter?: string | null;
}

interface AggregateVolume {
  volume?: string | null;
  chapters?: Record<string, AggregateChapter>;
}

interface AggregateResponse {
  result?: string;
  volumes?: Record<string, AggregateVolume>;
}

interface AuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

interface TokenCache {
  cacheKey: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

function requiredAuth(auth: Record<string, string>, key: string): string {
  const value = auth[key]?.trim();
  if (!value) throw new Error(`MangaDex auth is missing ${key}`);
  return value;
}

function authCacheKey(auth: Record<string, string>): string {
  return `${auth.MANGADEX_CLIENT_ID ?? ""}:${auth.MANGADEX_USERNAME ?? ""}`;
}

async function requestToken(
  auth: Record<string, string>,
  grant: "password" | "refresh_token",
): Promise<TokenCache> {
  const clientId = requiredAuth(auth, "MANGADEX_CLIENT_ID");
  const clientSecret = requiredAuth(auth, "MANGADEX_CLIENT_SECRET");
  const body = new URLSearchParams({
    grant_type: grant,
    client_id: clientId,
    client_secret: clientSecret,
  });

  if (grant === "password") {
    body.set("username", requiredAuth(auth, "MANGADEX_USERNAME"));
    body.set("password", requiredAuth(auth, "MANGADEX_PASSWORD"));
  } else {
    if (!tokenCache?.refreshToken) throw new Error("No MangaDex refresh token is cached");
    body.set("refresh_token", tokenCache.refreshToken);
  }

  const res = await fetch(MANGADEX_AUTH, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `MangaDex auth failed: ${res.status} ${res.statusText}${text ? ` - ${text.slice(0, 200)}` : ""}`,
    );
  }

  const json = (await res.json()) as AuthTokenResponse;
  if (!json.access_token) throw new Error("MangaDex auth returned no access token");

  tokenCache = {
    cacheKey: authCacheKey(auth),
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? tokenCache?.refreshToken,
    expiresAt: Date.now() + Math.max(60, json.expires_in ?? 900) * 1000,
  };
  return tokenCache;
}

async function accessToken(auth: Record<string, string>, forceRefresh = false): Promise<string> {
  const key = authCacheKey(auth);
  if (
    !forceRefresh &&
    tokenCache?.cacheKey === key &&
    tokenCache.expiresAt - Date.now() > 60_000
  ) {
    return tokenCache.accessToken;
  }

  if (tokenCache?.cacheKey === key && tokenCache.refreshToken) {
    try {
      return (await requestToken(auth, "refresh_token")).accessToken;
    } catch {
      tokenCache = null;
    }
  }

  return (await requestToken(auth, "password")).accessToken;
}

function appendParams(url: URL, params: Record<string, string | string[] | undefined>) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, value);
    }
  }
}

async function mangadexFetch<T>(
  path: string,
  auth: Record<string, string>,
  params: Record<string, string | string[] | undefined> = {},
  retried = false,
): Promise<T> {
  const url = new URL(`${MANGADEX_API}${path}`);
  appendParams(url, params);
  const token = await accessToken(auth, retried);
  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    },
  });

  if (res.status === 401 && !retried) {
    return mangadexFetch<T>(path, auth, params, true);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `MangaDex API error: ${res.status} ${res.statusText}${text ? ` - ${text.slice(0, 200)}` : ""}`,
    );
  }
  return res.json() as Promise<T>;
}

function parseMangaDexUrl(url: string): { kind: "manga" | "chapter"; id: string } | null {
  const match = url.match(/mangadex\.org\/(?:title|manga|chapter)\/([0-9a-f-]{36})/i);
  if (!match) return null;
  const kind = /mangadex\.org\/chapter\//i.test(url) ? "chapter" : "manga";
  return { kind, id: match[1] };
}

function mangaUrl(id: string): string {
  return `${MANGADEX_WEB}/title/${id}`;
}

function chapterUrl(id: string): string {
  return `${MANGADEX_WEB}/chapter/${id}`;
}

function localized(
  values: Record<string, string> | undefined,
  language = DEFAULT_LANGUAGE,
): { text: string | null; language: string | null } {
  if (!values) return { text: null, language: null };
  if (values[language]) return { text: values[language], language };
  if (values.en) return { text: values.en, language: "en" };
  const first = Object.entries(values).find(([, value]) => value?.trim());
  return first ? { text: first[1], language: first[0] } : { text: null, language: null };
}

function allTitles(manga: MangaResource): Array<{ title: string; language: string }> {
  const attrs = manga.attributes ?? {};
  const rows: Array<{ title: string; language: string }> = [];
  for (const source of [attrs.title, ...(attrs.altTitles ?? [])]) {
    if (!source) continue;
    for (const [language, title] of Object.entries(source)) {
      const trimmed = title.trim();
      if (trimmed) rows.push({ title: trimmed, language });
    }
  }

  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.language}:${row.title.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function preferredTitle(manga: MangaResource, language = DEFAULT_LANGUAGE) {
  const direct = localized(manga.attributes?.title, language);
  if (direct.text) return direct;
  const titles = allTitles(manga);
  const alt = titles.find((title) => title.language === language) ?? titles[0];
  return alt ? { text: alt.title, language: alt.language } : { text: null, language: null };
}

function selectedTitle(
  manga: MangaResource,
  language: string,
  title: string | undefined,
): { text: string; language: string } | null {
  const trimmed = title?.trim();
  if (!trimmed) return null;
  const titles = allTitles(manga);
  const exact =
    titles.find((row) => row.title === trimmed && row.language === language) ??
    titles.find((row) => row.title === trimmed);
  return exact ? { text: exact.title, language: exact.language } : null;
}

function coverUrlFromFileName(mangaId: string, fileName: unknown): string | null {
  if (typeof fileName !== "string" || !fileName) return null;
  return `${MANGADEX_UPLOADS}/covers/${mangaId}/${fileName}.512.jpg`;
}

function coverUrl(manga: MangaResource): string | null {
  const cover = manga.relationships?.find((rel) => rel.type === "cover_art");
  return coverUrlFromFileName(manga.id, cover?.attributes?.fileName);
}

function coverResourceUrl(mangaId: string, cover: CoverResource): string | null {
  return coverUrlFromFileName(mangaId, cover.attributes?.fileName);
}

function coverVolume(cover: CoverResource): string | null {
  const volume = cover.attributes?.volume?.trim();
  return volume || null;
}

function languagePriority(
  language: string | null | undefined,
  preferredLanguage: string | null | undefined,
  fallbackLanguage: string | null | undefined,
): number {
  const normalizedLanguage = language?.trim().toLowerCase();
  const preferred = uniqueStrings([
    preferredLanguage,
    preferredLanguage === DEFAULT_LANGUAGE ? null : DEFAULT_LANGUAGE,
    fallbackLanguage,
  ]).map((item) => item.toLowerCase());
  const preferredIndex = normalizedLanguage
    ? preferred.indexOf(normalizedLanguage)
    : -1;
  if (preferredIndex >= 0) return preferredIndex;
  return normalizedLanguage ? preferred.length + 1 : preferred.length;
}

function volumeSortKey(volume: string | null): number {
  if (!volume) return Number.MAX_SAFE_INTEGER;
  const numeric = Number.parseFloat(volume);
  return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER - 1;
}

function relationshipNames(manga: MangaResource, types: string[]): string[] {
  const out: string[] = [];
  for (const rel of manga.relationships ?? []) {
    if (!types.includes(rel.type)) continue;
    const name = rel.attributes?.name;
    if (typeof name === "string" && name.trim()) out.push(name.trim());
  }
  return [...new Set(out)];
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function chapterGroupName(chapter: ChapterResource): string | null {
  const group = chapter.relationships?.find((rel) => rel.type === "scanlation_group");
  const name = group?.attributes?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

interface ParsedDescription {
  description: string | null;
  artists: string[];
  group: string | null;
  tagNames: string[];
}

function splitTagValues(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /[\p{L}\p{N}]/u.test(item));
}

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

function markdownCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownSeparatorCell(cell: string): boolean {
  return /^:?-+:?$/.test(cell.trim());
}

function isTagTableHeader(cells: string[]): boolean {
  const normalized = cells
    .map((cell) => cell.toLowerCase())
    .filter(Boolean);
  if (normalized.length === 1) return normalized[0] === "tags";
  return normalized.includes("namespace") && normalized.includes("tags");
}

function parseDescriptionTags(text: string | null): ParsedDescription {
  if (!text) return { description: null, artists: [], group: null, tagNames: [] };

  const lines = text.split(/\r?\n/);
  const tagsIndex = lines.findIndex((line) => isTagTableHeader(markdownCells(line)));
  if (tagsIndex === -1) {
    return { description: text.trim() || null, artists: [], group: null, tagNames: [] };
  }

  const descriptionText = lines.slice(0, tagsIndex).join("\n").trim() || null;
  const artists: string[] = [];
  let group: string | null = null;
  const tagNames: string[] = [];

  for (const line of lines.slice(tagsIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = markdownCells(trimmed);
    if (cells.every(isMarkdownSeparatorCell)) continue;
    const key = cells[0]?.toLowerCase();
    const value = cells.slice(1).join(", ").trim();
    if (
      !key ||
      !/[\p{L}\p{N}]/u.test(key) ||
      key === "tags" ||
      key.includes(":--") ||
      !/[\p{L}\p{N}]/u.test(value)
    ) {
      continue;
    }

    if (key === "artist") {
      artists.push(...splitTagValues(value));
      continue;
    }

    if (key === "group") {
      group = splitTagValues(value)[0] ?? null;
      continue;
    }

    const label = titleCase(key);
    for (const tag of splitTagValues(value)) {
      tagNames.push(`${label}: ${tag}`);
    }
  }

  return {
    description: descriptionText,
    artists: uniqueStrings(artists),
    group,
    tagNames: uniqueStrings(tagNames),
  };
}

function mangaTagNames(manga: MangaResource): string[] {
  const attrs = manga.attributes ?? {};
  const tags = (attrs.tags ?? [])
    .map((tag) => localized(tag.attributes?.name).text)
    .filter((tag): tag is string => Boolean(tag));
  const audienceCategory = mangaAudienceCategory(attrs, tags);
  const labels = [
    audienceCategory,
    attrs.contentRating ? `content: ${attrs.contentRating}` : null,
    attrs.publicationDemographic ? `demographic: ${attrs.publicationDemographic}` : null,
    attrs.status ? `status: ${attrs.status}` : null,
    attrs.originalLanguage ? `original language: ${attrs.originalLanguage}` : null,
  ].filter((tag): tag is string => Boolean(tag));
  return [...new Set([...tags, ...labels])];
}

function mangaAudienceCategory(attrs: MangaAttributes, tags: string[]): string {
  const normalizedTags = tags.map((tag) => tag.toLowerCase());
  const demographic = attrs.publicationDemographic?.toLowerCase() ?? "";
  const male =
    demographic === "shounen" ||
    demographic === "seinen" ||
    normalizedTags.some((tag) => tag.includes("boys' love") || tag.includes("yaoi"));
  const female =
    demographic === "shoujo" ||
    demographic === "josei" ||
    normalizedTags.some((tag) => tag.includes("girls' love") || tag.includes("yuri"));

  if (male && female) return "Mixed";
  if (male) return "Male";
  if (female) return "Female";
  return "Other";
}

function description(manga: MangaResource, language: string): string | null {
  return localized(manga.attributes?.description, language).text;
}

function parsedDescription(manga: MangaResource, language: string): ParsedDescription {
  return parseDescriptionTags(description(manga, language));
}

function isAdult(manga: MangaResource): boolean {
  const rating = manga.attributes?.contentRating;
  return rating === "erotica" || rating === "pornographic";
}

function candidateFromManga(
  manga: MangaResource,
  title: { title: string; language: string },
): BookCandidate {
  return {
    externalIds: {
      mangadex: manga.id,
      language: title.language,
      mangadexTitle: title.title,
    },
    title: title.title,
    year: manga.attributes?.year ?? null,
    overview: parsedDescription(manga, title.language).description,
    posterUrl: coverUrl(manga),
    language: title.language,
    contentRating: manga.attributes?.contentRating ?? null,
    source: "mangadex",
  };
}

async function hydrateCandidatePosters(candidates: BookCandidate[]): Promise<BookCandidate[]> {
  return Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      posterUrl: candidate.posterUrl ? await imageDataUrl(candidate.posterUrl) : candidate.posterUrl,
    })),
  );
}

async function candidatesFromMangaList(manga: MangaResource[]): Promise<BookCandidate[]> {
  const candidates: BookCandidate[] = [];
  for (const item of manga) {
    const titles = allTitles(item);
    const ordered = [
      ...titles.filter((title) => title.language === DEFAULT_LANGUAGE),
      ...titles.filter((title) => title.language !== DEFAULT_LANGUAGE),
    ];
    for (const title of ordered) {
      candidates.push(candidateFromManga(item, title));
      if (candidates.length >= MAX_CANDIDATES) return hydrateCandidatePosters(candidates);
    }
  }
  return hydrateCandidatePosters(candidates);
}

function bookFromManga(args: {
  manga: MangaResource;
  language?: string;
  candidates?: BookCandidate[];
  chapter?: ChapterResource | null;
  imageUrl?: string | null;
  chapterImageUrl?: string | null;
  imageCandidates?: ImageCandidate[];
  chapterImageCandidates?: ImageCandidate[];
  chapterImageByNumber?: Record<string, ImageCandidate>;
  volumeCovers?: VolumeCover[];
  chapterVolumeByNumber?: Record<string, string>;
  chapterTitleByNumber?: Record<string, string>;
  selectedTitle?: string;
}): Record<string, unknown> {
  const language = args.language ?? DEFAULT_LANGUAGE;
  const picked =
    selectedTitle(args.manga, language, args.selectedTitle) ??
    preferredTitle(args.manga, language);
  const attrs = args.manga.attributes ?? {};
  const title = picked.text ?? "MangaDex title";
  const chapter = args.chapter;
  const chapterLabel = chapter?.attributes?.chapter
    ? `Chapter ${chapter.attributes.chapter}`
    : null;
  const chapterTitle = chapter?.attributes?.title?.trim() || null;
  const parsed = parsedDescription(args.manga, picked.language ?? language);
  const details =
    [
      chapterLabel || chapterTitle
        ? [chapterLabel, chapterTitle].filter(Boolean).join(" - ")
        : null,
      parsed.description,
    ]
      .filter(Boolean)
      .join("\n\n") || null;
  const chapterLanguage = chapter?.attributes?.translatedLanguage;
  const imageUrl = args.imageUrl ?? args.chapterImageUrl ?? coverUrl(args.manga);
  const studioName = chapter ? (chapterGroupName(chapter) ?? parsed.group) : parsed.group;
  const performerNames = uniqueStrings([
    ...relationshipNames(args.manga, ["author", "artist"]),
    ...parsed.artists,
  ]);
  const tagNames = uniqueStrings([...mangaTagNames(args.manga), ...parsed.tagNames]);

  return {
    kind: "book",
    book: {
      title: chapterLabel && chapterTitle ? `${title} - ${chapterLabel}: ${chapterTitle}` : title,
      date:
        chapter?.attributes?.publishAt?.slice(0, 10) ??
        chapter?.attributes?.readableAt?.slice(0, 10) ??
        (attrs.year ? String(attrs.year) : null),
      details,
      urls: [chapter ? chapterUrl(chapter.id) : mangaUrl(args.manga.id)],
      studioName,
      performerNames,
      tagNames,
      imageUrl,
      chapterImageUrl: args.chapterImageUrl ?? null,
      chapterNumber: chapter?.attributes?.chapter ?? null,
      imageCandidates: args.imageCandidates,
      chapterImageCandidates: args.chapterImageCandidates,
      chapterImageByNumber: args.chapterImageByNumber,
      volumeCovers: args.volumeCovers,
      chapterVolumeByNumber: args.chapterVolumeByNumber,
      chapterTitleByNumber: args.chapterTitleByNumber,
      isNsfw: isAdult(args.manga),
      externalIds: {
        mangadex: args.manga.id,
        ...(chapter ? { mangadexChapter: chapter.id } : {}),
        ...(chapter?.attributes?.chapter ? { chapterNumber: chapter.attributes.chapter } : {}),
        ...(chapter?.attributes?.volume ? { volume: chapter.attributes.volume } : {}),
        language: chapterLanguage ?? picked.language ?? language,
      },
      candidates: args.candidates,
    },
  };
}

function includeNsfw(input: Record<string, unknown>): boolean {
  return (
    input.includeNsfw === true ||
    input.nsfw === true ||
    input.nsfw === "show" ||
    input.nsfw === "blur" ||
    input.nsfwMode === "show" ||
    input.nsfwMode === "blur"
  );
}

function allowedContentRatings(input: Record<string, unknown>): string[] {
  return includeNsfw(input) ? ALL_CONTENT_RATINGS : SFW_CONTENT_RATINGS;
}

function isAllowedManga(manga: MangaResource, input: Record<string, unknown>): boolean {
  return includeNsfw(input) || !isAdult(manga);
}

function mangaIncludesParams(): Record<string, string[]> {
  return {
    "includes[]": ["cover_art", "author", "artist"],
  };
}

function searchMangaParams(input: Record<string, unknown>): Record<string, string[]> {
  return {
    ...mangaIncludesParams(),
    "contentRating[]": allowedContentRatings(input),
  };
}

async function fetchManga(
  id: string,
  auth: Record<string, string>,
  input: Record<string, unknown>,
): Promise<MangaResource | null> {
  const res = await mangadexFetch<ApiSingle<MangaResource>>(
    `/manga/${id}`,
    auth,
    mangaIncludesParams(),
  );
  const manga = res.data ?? null;
  return manga && isAllowedManga(manga, input) ? manga : null;
}

async function fetchChapter(
  id: string,
  auth: Record<string, string>,
): Promise<ChapterResource | null> {
  const res = await mangadexFetch<ApiSingle<ChapterResource>>(`/chapter/${id}`, auth, {
    "includes[]": ["manga", "scanlation_group"],
  });
  return res.data ?? null;
}

async function fetchCovers(
  mangaId: string,
  auth: Record<string, string>,
): Promise<CoverResource[]> {
  const covers: CoverResource[] = [];
  let offset = 0;

  while (true) {
    const res = await mangadexFetch<ApiList<CoverResource>>("/cover", auth, {
      "manga[]": [mangaId],
      limit: "100",
      offset: String(offset),
      "order[volume]": "asc",
    });
    covers.push(...(res.data ?? []));

    const total = res.total ?? covers.length;
    if (!res.data.length || covers.length >= total) break;
    offset += res.data.length;
  }

  return covers;
}

function mangaIdFromChapter(chapter: ChapterResource): string | null {
  return chapter.relationships?.find((rel) => rel.type === "manga")?.id ?? null;
}

function coverCandidates(
  manga: MangaResource,
  covers: CoverResource[],
  preferredUrl: string | null,
  language: string | null | undefined,
): ImageCandidate[] {
  const rows: Array<{
    candidate: ImageCandidate;
    index: number;
    preferred: boolean;
    priority: number;
    volumeKey: number;
  }> = [];

  for (const [index, cover] of covers.entries()) {
    const url = coverResourceUrl(manga.id, cover);
    if (!url) continue;
    const coverLanguage = cover.attributes?.locale ?? manga.attributes?.originalLanguage ?? null;
    const volume = coverVolume(cover);
    rows.push({
      index,
      preferred: url === preferredUrl,
      priority: languagePriority(coverLanguage, language, manga.attributes?.originalLanguage),
      volumeKey: volumeSortKey(volume),
      candidate: {
        url,
        language: coverLanguage,
        rank: 1,
        source: url === preferredUrl ? "MangaDex title cover" : volume ? `MangaDex volume ${volume}` : "MangaDex",
      },
    });
  }

  if (preferredUrl && !rows.some((row) => row.candidate.url === preferredUrl)) {
    rows.push({
      candidate: { url: preferredUrl, rank: 1, source: "MangaDex" },
      index: rows.length,
      preferred: true,
      priority: languagePriority(null, language, manga.attributes?.originalLanguage),
      volumeKey: Number.MAX_SAFE_INTEGER,
    });
  }

  rows.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    if (a.volumeKey !== b.volumeKey) return a.volumeKey - b.volumeKey;
    return a.index - b.index;
  });

  return rows.map((row, index) => ({
    ...row.candidate,
    rank: Math.max(1, 100 - row.priority * 20 - index),
  }));
}

function chapterNumberKey(chapterNumber: string | null | undefined): string | null {
  const trimmed = chapterNumber?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  return String(Number.parseInt(trimmed, 10));
}

async function imageDataUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer: `${MANGADEX_WEB}/`,
        "User-Agent": USER_AGENT,
      },
    });
    if (!res.ok) return url;
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim();
    if (!contentType?.startsWith("image/")) return url;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) return url;
    let binary = "";
    const chunkSize = 8192;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
    }
    return `data:${contentType};base64,${btoa(binary)}`;
  } catch {
    return url;
  }
}

async function fetchChapterImageCandidate(
  chapter: ChapterResource,
  auth: Record<string, string>,
): Promise<ImageCandidate | null> {
  const numberKey = chapterNumberKey(chapter.attributes?.chapter);
  if (!numberKey) return null;

  const res = await mangadexFetch<AtHomeServerResponse>(
    `/at-home/server/${chapter.id}`,
    auth,
  );
  const hash = res.chapter?.hash;
  const fileName = res.chapter?.dataSaver?.[0] ?? res.chapter?.data?.[0];
  if (!res.baseUrl || !hash || !fileName) return null;

  const quality = res.chapter?.dataSaver?.[0] ? "data-saver" : "data";
  const url = `${res.baseUrl}/${quality}/${hash}/${fileName}`;
  const hydratedUrl = await imageDataUrl(url);
  const chapterLabel = chapter.attributes?.chapter
    ? `MangaDex chapter ${chapter.attributes.chapter}`
    : "MangaDex chapter";

  return {
    url: hydratedUrl,
    language: chapter.attributes?.translatedLanguage ?? null,
    rank: 100,
    source: chapterLabel,
  };
}

async function fetchMangaChapters(
  mangaId: string,
  auth: Record<string, string>,
  input: Record<string, unknown>,
  language: string | null | undefined,
): Promise<ChapterResource[]> {
  const chapters: ChapterResource[] = [];
  let offset = 0;

  while (true) {
    const params: Record<string, string | string[]> = {
      limit: String(CHAPTER_FEED_PAGE_SIZE),
      offset: String(offset),
      "order[volume]": "asc",
      "order[chapter]": "asc",
      "contentRating[]": allowedContentRatings(input),
    };
    if (language) params["translatedLanguage[]"] = [language];

    const res = await mangadexFetch<ApiList<ChapterResource>>(
      `/manga/${mangaId}/feed`,
      auth,
      params,
    );
    chapters.push(...(res.data ?? []));

    const total = res.total ?? chapters.length;
    if (!res.data.length || chapters.length >= total) break;
    offset += res.data.length;
  }

  return chapters;
}

async function fetchMangaAggregate(
  mangaId: string,
  auth: Record<string, string>,
  language: string | null | undefined,
): Promise<AggregateResponse> {
  const params: Record<string, string | string[]> = {};
  if (language) params["translatedLanguage[]"] = [language];
  return mangadexFetch<AggregateResponse>(`/manga/${mangaId}/aggregate`, auth, params);
}

async function fillChapterVolumesFromAggregate(
  out: Record<string, string>,
  manga: MangaResource,
  auth: Record<string, string>,
  language: string | null | undefined,
) {
  const aggregate = await fetchMangaAggregate(manga.id, auth, language);
  for (const [volumeKey, volume] of Object.entries(aggregate.volumes ?? {})) {
    const volumeNumber = volume.volume?.trim() || volumeKey.trim();
    if (!volumeNumber) continue;
    for (const [chapterKey, chapter] of Object.entries(volume.chapters ?? {})) {
      const normalizedChapter = chapterNumberKey(chapter.chapter ?? chapterKey);
      if (!normalizedChapter || out[normalizedChapter]) continue;
      out[normalizedChapter] = volumeNumber;
    }
  }
}

async function prepareChapterImageMap(
  manga: MangaResource,
  auth: Record<string, string>,
  input: Record<string, unknown>,
  language: string | null | undefined,
): Promise<Record<string, ImageCandidate>> {
  let chapters: ChapterResource[] = [];
  const languages = uniqueStrings([
    language,
    language === DEFAULT_LANGUAGE ? null : DEFAULT_LANGUAGE,
    manga.attributes?.originalLanguage,
  ]);

  for (const candidateLanguage of languages) {
    chapters = await fetchMangaChapters(manga.id, auth, input, candidateLanguage);
    if (chapters.length > 0) break;
  }
  if (chapters.length === 0) {
    chapters = await fetchMangaChapters(manga.id, auth, input, null);
  }

  const seen = new Set<string>();
  const uniqueChapters: ChapterResource[] = [];
  for (const chapter of chapters) {
    const key = chapterNumberKey(chapter.attributes?.chapter);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueChapters.push(chapter);
  }

  const out: Record<string, ImageCandidate> = {};
  for (let index = 0; index < uniqueChapters.length; index += CHAPTER_COVER_FETCH_CONCURRENCY) {
    const batch = uniqueChapters.slice(index, index + CHAPTER_COVER_FETCH_CONCURRENCY);
    const candidates = await Promise.all(
      batch.map((chapter) => fetchChapterImageCandidate(chapter, auth).catch(() => null)),
    );
    for (let batchIndex = 0; batchIndex < batch.length; batchIndex++) {
      const key = chapterNumberKey(batch[batchIndex]?.attributes?.chapter);
      const candidate = candidates[batchIndex];
      if (key && candidate) out[key] = candidate;
    }
  }

  return out;
}

async function prepareChapterVolumeMap(
  manga: MangaResource,
  auth: Record<string, string>,
  input: Record<string, unknown>,
  language: string | null | undefined,
): Promise<Record<string, string>> {
  let chapters: ChapterResource[] = [];
  const languages = uniqueStrings([
    language,
    language === DEFAULT_LANGUAGE ? null : DEFAULT_LANGUAGE,
    manga.attributes?.originalLanguage,
  ]);

  for (const candidateLanguage of languages) {
    chapters = await fetchMangaChapters(manga.id, auth, input, candidateLanguage);
    if (chapters.length > 0) break;
  }
  if (chapters.length === 0) {
    chapters = await fetchMangaChapters(manga.id, auth, input, null);
  }

  const out: Record<string, string> = {};
  for (const chapter of chapters) {
    const chapterKey = chapterNumberKey(chapter.attributes?.chapter);
    const volume = chapter.attributes?.volume?.trim();
    if (!chapterKey || !volume || out[chapterKey]) continue;
    out[chapterKey] = volume;
  }

  const aggregateLanguages: Array<string | null> = [
    null,
    ...uniqueStrings([
      language,
      language === DEFAULT_LANGUAGE ? null : DEFAULT_LANGUAGE,
      manga.attributes?.originalLanguage,
    ]),
  ];
  for (const candidateLanguage of aggregateLanguages) {
    try {
      await fillChapterVolumesFromAggregate(out, manga, auth, candidateLanguage);
    } catch {
      // The chapter feed above is still useful if aggregate is unavailable.
    }
  }
  return out;
}

async function prepareChapterTitleMap(
  manga: MangaResource,
  auth: Record<string, string>,
  input: Record<string, unknown>,
  language: string | null | undefined,
): Promise<Record<string, string>> {
  let chapters: ChapterResource[] = [];
  const languages = uniqueStrings([
    language,
    language === DEFAULT_LANGUAGE ? null : DEFAULT_LANGUAGE,
    manga.attributes?.originalLanguage,
  ]);

  for (const candidateLanguage of languages) {
    chapters = await fetchMangaChapters(manga.id, auth, input, candidateLanguage);
    if (chapters.length > 0) break;
  }
  if (chapters.length === 0) {
    chapters = await fetchMangaChapters(manga.id, auth, input, null);
  }

  const out: Record<string, string> = {};
  for (const chapter of chapters) {
    const chapterKey = chapterNumberKey(chapter.attributes?.chapter);
    const title = chapter.attributes?.title?.trim();
    if (!chapterKey || !title || out[chapterKey]) continue;
    out[chapterKey] = title;
  }
  return out;
}

function chapterImageCandidatesFromMap(
  chapterImageByNumber: Record<string, ImageCandidate> | undefined,
): ImageCandidate[] {
  return Object.entries(chapterImageByNumber ?? {})
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([chapterNumber, candidate]) => ({
      ...candidate,
      source: candidate.source || `MangaDex chapter ${chapterNumber}`,
    }));
}

async function hydrateImageCandidates(candidates: ImageCandidate[]): Promise<ImageCandidate[]> {
  return Promise.all(
    candidates.slice(0, MAX_IMAGE_CANDIDATES).map(async (candidate) => ({
      ...candidate,
      url: await imageDataUrl(candidate.url),
    })),
  );
}

async function prepareCoverSet(
  manga: MangaResource,
  covers: CoverResource[],
  preferredUrl: string | null,
  language: string | null | undefined,
): Promise<{ imageUrl: string | null; candidates: ImageCandidate[] }> {
  const candidates = await hydrateImageCandidates(
    coverCandidates(manga, covers, preferredUrl, language),
  );
  const preferred = candidates[0];
  return {
    imageUrl: preferred?.url ?? preferredUrl,
    candidates,
  };
}

async function prepareVolumeCovers(
  manga: MangaResource,
  covers: CoverResource[],
  language: string | null | undefined,
): Promise<VolumeCover[]> {
  const rows: Array<{
    cover: CoverResource;
    volume: string;
    priority: number;
    index: number;
  }> = [];
  for (const [index, cover] of covers.entries()) {
    const volume = coverVolume(cover);
    const url = coverResourceUrl(manga.id, cover);
    if (!volume || !url) continue;
    rows.push({
      cover,
      volume,
      priority: languagePriority(
        cover.attributes?.locale ?? null,
        language,
        manga.attributes?.originalLanguage,
      ),
      index,
    });
  }
  rows.sort((a, b) => {
    const volumeDiff = volumeSortKey(a.volume) - volumeSortKey(b.volume);
    if (volumeDiff !== 0) return volumeDiff;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.index - b.index;
  });

  const out: VolumeCover[] = [];
  for (const row of rows) {
    const url = coverResourceUrl(manga.id, row.cover);
    if (!url) continue;
    out.push({
      url: await imageDataUrl(url),
      volumeNumber: row.volume,
      title: `Volume ${row.volume}`,
      language: row.cover.attributes?.locale ?? manga.attributes?.originalLanguage ?? null,
      rank: Math.max(1, 100 - row.priority * 20 - out.length),
      source: `MangaDex volume ${row.volume}`,
      externalIds: {
        mangadex: manga.id,
        mangadexCover: row.cover.id,
        volume: row.volume,
      },
    });
  }
  return out;
}

async function bookByURL(
  input: Record<string, unknown>,
  auth: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const url = typeof input.url === "string" ? input.url : "";
  const parsed = parseMangaDexUrl(url);
  if (!parsed) return null;

  if (parsed.kind === "manga") {
    const manga = await fetchManga(parsed.id, auth, input);
    const covers = manga ? await fetchCovers(manga.id, auth) : [];
    const imageUrl = manga ? coverUrl(manga) : null;
    const coverSet = manga
      ? await prepareCoverSet(manga, covers, imageUrl, DEFAULT_LANGUAGE)
      : null;
    const chapterImageByNumber = manga
      ? await prepareChapterImageMap(manga, auth, input, DEFAULT_LANGUAGE)
      : undefined;
    const chapterVolumeByNumber = manga
      ? await prepareChapterVolumeMap(manga, auth, input, DEFAULT_LANGUAGE)
      : undefined;
    const chapterTitleByNumber = manga
      ? await prepareChapterTitleMap(manga, auth, input, DEFAULT_LANGUAGE)
      : undefined;
    const chapterImageCandidates = chapterImageCandidatesFromMap(chapterImageByNumber);
    const volumeCovers = manga ? await prepareVolumeCovers(manga, covers, DEFAULT_LANGUAGE) : undefined;
    return manga
      ? bookFromManga({
          manga,
          imageUrl: coverSet?.imageUrl,
          imageCandidates: coverSet?.candidates,
          chapterImageCandidates,
          chapterImageByNumber,
          volumeCovers,
          chapterVolumeByNumber,
          chapterTitleByNumber,
        })
      : null;
  }

  const chapter = await fetchChapter(parsed.id, auth);
  if (!chapter) return null;
  const mangaId = mangaIdFromChapter(chapter);
  if (!mangaId) return null;
  const manga = await fetchManga(mangaId, auth, input);
  const covers = manga ? await fetchCovers(manga.id, auth) : [];
  const chapterLanguage = chapter.attributes?.translatedLanguage ?? DEFAULT_LANGUAGE;
  const mangaCoverSet = manga
    ? await prepareCoverSet(manga, covers, coverUrl(manga), chapterLanguage)
    : null;
  const chapterImageByNumber = manga
    ? await prepareChapterImageMap(manga, auth, input, chapterLanguage)
    : undefined;
  const chapterVolumeByNumber = manga
    ? await prepareChapterVolumeMap(manga, auth, input, chapterLanguage)
    : undefined;
  const chapterTitleByNumber = manga
    ? await prepareChapterTitleMap(manga, auth, input, chapterLanguage)
    : undefined;
  const chapterImageCandidates = chapterImageCandidatesFromMap(chapterImageByNumber);
  const chapterImageUrl =
    chapterNumberKey(chapter.attributes?.chapter) && chapterImageByNumber
      ? chapterImageByNumber[chapterNumberKey(chapter.attributes?.chapter)!]?.url
      : null;
  const volumeCovers = manga ? await prepareVolumeCovers(manga, covers, chapterLanguage) : undefined;
  return manga
    ? bookFromManga({
        manga,
        language: chapterLanguage,
        chapter,
        imageUrl: mangaCoverSet?.imageUrl,
        chapterImageUrl,
        imageCandidates: mangaCoverSet?.candidates,
        chapterImageCandidates,
        chapterImageByNumber,
        volumeCovers,
        chapterVolumeByNumber,
        chapterTitleByNumber,
      })
    : null;
}

function externalIds(input: Record<string, unknown>): Record<string, string> | null {
  const raw = input.externalIds;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function searchQueries(query: string): string[] {
  const cleaned = query
    .replace(/\.[a-z0-9]{2,5}$/i, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\([^)]*(?:digital|english|eng|scan|rip|cbz|cbr)[^)]*\)/gi, " ")
    .replace(/\b(?:chapter|ch|volume|vol)\.?\s*\d+(?:\.\d+)?\b/gi, " ")
    .replace(/\b\d{1,4}\b$/g, " ")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(new Set([query, cleaned].map((item) => item.trim()).filter(Boolean)));
}

function sortMangaByQuery(manga: MangaResource[], query: string): MangaResource[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return manga;
  return [...manga].sort((a, b) => {
    const score = (item: MangaResource) => {
      const titles = allTitles(item).map((title) => normalizeSearchText(title.title));
      if (titles.some((title) => title === normalizedQuery)) return 0;
      if (titles.some((title) => title.startsWith(normalizedQuery))) return 1;
      if (titles.some((title) => title.includes(normalizedQuery))) return 2;
      return 3;
    };
    return score(a) - score(b);
  });
}

async function bookByFragment(
  input: Record<string, unknown>,
  auth: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const ids = externalIds(input);
  if (ids?.mangadexChapter) {
    const chapter = await fetchChapter(ids.mangadexChapter, auth);
    const mangaId = chapter ? mangaIdFromChapter(chapter) : null;
    const manga = mangaId ? await fetchManga(mangaId, auth, input) : null;
    const covers = manga ? await fetchCovers(manga.id, auth) : [];
    const chapterLanguage =
      chapter?.attributes?.translatedLanguage ?? ids.language ?? DEFAULT_LANGUAGE;
    const mangaCoverSet = manga
      ? await prepareCoverSet(manga, covers, coverUrl(manga), chapterLanguage)
      : null;
    const chapterImageByNumber = manga
      ? await prepareChapterImageMap(manga, auth, input, chapterLanguage)
      : undefined;
    const chapterVolumeByNumber = manga
      ? await prepareChapterVolumeMap(manga, auth, input, chapterLanguage)
      : undefined;
    const chapterTitleByNumber = manga
      ? await prepareChapterTitleMap(manga, auth, input, chapterLanguage)
      : undefined;
    const chapterImageCandidates = chapterImageCandidatesFromMap(chapterImageByNumber);
    const chapterImageUrl =
      chapter && chapterNumberKey(chapter.attributes?.chapter) && chapterImageByNumber
        ? chapterImageByNumber[chapterNumberKey(chapter.attributes?.chapter)!]?.url
        : null;
    const volumeCovers = manga ? await prepareVolumeCovers(manga, covers, chapterLanguage) : undefined;
    return manga && chapter
      ? bookFromManga({
          manga,
          language: ids.language,
          selectedTitle: ids.mangadexTitle,
          chapter,
          imageUrl: mangaCoverSet?.imageUrl,
          chapterImageUrl,
          imageCandidates: mangaCoverSet?.candidates,
          chapterImageCandidates,
          chapterImageByNumber,
          volumeCovers,
          chapterVolumeByNumber,
          chapterTitleByNumber,
        })
      : null;
  }
  if (ids?.mangadex) {
    const manga = await fetchManga(ids.mangadex, auth, input);
    const covers = manga ? await fetchCovers(manga.id, auth) : [];
    const imageUrl = manga ? coverUrl(manga) : null;
    const coverSet = manga
      ? await prepareCoverSet(manga, covers, imageUrl, ids.language ?? DEFAULT_LANGUAGE)
      : null;
    const chapterImageByNumber = manga
      ? await prepareChapterImageMap(manga, auth, input, ids.language ?? DEFAULT_LANGUAGE)
      : undefined;
    const chapterVolumeByNumber = manga
      ? await prepareChapterVolumeMap(manga, auth, input, ids.language ?? DEFAULT_LANGUAGE)
      : undefined;
    const chapterTitleByNumber = manga
      ? await prepareChapterTitleMap(manga, auth, input, ids.language ?? DEFAULT_LANGUAGE)
      : undefined;
    const chapterImageCandidates = chapterImageCandidatesFromMap(chapterImageByNumber);
    const volumeCovers = manga ? await prepareVolumeCovers(manga, covers, ids.language ?? DEFAULT_LANGUAGE) : undefined;
    return manga
      ? bookFromManga({
          manga,
          language: ids.language,
          selectedTitle: ids.mangadexTitle,
          imageUrl: coverSet?.imageUrl,
          imageCandidates: coverSet?.candidates,
          chapterImageCandidates,
          chapterImageByNumber,
          volumeCovers,
          chapterVolumeByNumber,
          chapterTitleByNumber,
        })
      : null;
  }

  const query = ((input.name as string) ?? (input.title as string) ?? "").trim();
  if (!query) return null;

  let searchQuery = query;
  let data: MangaResource[] = [];
  for (const candidateQuery of searchQueries(query)) {
    const res = await mangadexFetch<ApiList<MangaResource>>("/manga", auth, {
      limit: "10",
      title: candidateQuery,
      "order[relevance]": "desc",
      ...searchMangaParams(input),
    });
    if (res.data.length) {
      searchQuery = candidateQuery;
      data = res.data;
      break;
    }
  }
  if (!data.length) return null;

  const sorted = sortMangaByQuery(data, searchQuery);
  const candidates = await candidatesFromMangaList(sorted);
  const first = candidates[0];
  const best = first
    ? (sorted.find((manga) => manga.id === first.externalIds.mangadex) ?? sorted[0])
    : sorted[0];
  const covers = await fetchCovers(best.id, auth);
  const imageUrl = coverUrl(best);
  const coverSet = await prepareCoverSet(
    best,
    covers,
    imageUrl,
    first?.externalIds.language ?? DEFAULT_LANGUAGE,
  );
  const chapterImageByNumber = await prepareChapterImageMap(
    best,
    auth,
    input,
    first?.externalIds.language ?? DEFAULT_LANGUAGE,
  );
  const chapterVolumeByNumber = await prepareChapterVolumeMap(
    best,
    auth,
    input,
    first?.externalIds.language ?? DEFAULT_LANGUAGE,
  );
  const chapterTitleByNumber = await prepareChapterTitleMap(
    best,
    auth,
    input,
    first?.externalIds.language ?? DEFAULT_LANGUAGE,
  );
  const chapterImageCandidates = chapterImageCandidatesFromMap(chapterImageByNumber);
  const volumeCovers = await prepareVolumeCovers(best, covers, first?.externalIds.language ?? DEFAULT_LANGUAGE);
  return bookFromManga({
    manga: best,
    language: first?.externalIds.language ?? DEFAULT_LANGUAGE,
    selectedTitle: first?.externalIds.mangadexTitle,
    candidates,
    imageUrl: coverSet.imageUrl,
    imageCandidates: coverSet.candidates,
    chapterImageCandidates,
    chapterImageByNumber,
    volumeCovers,
    chapterVolumeByNumber,
    chapterTitleByNumber,
  });
}

export default {
  capabilities: {
    bookByURL: true,
    bookByName: true,
    bookByFragment: true,
    comicByURL: true,
    comicByName: true,
    comicByFragment: true,
    mangaByURL: true,
    mangaByName: true,
    mangaByFragment: true,
    supportsBatch: false,
  },

  async execute(
    action: string,
    input: Record<string, unknown>,
    auth: Record<string, string>,
  ): Promise<Record<string, unknown> | null> {
    switch (action) {
      case "bookByURL":
      case "comicByURL":
      case "mangaByURL":
        return bookByURL(input, auth);
      case "bookByName":
      case "bookByFragment":
      case "comicByName":
      case "comicByFragment":
      case "mangaByName":
      case "mangaByFragment":
        return bookByFragment(input, auth);
      default:
        return null;
    }
  },
};
