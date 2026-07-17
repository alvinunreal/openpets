import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeReviewedTreeSha256,
  createDeterministicZip,
  packagePluginDirectory,
  parseStrictZip,
  syncPlugins,
  validateCommunityMetadata,
  validateDesktopCompatiblePluginCatalogV2,
  validateDesktopCompatibleReleaseManifest,
  validateSafeRelativePath,
} from "./sync-plugins.mjs";

function localEntryNames(zip) {
  const names = [];
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    names.push(zip.subarray(nameStart, nameStart + nameLength).toString("utf8"));
    offset = nameStart + nameLength + extraLength + compressedSize;
  }
  return names;
}

async function createFixture(root) {
  const pluginDir = join(root, "openpets.fixture");
  await mkdir(join(pluginDir, "assets"), { recursive: true });
  await mkdir(join(pluginDir, "locales"), { recursive: true });
  await writeFile(join(pluginDir, "openpets.plugin.json"), `${JSON.stringify({
    manifestVersion: 3,
    id: "openpets.fixture",
    name: "$t:plugin.name",
    description: "$t:plugin.description",
    version: "1.0.0",
    runtime: "javascript",
    sdkVersion: "3.0.0",
    entry: "index.js",
    icon: "plugin",
    permissions: ["pet:speak"],
    assets: { icons: { fixture: "assets/fixture.svg" } },
  }, null, 2)}\n`);
  await writeFile(join(pluginDir, "index.js"), "export default function register() {}\n");
  await writeFile(join(pluginDir, "assets", "fixture.svg"), '<svg xmlns="http://www.w3.org/2000/svg" onload="bad()"><path d="M0 0"/></svg>\n');
  await writeFile(join(pluginDir, "locales", "en.json"), `${JSON.stringify({ plugin: { name: "Fixture", description: "A fixture plugin." } }, null, 2)}\n`);
  return pluginDir;
}

function validReleaseManifest(patch = {}) {
  return {
    manifestVersion: 3,
    id: "openpets.fixture",
    name: "Fixture",
    description: "A fixture plugin.",
    version: "1.0.0",
    runtime: "javascript",
    sdkVersion: "3.0.0",
    entry: "index.js",
    permissions: ["pet:speak"],
    ...patch,
  };
}

function validCatalogEntry(patch = {}) {
  return {
    id: "openpets.fixture",
    name: "Fixture",
    version: "1.0.0",
    description: "A fixture plugin.",
    runtime: "javascript",
    icon: "plugin",
    permissions: ["pet:speak"],
    downloadUrl: "https://zip.openpets.dev/plugins/openpets.fixture.zip",
    sha256: "a".repeat(64),
    sdkVersion: "3.0.0",
    publisherType: "official",
    ...patch,
  };
}

async function createRepositoryFixture(root) {
  await mkdir(join(root, "plugins", "official"), { recursive: true });
  await mkdir(join(root, "plugins", "community"), { recursive: true });
  await createFixture(join(root, "plugins", "official"));
  await writeFile(join(root, "plugins", "community", "provenance.json"), "{}\n");
  await writeFile(join(root, "plugins", "community", "submissions.json"), "{}\n");
}

test("deterministic ZIP bytes ignore input order and source mtimes", async () => {
  const first = createDeterministicZip([
    { name: "z.txt", data: Buffer.from("z") },
    { name: "a.txt", data: Buffer.from("a") },
  ]);
  const second = createDeterministicZip([
    { name: "a.txt", data: Buffer.from("a") },
    { name: "z.txt", data: Buffer.from("z") },
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(localEntryNames(first), ["a.txt", "z.txt"]);
  const unicode = createDeterministicZip([
    { name: "é.txt", data: Buffer.from("accent") },
    { name: "z.txt", data: Buffer.from("ascii") },
  ]);
  assert.deepEqual(localEntryNames(unicode), ["z.txt", "é.txt"], "ZIP names use fixed UTF-8 byte order, not host locale collation");
  assert.deepEqual([...parseStrictZip(first).keys()], ["a.txt", "z.txt"]);

  const root = await mkdtemp(join(tmpdir(), "openpets-plugin-sync-"));
  try {
    const pluginDir = await createFixture(root);
    const before = await packagePluginDirectory({ pluginDir, publisherType: "official" });
    const future = new Date("2040-01-01T00:00:00Z");
    await Promise.all([
      utimes(join(pluginDir, "openpets.plugin.json"), future, future),
      utimes(join(pluginDir, "index.js"), future, future),
      utimes(join(pluginDir, "assets", "fixture.svg"), future, future),
      utimes(join(pluginDir, "locales", "en.json"), future, future),
    ]);
    const after = await packagePluginDirectory({ pluginDir, publisherType: "official" });
    assert.equal(createHash("sha256").update(before.zip).digest("hex"), createHash("sha256").update(after.zip).digest("hex"));
    assert.deepEqual(before.zip, after.zip);
    assert.deepEqual(localEntryNames(before.zip), ["assets/fixture.svg", "index.js", "locales/en.json", "openpets.plugin.json"]);
    assert.doesNotMatch(before.packageFiles.get("assets/fixture.svg").toString("utf8"), /onload=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ZIP and plugin source paths reject traversal, Windows hazards, and symbolic links", async (t) => {
  for (const unsafe of ["../escape", "/absolute", "nested\\windows", "a/../b", "C:/drive"]) {
    assert.throws(() => validateSafeRelativePath(unsafe), /safe relative path/);
    assert.throws(() => createDeterministicZip([{ name: unsafe, data: Buffer.alloc(0) }]), /safe relative path/);
  }
  for (const unsafe of ["CON", "con.txt", "dir/AUX.js", "NUL.json", "COM1.log", "LPT9", "file:stream", "trailing.", "trailing ", "question?.txt"]) {
    assert.throws(() => validateSafeRelativePath(unsafe), /Windows-unsafe/);
    assert.throws(() => createDeterministicZip([{ name: unsafe, data: Buffer.alloc(0) }]), /Windows-unsafe/);
  }
  assert.throws(() => createDeterministicZip([
    { name: "same.txt", data: Buffer.from("one") },
    { name: "same.txt", data: Buffer.from("two") },
  ]), /Duplicate ZIP entry/);

  const root = await mkdtemp(join(tmpdir(), "openpets-plugin-sync-"));
  try {
    const pluginDir = await createFixture(root);
    const outside = join(root, "outside.svg");
    await writeFile(outside, "<svg/>\n");
    await unlink(join(pluginDir, "assets", "fixture.svg"));
    try { await symlink(outside, join(pluginDir, "assets", "fixture.svg")); }
    catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("Symbolic links are unavailable on this platform."); return; }
      throw error;
    }
    await assert.rejects(packagePluginDirectory({ pluginDir, publisherType: "official" }), /symbolic links are not allowed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict ZIP validation checks CRC, matching headers, central directory, and trailing bytes", () => {
  const valid = createDeterministicZip([
    { name: "a.txt", data: Buffer.from("alpha") },
    { name: "nested/b.txt", data: Buffer.from("beta") },
  ]);
  assert.deepEqual([...parseStrictZip(valid)].map(([name, data]) => [name, data.toString("utf8")]), [["a.txt", "alpha"], ["nested/b.txt", "beta"]]);

  const badCrc = Buffer.from(valid);
  const firstDataOffset = 30 + badCrc.readUInt16LE(26) + badCrc.readUInt16LE(28);
  badCrc[firstDataOffset] ^= 0xff;
  assert.throws(() => parseStrictZip(badCrc), /CRC-32/);

  const badCentralHeader = Buffer.from(valid);
  const eocdOffset = badCentralHeader.length - 22;
  const centralOffset = badCentralHeader.readUInt32LE(eocdOffset + 16);
  badCentralHeader.writeUInt32LE((badCentralHeader.readUInt32LE(centralOffset + 16) + 1) >>> 0, centralOffset + 16);
  assert.throws(() => parseStrictZip(badCentralHeader), /headers disagree/);

  const badEocd = Buffer.from(valid);
  badEocd.writeUInt32LE(centralOffset + 1, eocdOffset + 16);
  assert.throws(() => parseStrictZip(badEocd), /central-directory offset or size/);
  assert.throws(() => parseStrictZip(Buffer.concat([valid, Buffer.from("trailing")])), /end-of-central-directory|trailing bytes/);

  const legacyAscii = createDeterministicZip([{ name: "legacy.txt", data: Buffer.from("legacy") }]);
  const legacyEocd = legacyAscii.length - 22;
  const legacyCentral = legacyAscii.readUInt32LE(legacyEocd + 16);
  legacyAscii.writeUInt16LE(0, 6);
  legacyAscii.writeUInt16LE(0, legacyCentral + 8);
  assert.equal(parseStrictZip(legacyAscii).get("legacy.txt").toString("utf8"), "legacy");

  const forbiddenFlag = Buffer.from(legacyAscii);
  forbiddenFlag.writeUInt16LE(1, 6);
  forbiddenFlag.writeUInt16LE(1, legacyCentral + 8);
  assert.throws(() => parseStrictZip(forbiddenFlag), /forbidden ZIP flags/);

  const nonAsciiWithoutFlag = createDeterministicZip([{ name: "é.txt", data: Buffer.from("accent") }]);
  const nonAsciiEocd = nonAsciiWithoutFlag.length - 22;
  const nonAsciiCentral = nonAsciiWithoutFlag.readUInt32LE(nonAsciiEocd + 16);
  nonAsciiWithoutFlag.writeUInt16LE(0, 6);
  nonAsciiWithoutFlag.writeUInt16LE(0, nonAsciiCentral + 8);
  assert.throws(() => parseStrictZip(nonAsciiWithoutFlag), /non-ASCII name without the UTF-8 flag/);
});

test("release manifest validation covers the desktop JavaScript v3 contract", () => {
  assert.doesNotThrow(() => validateDesktopCompatibleReleaseManifest(validReleaseManifest()));
  const tooManyIcons = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`icon-${index}`, `assets/${index}.svg`]));
  const tooManyPanels = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`panel-${index}`, `panels/${index}.html`]));
  const invalidManifests = [
    validReleaseManifest({ configSchema: { message: { type: "text", helperText: "unsupported" } } }),
    validReleaseManifest({ configSchema: { message: { type: "text", default: 1 } } }),
    validReleaseManifest({ configSchema: { message: { type: "textarea", default: false } } }),
    validReleaseManifest({ configSchema: { count: { type: "number", default: Number.POSITIVE_INFINITY } } }),
    validReleaseManifest({ configSchema: { enabled: { type: "boolean", default: "yes" } } }),
    validReleaseManifest({ configSchema: { time: { type: "time", default: "24:00" } } }),
    validReleaseManifest({ configSchema: { date: { type: "date", default: "2026/07/17" } } }),
    validReleaseManifest({ configSchema: { token: { type: "secret", default: "secret" } } }),
    validReleaseManifest({ configSchema: { message: { type: "text", options: [{ label: "A", value: "a" }] } } }),
    validReleaseManifest({ configSchema: { mood: { type: "select" } } }),
    validReleaseManifest({ configSchema: { mood: { type: "select", default: "b", options: [{ label: "A", value: "a" }] } } }),
    validReleaseManifest({ configSchema: { mood: { type: "select", options: [{ label: "A", value: "a" }, { label: "B", value: "a" }] } } }),
    validReleaseManifest({ configSchema: { mood: { type: "multiSelect", default: ["b"], options: [{ label: "A", value: "a" }] } } }),
    validReleaseManifest({ configSchema: { mood: { type: "multiSelect", presentation: "sprite-grid", options: [{ label: "A", value: "a" }] } } }),
    validReleaseManifest({ configSchema: { rows: { type: "list", maxItems: -1 } } }),
    validReleaseManifest({ configSchema: { rows: { type: "list", itemSchema: { nested: { type: "text", unknown: true } } } } }),
    validReleaseManifest({ version: `1.0.0+${"a".repeat(75)}` }),
    validReleaseManifest({ sdkVersion: `3.0.0+${"a".repeat(75)}` }),
    validReleaseManifest({ permissions: ["network"], network: { hosts: [`${"a".repeat(250)}.com`] } }),
    validReleaseManifest({ assets: { icons: tooManyIcons } }),
    validReleaseManifest({ assets: { sprites: { mood: { path: "assets/mood.webp", frameWidth: 31, frameHeight: 64, frames: 4, durationMs: 500 } } } }),
    validReleaseManifest({ panels: tooManyPanels }),
    validReleaseManifest({
      assets: { sprites: { mood: { path: "assets/mood.webp", frameWidth: 64, frameHeight: 64, frames: 4, durationMs: 500 } } },
      configSchema: { mood: { type: "select", presentation: "sprite-grid", options: [{ label: "Missing", value: "missing", previewSprite: "missing" }] } },
    }),
  ];
  for (const manifest of invalidManifests) assert.throws(() => validateDesktopCompatibleReleaseManifest(manifest));
});

test("catalog production enforces the desktop v2 schema and field limits", () => {
  const valid = { version: 2, generatedAt: "2026-07-17T00:00:00.000Z", plugins: [validCatalogEntry()] };
  assert.doesNotThrow(() => validateDesktopCompatiblePluginCatalogV2(valid));
  const invalidCatalogs = [
    { ...valid, unexpected: true },
    { ...valid, version: 1 },
    { ...valid, generatedAt: "x".repeat(129) },
    { ...valid, plugins: [{ ...validCatalogEntry(), version: `1.0.0+${"a".repeat(75)}` }] },
    { ...valid, plugins: [{ ...validCatalogEntry(), sdkVersion: `3.0.0+${"a".repeat(75)}` }] },
    { ...valid, plugins: [{ ...validCatalogEntry(), iconDataUrl: `data:image/svg+xml;base64,${"A".repeat(100_000)}` }] },
    { ...valid, plugins: [{ ...validCatalogEntry(), permissions: ["network"], network: { hosts: [`${"a".repeat(250)}.com`] } }] },
    { ...valid, plugins: [{ ...validCatalogEntry(), statusReason: "x".repeat(501) }] },
  ];
  for (const catalog of invalidCatalogs) assert.throws(() => validateDesktopCompatiblePluginCatalogV2(catalog));
});

test("packaging rejects an SVG icon whose emitted catalog data URL is too large", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpets-plugin-icon-"));
  try {
    const pluginDir = await createFixture(root);
    await writeFile(join(pluginDir, "assets", "fixture.svg"), `<svg xmlns="http://www.w3.org/2000/svg">${" ".repeat(76_000)}</svg>\n`);
    await assert.rejects(packagePluginDirectory({ pluginDir, publisherType: "official" }), /iconDataUrl.*100000/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewed tree digests change with any source byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpets-plugin-tree-"));
  try {
    const pluginDir = await createFixture(root);
    const before = await computeReviewedTreeSha256(pluginDir);
    await writeFile(join(pluginDir, "README.md"), "reviewed source\n");
    const after = await computeReviewedTreeSha256(pluginDir);
    assert.match(before, /^[0-9a-f]{64}$/);
    assert.notEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact writes and stale cleanup reject symbolic-link ancestry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openpets-plugin-output-"));
  const outside = await mkdtemp(join(tmpdir(), "openpets-plugin-outside-"));
  try {
    await createRepositoryFixture(root);
    await mkdir(join(root, "web"));
    try { await symlink(outside, join(root, "web", "public")); }
    catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("Symbolic links are unavailable on this platform."); return; }
      throw error;
    }
    await assert.rejects(syncPlugins({ repoRoot: root, skipR2: true }), /ancestry|symbolic link/);

    await unlink(join(root, "web", "public"));
    await syncPlugins({ repoRoot: root, skipR2: true, generatedAt: "2026-07-17T00:00:00.000Z" });
    const outsideZip = join(outside, "outside.zip");
    await writeFile(outsideZip, "outside");
    await symlink(outsideZip, join(root, "web", ".data", "plugin-zips", "stale.zip"));
    await assert.rejects(syncPlugins({ repoRoot: root, skipR2: true }), /stale plugin ZIP|symbolic link/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("community metadata exactly covers installable plugins and excludes pending overlap", () => {
  const provenance = {
    "openpets.fixture": {
      publisher: "fixture-owner",
      sourceUrl: "https://github.com/fixture-owner/openpets-fixture",
      sourceSubdirectory: "plugins/openpets.fixture",
      sourceCommit: "a".repeat(40),
      reviewedTreeSha256: "c".repeat(64),
      reviewedAt: "2026-07-17T00:00:00Z",
      updatePolicy: "manual-review",
    },
  };
  assert.doesNotThrow(() => validateCommunityMetadata({ provenance, submissions: {}, communityIds: ["openpets.fixture"] }));
  assert.throws(() => validateCommunityMetadata({ provenance: {}, submissions: {}, communityIds: ["openpets.fixture"] }), /missing a reviewed snapshot/);
  assert.throws(() => validateCommunityMetadata({ provenance: { "openpets.fixture": { ...provenance["openpets.fixture"], reviewedTreeSha256: "bad" } }, submissions: {}, communityIds: ["openpets.fixture"] }), /reviewedTreeSha256/);
  assert.throws(() => validateCommunityMetadata({
    provenance: { "openpets.fixture": { ...provenance["openpets.fixture"], unexpected: true } },
    submissions: {},
    communityIds: ["openpets.fixture"],
  }), /unknown field unexpected/);
  assert.throws(() => validateCommunityMetadata({
    provenance: { ...provenance, "openpets.extra": { ...provenance["openpets.fixture"], sourceCommit: "b".repeat(40) } },
    submissions: {},
    communityIds: ["openpets.fixture"],
  }), /does not match a current community plugin/);
  assert.throws(() => validateCommunityMetadata({
    provenance,
    submissions: {
      "openpets.fixture": {
        name: "Fixture",
        description: "Pending fixture",
        publisher: "fixture-owner",
        sourceUrl: "https://github.com/fixture-owner/openpets-fixture",
        sourceCommit: "a".repeat(40),
        submittedAt: "2026-07-17T00:00:00Z",
        status: "under-review",
      },
    },
    communityIds: ["openpets.fixture"],
  }), /cannot remain pending/);
});
