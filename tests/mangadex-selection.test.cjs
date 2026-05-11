const assert = require("node:assert/strict");
const test = require("node:test");

const plugin = require("../plugins/mangadex/dist/mangadex.js").default;

const AUTH = {
  MANGADEX_CLIENT_ID: "client",
  MANGADEX_CLIENT_SECRET: "secret",
  MANGADEX_USERNAME: "user",
  MANGADEX_PASSWORD: "pass",
};

const mangaId = "11111111-1111-1111-1111-111111111111";
const otherMangaId = "22222222-2222-2222-2222-222222222222";
const duplicateLanguageAltTitle = "Duplicate Language Alt Title";

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function mangaResource(id = mangaId) {
  const title = id === otherMangaId ? "Other MangaDex Entry" : "Canonical Title";
  return {
    id,
    type: "manga",
    attributes: {
      title: { en: title },
      altTitles: id === mangaId ? [{ en: duplicateLanguageAltTitle }, { ja: "Japanese Title" }] : [],
      description: { en: `${title} overview` },
      contentRating: "safe",
    },
    relationships: [],
  };
}

function candidateId(candidate) {
  const ids = candidate.externalIds;
  return [ids.mangadex, ids.mangadexChapter, ids.language].filter(Boolean).join(":");
}

function installMockFetch() {
  global.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "auth.mangadex.org") {
      return jsonResponse({ access_token: "token", expires_in: 900 });
    }
    if (parsed.pathname === "/manga") {
      return jsonResponse({ result: "ok", data: [mangaResource(), mangaResource(otherMangaId)] });
    }
    if (parsed.pathname === `/manga/${mangaId}`) {
      return jsonResponse({ result: "ok", data: mangaResource() });
    }
    if (parsed.pathname === `/manga/${otherMangaId}`) {
      return jsonResponse({ result: "ok", data: mangaResource(otherMangaId) });
    }
    if (parsed.pathname === "/cover") {
      return jsonResponse({ result: "ok", data: [] });
    }
    if (parsed.pathname === `/manga/${mangaId}/feed`) {
      return jsonResponse({ result: "ok", data: [] });
    }
    if (parsed.pathname === `/manga/${otherMangaId}/feed`) {
      return jsonResponse({ result: "ok", data: [] });
    }
    if (parsed.pathname === `/manga/${mangaId}/aggregate`) {
      return jsonResponse({ result: "ok", volumes: {} });
    }
    if (parsed.pathname === `/manga/${otherMangaId}/aggregate`) {
      return jsonResponse({ result: "ok", volumes: {} });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
}

test("MangaDex search candidates have unique host option ids", async () => {
  installMockFetch();

  const result = await plugin.execute("mangaByName", { name: "Canonical" }, AUTH);
  const ids = result.book.candidates.map(candidateId);

  assert.deepEqual(ids, Array.from(new Set(ids)));
});

test("MangaDex selected different entry updates title when rehydrating by external ids", async () => {
  installMockFetch();

  const result = await plugin.execute(
    "mangaByFragment",
    { externalIds: { mangadex: otherMangaId, language: "en" } },
    AUTH,
  );

  assert.equal(result.book.title, "Other MangaDex Entry");
});
