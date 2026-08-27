import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { getCodexPetSpriteLayout, maxCodexPetJsonBytes, maxCodexSpritesheetBytes, validateCodexPetMetadata, validateCodexPetSpritesheet, type CodexPetMetadata } from "./codex-pets-core.js";
import { readBoundedRegularFile } from "./pet-file-safety.js";

export interface LegacyCodexImportRecord {
  readonly id: string;
  readonly source?: {
    readonly kind?: string;
    readonly path?: string;
  };
}

export interface LegacyCodexV2MigrationOptions {
  readonly codexPetsRoot: string;
  readonly installedPetsRoot: string;
}

export type LegacyCodexV2MigrationSkipReason =
  | "already-current"
  | "invalid-pet-id"
  | "source-path-mismatch"
  | "source-unavailable"
  | "source-manifest-invalid"
  | "source-not-v2"
  | "local-unavailable"
  | "local-manifest-invalid"
  | "local-atlas-invalid"
  | "atlas-hash-mismatch"
  | "repair-failed";

export type LegacyCodexV2MigrationEntry =
  | { readonly id: string; readonly status: "repaired" }
  | { readonly id: string; readonly status: "skipped"; readonly reason: LegacyCodexV2MigrationSkipReason };

export interface LegacyCodexV2MigrationResult {
  readonly repaired: number;
  readonly skipped: number;
  readonly entries: readonly LegacyCodexV2MigrationEntry[];
}

class SkipMigration extends Error {
  constructor(readonly reason: LegacyCodexV2MigrationSkipReason) {
    super(reason);
  }
}

export async function migrateLegacyCodexV2Imports(records: readonly LegacyCodexImportRecord[], options: LegacyCodexV2MigrationOptions): Promise<LegacyCodexV2MigrationResult> {
  const entries: LegacyCodexV2MigrationEntry[] = [];

  for (const record of records) {
    if (record.source?.kind !== "codex") continue;
    try {
      await migrateLegacyCodexV2Import(record, options);
      entries.push({ id: record.id, status: "repaired" });
    } catch (error) {
      entries.push({
        id: record.id,
        status: "skipped",
        reason: error instanceof SkipMigration ? error.reason : "repair-failed",
      });
    }
  }

  return {
    repaired: entries.filter((entry) => entry.status === "repaired").length,
    skipped: entries.filter((entry) => entry.status === "skipped").length,
    entries,
  };
}

export function summarizeLegacyCodexV2MigrationSkips(result: LegacyCodexV2MigrationResult): Partial<Record<LegacyCodexV2MigrationSkipReason, number>> {
  const reasons: Partial<Record<LegacyCodexV2MigrationSkipReason, number>> = {};
  for (const entry of result.entries) {
    if (entry.status !== "skipped") continue;
    reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
  }
  return reasons;
}

async function migrateLegacyCodexV2Import(record: LegacyCodexImportRecord, options: LegacyCodexV2MigrationOptions): Promise<void> {
  if (!isSafePetId(record.id)) throw new SkipMigration("invalid-pet-id");

  const localDir = resolve(options.installedPetsRoot, record.id);
  try {
    await assertCanonicalChildDirectory(options.installedPetsRoot, localDir);
  } catch {
    throw new SkipMigration("local-unavailable");
  }

  const localMetadataRecord = await readMetadataRecord(localDir, record.id, "local-manifest-invalid");
  const localMetadata = localMetadataRecord.metadata;
  if (getCodexPetSpriteLayout(localMetadata).version === 2) throw new SkipMigration("already-current");

  const sourceDir = resolve(record.source?.path ?? "");
  const expectedSourceDir = resolve(options.codexPetsRoot, record.id);
  if (sourceDir !== expectedSourceDir) throw new SkipMigration("source-path-mismatch");
  try {
    await assertCanonicalChildDirectory(options.codexPetsRoot, sourceDir);
  } catch {
    throw new SkipMigration("source-unavailable");
  }

  const sourceMetadata = (await readMetadataRecord(sourceDir, record.id, "source-manifest-invalid")).metadata;
  if (sourceMetadata.spriteVersionNumber !== 2) throw new SkipMigration("source-not-v2");

  let localAtlas: Buffer;
  try {
    localAtlas = await readBoundedRegularFile(join(localDir, localMetadata.spritesheetPath), maxCodexSpritesheetBytes, "Installed Codex spritesheet");
    await validateCodexPetSpritesheet(localAtlas, sourceMetadata);
  } catch {
    throw new SkipMigration("local-atlas-invalid");
  }

  let sourceAtlas: Buffer;
  try {
    sourceAtlas = await readBoundedRegularFile(join(sourceDir, sourceMetadata.spritesheetPath), maxCodexSpritesheetBytes, "Source Codex spritesheet");
  } catch {
    throw new SkipMigration("source-unavailable");
  }

  if (sha256(sourceAtlas) !== sha256(localAtlas)) throw new SkipMigration("atlas-hash-mismatch");

  try {
    await writeMetadataAtomically(localDir, { ...localMetadataRecord.manifest, spriteVersionNumber: 2 });
    const repairedMetadata = (await readMetadataRecord(localDir, record.id, "repair-failed")).metadata;
    if (repairedMetadata.spriteVersionNumber !== 2) throw new Error("Codex V2 marker was not persisted.");
  } catch (error) {
    if (error instanceof SkipMigration && error.reason === "repair-failed") throw error;
    throw new SkipMigration("repair-failed");
  }
}

async function readMetadataRecord(dir: string, petId: string, reason: LegacyCodexV2MigrationSkipReason): Promise<{ readonly metadata: CodexPetMetadata; readonly manifest: Readonly<Record<string, unknown>> }> {
  try {
    const parsed = JSON.parse((await readBoundedRegularFile(join(dir, "pet.json"), maxCodexPetJsonBytes, "Codex pet metadata")).toString("utf8")) as unknown;
    const metadata = validateCodexPetMetadata(parsed, petId);
    return { metadata, manifest: parsed as Record<string, unknown> };
  } catch {
    throw new SkipMigration(reason);
  }
}

async function assertCanonicalChildDirectory(root: string, target: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) throw new Error("Path escapes root.");

  const rootStats = await lstat(resolvedRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory() || await realpath(resolvedRoot) !== resolvedRoot) throw new Error("Root is not canonical.");

  const targetStats = await lstat(resolvedTarget);
  if (targetStats.isSymbolicLink() || !targetStats.isDirectory() || await realpath(resolvedTarget) !== resolvedTarget) throw new Error("Directory is not canonical.");
}

async function writeMetadataAtomically(dir: string, metadata: Readonly<Record<string, unknown>>): Promise<void> {
  const metadataPath = join(dir, "pet.json");
  const tempPath = join(dir, `.pet.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(tempPath, metadataPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSafePetId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) && value !== "builtin";
}
