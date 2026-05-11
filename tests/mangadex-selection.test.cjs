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
const selectedTitle = "Selected Alt Title";

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

function mangaResource() {
  return {
    id: mangaId,
    type: "manga",
    attributes: {
      title: { en: "Canonical Title" },
      altTitles: [{ en: selectedTitle }],
      description: { en: "Overview" },
      contentRating: "safe",
    },
    relationships: [],
  };
}

function installMockFetch() {
  global.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "auth.mangadex.org") {
      return jsonResponse({ access_token: "token", expires_in: 900 });
    }
    if (parsed.pathname === "/manga") {
      return jsonResponse({ result: "ok", data: [mangaResource()] });
    }
    if (parsed.pathname === `/manga/${mangaId}`) {
      return jsonResponse({ result: "ok", data: mangaResource() });
    }
    if (parsed.pathname === "/cover") {
      return jsonResponse({ result: "ok", data: [] });
    }
    if (parsed.pathname === `/manga/${mangaId}/feed`) {
      return jsonResponse({ result: "ok", data: [] });
    }
    if (parsed.pathname === `/manga/${mangaId}/aggregate`) {
      return jsonResponse({ result: "ok", volumes: {} });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
}

test("MangaDex search candidates carry the exact selectable title", async () => {
  installMockFetch();

  const result = await plugin.execute("mangaByName", { name: "Canonical" }, AUTH);
  const candidate = result.book.candidates.find((item) => item.title === selectedTitle);

  assert.equal(candidate.externalIds.mangadex, mangaId);
  assert.equal(candidate.externalIds.mangadexTitle, selectedTitle);
});

test("MangaDex selected candidate title is used when rehydrating by external ids", async () => {
  installMockFetch();

  const result = await plugin.execute(
    "mangaByFragment",
    { externalIds: { mangadex: mangaId, language: "en", mangadexTitle: selectedTitle } },
    AUTH,
  );

  assert.equal(result.book.title, selectedTitle);
});
