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
const USER_AGENT = "Obscura-MangaDex-Plugin/0.1.0";
const SFW_CONTENT_RATINGS = ["safe", "suggestive"];
const ALL_CONTENT_RATINGS = ["safe", "suggestive", "erotica", "pornographic"];
const DEFAULT_LANGUAGE = "en";
const MAX_CANDIDATES = 20;

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

function coverUrlFromFileName(mangaId: string, fileName: unknown): string | null {
  if (typeof fileName !== "string" || !fileName) return null;
  return `${MANGADEX_UPLOADS}/covers/${mangaId}/${fileName}`;
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

function parseDescriptionTags(text: string | null): ParsedDescription {
  if (!text) return { description: null, artists: [], group: null, tagNames: [] };

  const lines = text.split(/\r?\n/);
  const tagsIndex = lines.findIndex(
    (line) => line.replace(/[|\s]/g, "").toLowerCase() === "tags",
  );
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
    const parts = trimmed.split("|").map((part) => part.trim());
    const key = parts[1]?.toLowerCase();
    const value = parts.slice(2).join("|").trim();
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
    externalIds: { mangadex: manga.id, language: title.language },
    title: title.title,
    year: manga.attributes?.year ?? null,
    overview: parsedDescription(manga, title.language).description,
    posterUrl: coverUrl(manga),
    language: title.language,
    contentRating: manga.attributes?.contentRating ?? null,
    source: "mangadex",
  };
}

function candidatesFromMangaList(manga: MangaResource[]): BookCandidate[] {
  const candidates: BookCandidate[] = [];
  for (const item of manga) {
    const titles = allTitles(item);
    const ordered = [
      ...titles.filter((title) => title.language === DEFAULT_LANGUAGE),
      ...titles.filter((title) => title.language !== DEFAULT_LANGUAGE),
    ];
    for (const title of ordered) {
      candidates.push(candidateFromManga(item, title));
      if (candidates.length >= MAX_CANDIDATES) return candidates;
    }
  }
  return candidates;
}

function bookFromManga(args: {
  manga: MangaResource;
  language?: string;
  candidates?: BookCandidate[];
  chapter?: ChapterResource | null;
  chapterImageUrl?: string | null;
  imageCandidates?: ImageCandidate[];
  chapterImageCandidates?: ImageCandidate[];
}): Record<string, unknown> {
  const language = args.language ?? DEFAULT_LANGUAGE;
  const picked = preferredTitle(args.manga, language);
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
  const imageUrl = args.chapterImageUrl ?? coverUrl(args.manga);
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
  return input.includeNsfw === true || input.nsfwMode === "show" || input.nsfwMode === "blur";
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
  const res = await mangadexFetch<ApiList<CoverResource>>("/cover", auth, {
    "manga[]": [mangaId],
    limit: "100",
    "order[volume]": "asc",
  });
  return res.data ?? [];
}

function mangaIdFromChapter(chapter: ChapterResource): string | null {
  return chapter.relationships?.find((rel) => rel.type === "manga")?.id ?? null;
}

function coverCandidates(
  manga: MangaResource,
  covers: CoverResource[],
  preferredUrl: string | null,
): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  for (const [index, cover] of covers.entries()) {
    const url = coverResourceUrl(manga.id, cover);
    if (!url) continue;
    const rank = url === preferredUrl ? 100 : Math.max(1, 90 - index);
    candidates.push({
      url,
      language: cover.attributes?.locale ?? manga.attributes?.originalLanguage ?? null,
      rank,
      source: coverVolume(cover) ? `MangaDex volume ${coverVolume(cover)}` : "MangaDex",
    });
  }

  if (preferredUrl && !candidates.some((candidate) => candidate.url === preferredUrl)) {
    candidates.unshift({ url: preferredUrl, rank: 100, source: "MangaDex" });
  }

  return candidates;
}

function chapterCoverUrl(
  manga: MangaResource,
  chapter: ChapterResource,
  covers: CoverResource[],
): string | null {
  const chapterVolume = chapter.attributes?.volume?.trim();
  if (chapterVolume) {
    const volumeCover = covers.find((cover) => coverVolume(cover) === chapterVolume);
    if (volumeCover) return coverResourceUrl(manga.id, volumeCover);
  }

  const noVolumeCover = covers.find((cover) => coverVolume(cover) === null);
  if (noVolumeCover) return coverResourceUrl(manga.id, noVolumeCover);

  const first = covers[0];
  return first ? coverResourceUrl(manga.id, first) : coverUrl(manga);
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
    return manga
      ? bookFromManga({ manga, imageCandidates: coverCandidates(manga, covers, imageUrl) })
      : null;
  }

  const chapter = await fetchChapter(parsed.id, auth);
  if (!chapter) return null;
  const mangaId = mangaIdFromChapter(chapter);
  if (!mangaId) return null;
  const manga = await fetchManga(mangaId, auth, input);
  const covers = manga ? await fetchCovers(manga.id, auth) : [];
  const selectedCover = manga ? chapterCoverUrl(manga, chapter, covers) : null;
  return manga
    ? bookFromManga({
        manga,
        language: chapter.attributes?.translatedLanguage ?? DEFAULT_LANGUAGE,
        chapter,
        chapterImageUrl: selectedCover,
        imageCandidates: coverCandidates(manga, covers, coverUrl(manga)),
        chapterImageCandidates: coverCandidates(manga, covers, selectedCover),
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
    const selectedCover = manga && chapter ? chapterCoverUrl(manga, chapter, covers) : null;
    return manga && chapter
      ? bookFromManga({
          manga,
          language: ids.language,
          chapter,
          chapterImageUrl: selectedCover,
          imageCandidates: coverCandidates(manga, covers, coverUrl(manga)),
          chapterImageCandidates: coverCandidates(manga, covers, selectedCover),
        })
      : null;
  }
  if (ids?.mangadex) {
    const manga = await fetchManga(ids.mangadex, auth, input);
    const covers = manga ? await fetchCovers(manga.id, auth) : [];
    const imageUrl = manga ? coverUrl(manga) : null;
    return manga
      ? bookFromManga({
          manga,
          language: ids.language,
          imageCandidates: coverCandidates(manga, covers, imageUrl),
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
  const candidates = candidatesFromMangaList(sorted);
  const first = candidates[0];
  const best = first
    ? (sorted.find((manga) => manga.id === first.externalIds.mangadex) ?? sorted[0])
    : sorted[0];
  const covers = await fetchCovers(best.id, auth);
  const imageUrl = coverUrl(best);
  return bookFromManga({
    manga: best,
    language: first?.externalIds.language ?? DEFAULT_LANGUAGE,
    candidates,
    imageCandidates: coverCandidates(best, covers, imageUrl),
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
