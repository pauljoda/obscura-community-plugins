#!/usr/bin/env node
/**
 * Build a distributable `.zip` for every plugin in `plugins/` and
 * write a sha256 checksum back into `index.yml` so Obscura clients
 * can verify downloads.
 *
 * Usage: node scripts/build-plugins.mjs
 *
 * For TypeScript plugins this also runs `tsc` against each plugin's
 * `tsconfig.json` so the emitted `dist/*.js` the manifest points at
 * is in sync with the source file.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..");
const pluginsDir = join(repoRoot, "plugins");
const indexPath = join(repoRoot, "index.yml");

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function walk(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (name.endsWith(".zip")) continue;
    if (name === "tsconfig.json") continue;
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full, rel));
    } else if (st.isFile()) {
      out.push({ rel, full });
    }
  }
  return out;
}

function loadManifest(pluginDir) {
  const path = join(pluginDir, "manifest.yml");
  if (!existsSync(path)) return null;
  return yaml.load(readFileSync(path, "utf8"));
}

function buildTypeScript(pluginDir) {
  const tsconfig = join(pluginDir, "tsconfig.json");
  if (!existsSync(tsconfig)) return;
  const distDir = join(pluginDir, "dist");
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  const res = spawnSync(
    "npx",
    ["-y", "-p", "typescript@5", "tsc", "-p", "tsconfig.json"],
    { cwd: pluginDir, stdio: "inherit" },
  );
  if (res.status !== 0) {
    throw new Error(`tsc failed for ${pluginDir}`);
  }
}

function zipPlugin(pluginDir) {
  const files = walk(pluginDir);
  const bundle = {};
  for (const { rel, full } of files) {
    bundle[rel] = new Uint8Array(readFileSync(full));
  }
  return Buffer.from(zipSync(bundle, { level: 9 }));
}

const index = yaml.load(readFileSync(indexPath, "utf8"));
if (!Array.isArray(index)) {
  throw new Error("index.yml must be a YAML list");
}

for (const entry of index) {
  const id = String(entry.id);
  const pluginDir = join(pluginsDir, id);
  if (!existsSync(pluginDir)) {
    console.warn(`skip ${id}: ${pluginDir} missing`);
    continue;
  }
  const manifest = loadManifest(pluginDir);
  if (!manifest) {
    console.warn(`skip ${id}: no manifest.yml`);
    continue;
  }

  if (manifest.runtime === "typescript") {
    buildTypeScript(pluginDir);
  }

  const zipBuf = zipPlugin(pluginDir);
  const zipPath = join(pluginDir, `${id}.zip`);
  writeFileSync(zipPath, zipBuf);
  const digest = sha256(zipBuf);

  entry.sha256 = digest;
  entry.version = String(manifest.version ?? entry.version);

  console.log(
    `built ${id} v${entry.version} (${zipBuf.length} bytes, sha256=${digest.slice(0, 12)}…)`,
  );
}

const dumped = yaml.dump(index, { lineWidth: 200 });
writeFileSync(indexPath, `# Obscura Community Plugins Index\n# This file is fetched by Obscura to discover available plugins.\n\n${dumped}`);

console.log("\nindex.yml updated with fresh sha256 + versions.");
console.log("Commit the updated index + plugins/*/<id>.zip to publish.");
