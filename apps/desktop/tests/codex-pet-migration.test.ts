import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { migrateLegacyCodexV2Imports } from "../src/codex-pet-migration.js";

const baseDir = await realpath(await mkdtemp(join(tmpdir(), "openpets-codex-v2-migration-")));
const codexPetsRoot = join(baseDir, "codex-pets");
const installedPetsRoot = join(baseDir, "installed-pets");
await mkdir(codexPetsRoot, { recursive: true });
await mkdir(installedPetsRoot, { recursive: true });

const v1Manifest = (id: string) => ({
  id,
  displayName: id,
  description: `${id} test pet`,
  spritesheetPath: "spritesheet.webp",
});
const v2Manifest = (id: string) => ({ ...v1Manifest(id), spriteVersionNumber: 2 });

async function createAtlas(width: number, height: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { ...color, alpha: 0.5 },
    },
  }).webp().toBuffer();
}

async function writePet(root: string, id: string, manifest: Record<string, unknown>, atlas: Buffer): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pet.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(dir, "spritesheet.webp"), atlas);
  return dir;
}

try {
  const validAtlas = await createAtlas(1536, 2288, { r: 12, g: 34, b: 56 });
  const repairId = "repairable";
  const repairSource = await writePet(codexPetsRoot, repairId, v2Manifest(repairId), validAtlas);
  await writePet(installedPetsRoot, repairId, { ...v1Manifest(repairId), importedBy: "legacy-openpets" }, validAtlas);

  const first = await migrateLegacyCodexV2Imports(
    [{ id: repairId, source: { kind: "codex", path: repairSource } }],
    { codexPetsRoot, installedPetsRoot },
  );
  assert.deepEqual(first, {
    repaired: 1,
    skipped: 0,
    entries: [{ id: repairId, status: "repaired" }],
  });
  const repairedManifest = JSON.parse(await readFile(join(installedPetsRoot, repairId, "pet.json"), "utf8"));
  assert.equal(repairedManifest.spriteVersionNumber, 2);
  assert.equal(repairedManifest.importedBy, "legacy-openpets", "the repair changes only the missing marker");

  await rm(repairSource, { recursive: true, force: true });
  const second = await migrateLegacyCodexV2Imports(
    [{ id: repairId, source: { kind: "codex", path: repairSource } }],
    { codexPetsRoot, installedPetsRoot },
  );
  assert.deepEqual(second, {
    repaired: 0,
    skipped: 1,
    entries: [{ id: repairId, status: "skipped", reason: "already-current" }],
  }, "a repaired import is idempotently reported as already current even when its source is no longer available");

  const v1SourceId = "v1-source";
  const v1Source = await writePet(codexPetsRoot, v1SourceId, v1Manifest(v1SourceId), validAtlas);
  await writePet(installedPetsRoot, v1SourceId, v1Manifest(v1SourceId), validAtlas);
  const v1SourceResult = await migrateLegacyCodexV2Imports(
    [{ id: v1SourceId, source: { kind: "codex", path: v1Source } }],
    { codexPetsRoot, installedPetsRoot },
  );
  assert.deepEqual(v1SourceResult.entries, [{ id: v1SourceId, status: "skipped", reason: "source-not-v2" }]);

  const mismatchId = "hash-mismatch";
  const mismatchSourceAtlas = await createAtlas(1536, 2288, { r: 240, g: 20, b: 30 });
  const mismatchLocalAtlas = await createAtlas(1536, 2288, { r: 20, g: 30, b: 240 });
  const mismatchSource = await writePet(codexPetsRoot, mismatchId, v2Manifest(mismatchId), mismatchSourceAtlas);
  await writePet(installedPetsRoot, mismatchId, v1Manifest(mismatchId), mismatchLocalAtlas);
  const mismatchResult = await migrateLegacyCodexV2Imports(
    [{ id: mismatchId, source: { kind: "codex", path: mismatchSource } }],
    { codexPetsRoot, installedPetsRoot },
  );
  assert.deepEqual(mismatchResult.entries, [{ id: mismatchId, status: "skipped", reason: "atlas-hash-mismatch" }]);
  assert.equal("spriteVersionNumber" in JSON.parse(await readFile(join(installedPetsRoot, mismatchId, "pet.json"), "utf8")), false);

  const wrongSizeId = "wrong-size";
  const wrongSizeAtlas = await createAtlas(1536, 2080, { r: 80, g: 90, b: 100 });
  const wrongSizeSource = await writePet(codexPetsRoot, wrongSizeId, v2Manifest(wrongSizeId), wrongSizeAtlas);
  await writePet(installedPetsRoot, wrongSizeId, v1Manifest(wrongSizeId), wrongSizeAtlas);
  const wrongSizeResult = await migrateLegacyCodexV2Imports(
    [{ id: wrongSizeId, source: { kind: "codex", path: wrongSizeSource } }],
    { codexPetsRoot, installedPetsRoot },
  );
  assert.deepEqual(wrongSizeResult.entries, [{ id: wrongSizeId, status: "skipped", reason: "local-atlas-invalid" }]);
  assert.equal("spriteVersionNumber" in JSON.parse(await readFile(join(installedPetsRoot, wrongSizeId, "pet.json"), "utf8")), false);

  console.log("Legacy Codex V2 import migration behavior passed.");
} finally {
  await rm(baseDir, { recursive: true, force: true });
}
