#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSpriteAssetBytes } from "./plugin-sprite-validation.mjs";
import {
  computeReviewedTreeSha256,
  parseStrictZip,
  validateCommunityMetadata,
  validateDesktopCompatiblePluginCatalogV2,
  validateDesktopCompatibleReleaseManifest,
} from "./sync-plugins.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const catalogPath = join(repoRoot, "web", "public", "plugins", "catalog.v2.json");
const zipDir = join(repoRoot, "web", ".data", "plugin-zips");
const officialDir = join(repoRoot, "plugins", "official");
const communityDir = join(repoRoot, "plugins", "community");
const provenancePath = join(repoRoot, "web", "public", "plugins", "provenance.json");
const submissionsPath = join(repoRoot, "web", "public", "plugins", "submissions.json");

const useLive = process.argv.includes("--live");
const requireLocalZips = process.argv.includes("--require-local-zips") || !useLive;
const errors = [];

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function fail(message) {
  errors.push(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasTranslationRef(value) {
  return typeof value === "string" && value.includes("$t:");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fetchBytes(url) {
  const requestUrl = new URL(url);
  if (useLive) requestUrl.searchParams.set("openpetsValidate", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const response = await fetch(requestUrl, { redirect: "error", cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function loadCatalog() {
  if (useLive) {
    const bytes = await fetchBytes("https://openpets.dev/plugins/catalog.v2.json");
    return JSON.parse(bytes.toString("utf8"));
  }
  return readJson(catalogPath);
}

async function pluginEntriesForDir(sourceDir, publisherType) {
  try {
    const directories = (await readdir(sourceDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
    const entries = await Promise.all(directories.map(async (directory) => {
      const manifest = await readJson(join(sourceDir, directory.name, "openpets.plugin.json"));
      return { id: manifest.id, publisherType };
    }));
    return entries.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function expectedPluginEntries() {
  const expected = [
    ...(await pluginEntriesForDir(officialDir, "official")),
    ...(await pluginEntriesForDir(communityDir, "community")),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Map();
  for (const entry of expected) {
    const prior = seen.get(entry.id);
    if (prior) fail(`source: duplicate plugin id ${entry.id} in ${prior.publisherType} and ${entry.publisherType}`);
    seen.set(entry.id, entry);
  }
  return expected;
}

async function loadZip(entry) {
  if (useLive) return fetchBytes(entry.downloadUrl);
  const path = join(zipDir, `${entry.id}.zip`);
  if (!existsSync(path)) {
    if (requireLocalZips) fail(`${entry.id}: missing local package zip at ${path}; run pnpm plugins:package first.`);
    return undefined;
  }
  return readFile(path);
}

function flattenLocale(value, prefix = "") {
  const out = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (isRecord(entry)) Object.assign(out, flattenLocale(entry, fullKey));
    else if (typeof entry === "string") out[fullKey] = entry;
  }
  return out;
}

function resolvePluginText(catalog, value) {
  if (typeof value !== "string" || !value.startsWith("$t:")) return value;
  return catalog[value.slice(3)];
}

function assertNoTranslationRefs(path, value) {
  if (hasTranslationRef(value)) fail(`${path}: unresolved translation ref ${value}`);
}

function validateCatalog(catalog, expectedEntries) {
  if (!isRecord(catalog)) { fail("Plugin catalog must be an object."); return []; }
  try { validateDesktopCompatiblePluginCatalogV2(catalog); }
  catch (error) { fail(`catalog: desktop schema validation failed: ${error.message}`); }
  if (!Array.isArray(catalog.plugins)) { fail("Plugin catalog must contain a plugins array."); return []; }
  const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];
  const ids = plugins.map((plugin) => plugin?.id).sort((a, b) => String(a).localeCompare(String(b)));
  const expectedById = new Map(expectedEntries.map((entry) => [entry.id, entry]));
  for (const entry of expectedEntries) if (!ids.includes(entry.id)) fail(`catalog: missing ${entry.publisherType} plugin ${entry.id}`);
  const seen = new Set();
  for (const plugin of plugins) {
    if (!isRecord(plugin)) { fail("catalog: plugin entry must be an object"); continue; }
    if (seen.has(plugin.id)) fail(`catalog: duplicate plugin id ${plugin.id}`);
    seen.add(plugin.id);
    const expected = expectedById.get(plugin.id);
    if (!expected) fail(`catalog: unexpected plugin ${plugin.id}`);
    if (expected && plugin.publisherType !== expected.publisherType) fail(`${plugin.id}: expected publisherType ${expected.publisherType}.`);
    if (plugin.publisherType !== "official" && plugin.publisherType !== "community") fail(`${plugin.id}: invalid publisherType.`);
    if (plugin.publisherType === "community" && plugin.bundled === true) fail(`${plugin.id}: community plugins cannot be bundled.`);
    assertNoTranslationRefs(`${plugin.id}.name`, plugin.name);
    assertNoTranslationRefs(`${plugin.id}.description`, plugin.description);
    if (plugin.runtime !== "javascript") fail(`${plugin.id}: current release catalog must only expose JavaScript SDK plugins.`);
    if (!/^3\./.test(String(plugin.sdkVersion ?? ""))) fail(`${plugin.id}: expected SDK v3 catalog entry.`);
    if (typeof plugin.downloadUrl !== "string" || !plugin.downloadUrl.startsWith("https://zip.openpets.dev/plugins/")) fail(`${plugin.id}: invalid plugin ZIP URL.`);
    if (!/^[0-9a-f]{64}$/.test(String(plugin.sha256 ?? ""))) fail(`${plugin.id}: invalid sha256.`);
  }
  return plugins;
}

function validateManifestAgainstCatalog(entry, manifest, localeCatalog, files) {
  if (manifest.id !== entry.id) fail(`${entry.id}: ZIP manifest id mismatch (${manifest.id}).`);
  if (manifest.version !== entry.version) fail(`${entry.id}: ZIP manifest version mismatch.`);
  if (manifest.runtime !== "javascript") fail(`${entry.id}: ZIP manifest must be JavaScript runtime.`);
  if (manifest.manifestVersion !== 3) fail(`${entry.id}: ZIP manifest must use manifestVersion 3.`);
  if (!/^3\./.test(String(manifest.sdkVersion ?? ""))) fail(`${entry.id}: ZIP manifest must use SDK v3.`);
  if (typeof manifest.entry !== "string" || !files.has(manifest.entry)) fail(`${entry.id}: ZIP is missing entry file ${manifest.entry}.`);

  const resolvedName = resolvePluginText(localeCatalog, manifest.name);
  const resolvedDescription = resolvePluginText(localeCatalog, manifest.description);
  if (!resolvedName || hasTranslationRef(resolvedName)) fail(`${entry.id}: manifest name cannot be resolved from locales/en.json.`);
  if (!resolvedDescription || hasTranslationRef(resolvedDescription)) fail(`${entry.id}: manifest description cannot be resolved from locales/en.json.`);
  if (entry.name !== resolvedName) fail(`${entry.id}: catalog name must be resolved user-facing text (${resolvedName ?? "missing"}).`);
  if (entry.description !== resolvedDescription) fail(`${entry.id}: catalog description must be resolved user-facing text.`);

  for (const [kind, group] of Object.entries(manifest.assets ?? {})) {
    if (!isRecord(group)) continue;
    for (const [name, relPath] of Object.entries(group)) {
      const realRelPath = kind === "sprites" && relPath && typeof relPath === "object" ? relPath.path : relPath;
      if (typeof realRelPath !== "string" || !files.has(realRelPath)) fail(`${entry.id}: missing declared ${kind} asset ${name} at ${realRelPath}.`);
      else if (kind === "sprites") {
        try {
          validateSpriteAssetBytes(relPath, files.get(realRelPath), `${entry.id}: sprite ${name} (${realRelPath})`);
        } catch (error) {
          fail(error.message);
        }
      }
    }
  }
}

async function validatePluginPackage(entry) {
  let zip;
  try {
    zip = await loadZip(entry);
  } catch (error) {
    fail(`${entry.id}: ZIP unavailable at ${entry.downloadUrl}: ${error.message}`);
    return;
  }
  if (!zip) return;
  const sha = createHash("sha256").update(zip).digest("hex");
  if (sha !== entry.sha256) fail(`${entry.id}: ZIP sha256 mismatch; catalog=${entry.sha256} actual=${sha}`);

  let files;
  try {
    files = parseStrictZip(zip);
  } catch (error) {
    fail(`${entry.id}: invalid ZIP package: ${error.message}`);
    return;
  }

  if (!files.has("openpets.plugin.json")) {
    fail(`${entry.id}: ZIP missing openpets.plugin.json.`);
    return;
  }
  if (!files.has("locales/en.json")) fail(`${entry.id}: ZIP missing locales/en.json; Control Center cannot resolve plugin $t: metadata after install.`);

  let manifest;
  let localeCatalog = {};
  try {
    manifest = JSON.parse(textDecoder.decode(files.get("openpets.plugin.json")));
    validateDesktopCompatibleReleaseManifest(manifest);
  } catch (error) {
    fail(`${entry.id}: invalid or desktop-incompatible manifest in ZIP: ${error.message}`);
    return;
  }
  try {
    localeCatalog = flattenLocale(JSON.parse(textDecoder.decode(files.get("locales/en.json") ?? Buffer.from("{}"))));
  } catch (error) {
    fail(`${entry.id}: invalid locales/en.json in ZIP: ${error.message}`);
  }
  validateManifestAgainstCatalog(entry, manifest, localeCatalog, files);
}

async function loadProvenance() {
  if (useLive) {
    try {
      const bytes = await fetchBytes("https://openpets.dev/plugins/provenance.json");
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      fail(`provenance: failed to fetch live provenance: ${error.message}`);
      return {};
    }
  }
  try {
    return await readJson(provenancePath);
  } catch (error) {
    fail(`provenance: failed to read local provenance.json: ${error.message}`);
    return {};
  }
}

async function loadSubmissions() {
  if (useLive) {
    try {
      const bytes = await fetchBytes("https://openpets.dev/plugins/submissions.json");
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      return {};
    }
  }
  try {
    return await readJson(submissionsPath);
  } catch {
    return {};
  }
}

async function validateProvenance(provenance, catalogPlugins) {
  if (!isRecord(provenance)) {
    fail("provenance: sidecar must be an object.");
    return;
  }
  const communityIds = new Set(catalogPlugins.filter((plugin) => plugin.publisherType === "community").map((plugin) => plugin.id));
  const allowedFields = new Set(["publisher", "sourceUrl", "sourceSubdirectory", "sourceCommit", "reviewedTreeSha256", "reviewedAt", "updatePolicy"]);
  for (const [pluginId, entry] of Object.entries(provenance)) {
    if (!/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(pluginId)) {
      fail(`provenance: invalid plugin ID key "${pluginId}"`);
      continue;
    }
    if (!isRecord(entry)) {
      fail(`provenance [${pluginId}]: entry must be an object.`);
      continue;
    }
    if (!communityIds.has(pluginId)) fail(`provenance [${pluginId}]: no matching installable community plugin exists.`);
    for (const key of Object.keys(entry)) if (!allowedFields.has(key)) fail(`provenance [${pluginId}]: unknown field ${key}.`);
    if (typeof entry.publisher !== "string" || entry.publisher.trim() === "") {
      fail(`provenance [${pluginId}]: publisher must be a non-empty string.`);
    }
    if (typeof entry.sourceUrl !== "string" || !entry.sourceUrl.startsWith("https://github.com/")) {
      fail(`provenance [${pluginId}]: sourceUrl must be a GitHub URL starting with https://github.com/.`);
    }
    if (entry.sourceSubdirectory !== undefined && entry.sourceSubdirectory !== null && typeof entry.sourceSubdirectory !== "string") {
      fail(`provenance [${pluginId}]: sourceSubdirectory must be a string.`);
    }
    if (typeof entry.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(entry.sourceCommit)) {
      fail(`provenance [${pluginId}]: sourceCommit must be a lowercase 40-character hex commit SHA.`);
    }
    if (typeof entry.reviewedTreeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.reviewedTreeSha256)) {
      fail(`provenance [${pluginId}]: reviewedTreeSha256 must be a lowercase SHA-256 digest.`);
    }
    if (typeof entry.reviewedAt !== "string" || isNaN(Date.parse(entry.reviewedAt))) {
      fail(`provenance [${pluginId}]: reviewedAt must be a valid ISO date string.`);
    }
    if (entry.updatePolicy !== "safe-auto" && entry.updatePolicy !== "manual-review") {
      fail(`provenance [${pluginId}]: updatePolicy must be "safe-auto" or "manual-review".`);
    }
  }

  for (const plugin of catalogPlugins) {
    if (plugin.publisherType === "community") {
      const entry = provenance[plugin.id];
      if (!entry) {
        fail(`provenance: community plugin "${plugin.id}" listed in catalog, but missing from provenance.json.`);
      } else if (isRecord(entry) && typeof entry.reviewedTreeSha256 === "string" && /^[0-9a-f]{64}$/.test(entry.reviewedTreeSha256)) {
        try {
          const actual = await computeReviewedTreeSha256(join(communityDir, plugin.id));
          if (actual !== entry.reviewedTreeSha256) fail(`provenance [${plugin.id}]: current source tree does not match the reviewed tree digest.`);
        } catch (error) {
          fail(`provenance [${plugin.id}]: could not verify current source tree: ${error.message}`);
        }
      }
    }
  }
}

function validateSubmissions(submissions, catalogPlugins) {
  if (!isRecord(submissions)) {
    fail("submissions: sidecar must be an object.");
    return;
  }
  const catalogIds = new Set(catalogPlugins.map((plugin) => plugin.id));
  for (const [pluginId, entry] of Object.entries(submissions)) {
    if (!/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(pluginId)) {
      fail(`submissions: invalid plugin ID key "${pluginId}"`);
      continue;
    }
    if (catalogIds.has(pluginId)) fail(`submissions [${pluginId}]: installable catalog plugins must not remain in pending submissions.`);
    if (!isRecord(entry)) {
      fail(`submissions [${pluginId}]: entry must be an object.`);
      continue;
    }
    if (typeof entry.name !== "string" || entry.name.trim() === "") fail(`submissions [${pluginId}]: name must be a non-empty string.`);
    if (typeof entry.description !== "string" || entry.description.trim() === "") fail(`submissions [${pluginId}]: description must be a non-empty string.`);
    if (typeof entry.publisher !== "string" || entry.publisher.trim() === "") fail(`submissions [${pluginId}]: publisher must be a non-empty string.`);
    if (typeof entry.sourceUrl !== "string" || !entry.sourceUrl.startsWith("https://github.com/")) fail(`submissions [${pluginId}]: sourceUrl must be a GitHub URL starting with https://github.com/.`);
    if (entry.sourceSubdirectory !== undefined && entry.sourceSubdirectory !== null && typeof entry.sourceSubdirectory !== "string") fail(`submissions [${pluginId}]: sourceSubdirectory must be a string.`);
    if (typeof entry.sourceCommit !== "string" || !/^[0-9a-f]{40}$/i.test(entry.sourceCommit)) fail(`submissions [${pluginId}]: sourceCommit must be a 40-character hex commit SHA.`);
    if (typeof entry.submittedAt !== "string" || isNaN(Date.parse(entry.submittedAt))) fail(`submissions [${pluginId}]: submittedAt must be a valid ISO date string.`);
    if (entry.status !== "under-review") fail(`submissions [${pluginId}]: status must be "under-review".`);
  }
}

const expectedEntries = await expectedPluginEntries();
const catalog = await loadCatalog();
const plugins = validateCatalog(catalog, expectedEntries);
const provenance = await loadProvenance();
const submissions = await loadSubmissions();
try {
  validateCommunityMetadata({
    provenance,
    submissions,
    communityIds: plugins.filter((plugin) => plugin.publisherType === "community").map((plugin) => plugin.id),
  });
} catch (error) {
  fail(`community sidecars: ${error.message}`);
}
await validateProvenance(provenance, plugins);
validateSubmissions(submissions, plugins);
for (const entry of plugins) await validatePluginPackage(entry);

if (errors.length > 0) {
  console.error(`Plugin release validation failed with ${errors.length} issue${errors.length === 1 ? "" : "s"}:`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Plugin release validation passed for ${plugins.length} plugin${plugins.length === 1 ? "" : "s"}${useLive ? " (live)" : ""}.`);
