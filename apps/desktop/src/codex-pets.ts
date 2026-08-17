import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import sharp from "sharp";

import { getAppStateSnapshot, installPetState, type OpenPetsStateV1 } from "./app-state.js";
import { maxCodexPetJsonBytes, maxCodexPets, maxCodexSpritesheetBytes, maxCodexThumbnailSourceBytes, validateCodexPetMetadata, validateCodexPetSpritesheet, type CodexPetMetadata } from "./codex-pets-core.js";
import { readBoundedRegularFile } from "./pet-file-safety.js";
import { withPetOperation } from "./pet-installation.js";
import { assertInsideRoot, assertSafePetId, getInstalledPetDir, getPetsRoot } from "./pet-paths.js";

const codexPetsRoot = join(homedir(), ".codex", "pets");
const codexThumbnailCache = new Map<string, string>();

export interface CodexPetUiState {
  readonly source: "codex";
  readonly pets: readonly CodexPetUiItem[];
  readonly error?: string;
}

export interface CodexPetUiItem {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly preview: string;
  readonly spritesheet: string;
}

export async function getCodexPetsUiState(): Promise<CodexPetUiState> {
  try {
    const root = await validateCodexRoot();
    const entries = (await readdir(codexPetsRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    const pets: CodexPetUiItem[] = [];
    let attemptedDirectories = 0;

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      attemptedDirectories += 1;
      if (attemptedDirectories > maxCodexPets) break;
      const pet = await tryReadCodexPet(root, join(root, entry.name), entry.name);
      if (pet) {
        pets.push(pet);
      }
    }

    pets.sort((left, right) => left.displayName.localeCompare(right.displayName));
    return { source: "codex", pets };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { source: "codex", pets: [] };
    return { source: "codex", pets: [], error: error instanceof Error ? error.message : "Codex pets unavailable." };
  }
}

export async function importCodexPet(petId: string): Promise<OpenPetsStateV1> {
  return withPetOperation(petId, async () => {
    assertSafePetId(petId);
    if (getAppStateSnapshot().pets.installed.some((pet) => pet.id === petId)) {
      throw new Error(`Pet is already installed: ${petId}`);
    }

    const root = await validateCodexRoot();
    const sourceDir = resolve(root, petId);
    await assertCodexPetDirectory(root, sourceDir);
    const metadata = await readCodexPetMetadata(root, sourceDir, petId);
    const spritesheetPath = join(sourceDir, metadata.spritesheetPath);
    const spritesheet = await readBoundedRegularFile(spritesheetPath, maxCodexSpritesheetBytes, "spritesheet.webp");
    await validateCodexPetSpritesheet(spritesheet, metadata);

    const petsRoot = getPetsRoot();
    await mkdir(petsRoot, { recursive: true, mode: 0o700 });
    const finalDir = getInstalledPetDir(petId);
    const tempDir = await mkdtemp(join(petsRoot, `.codex-import-${petId}-`));

    try {
      assertInsideRoot(petsRoot, tempDir);
      await writeFile(join(tempDir, "spritesheet.webp"), spritesheet, { mode: 0o600, flag: "wx" });
      await writeFile(join(tempDir, "pet.json"), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rm(finalDir, { recursive: true, force: true });
      await rename(tempDir, finalDir);

      try {
        await validateInstalledRegularFile(join(finalDir, "spritesheet.webp"));
        await validateInstalledRegularFile(join(finalDir, "pet.json"));
        return installPetState({
          id: metadata.id,
          displayName: metadata.displayName,
          description: metadata.description,
          source: { kind: "codex", path: sourceDir },
        });
      } catch (error) {
        await rm(finalDir, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  });
}

async function tryReadCodexPet(root: string, dir: string, folderName: string): Promise<CodexPetUiItem | null> {
  try {
    const metadata = await readCodexPetMetadata(root, dir, folderName);
    const spritesheetPath = join(dir, metadata.spritesheetPath);
    await validateSpritesheet(spritesheetPath, metadata);
    const preview = await createCodexThumbnailDataUrl(spritesheetPath);
    return {
      id: metadata.id,
      displayName: metadata.displayName,
      description: metadata.description,
      preview,
      spritesheet: `openpets-codex://spritesheet/${encodeURIComponent(metadata.id)}`,
    };
  } catch (error) {
    console.error(`Skipping invalid Codex pet at ${dir}.`, error);
    return null;
  }
}

export async function readCodexPetSpritesheet(petId: string): Promise<Buffer> {
  assertSafePetId(petId);
  const root = await validateCodexRoot();
  const sourceDir = resolve(root, petId);
  const metadata = await readCodexPetMetadata(root, sourceDir, petId);
  const spritesheet = await readBoundedRegularFile(join(sourceDir, metadata.spritesheetPath), maxCodexSpritesheetBytes, "spritesheet.webp");
  await validateCodexPetSpritesheet(spritesheet, metadata);
  return spritesheet;
}

async function readCodexPetMetadata(root: string, dir: string, folderName: string): Promise<CodexPetMetadata> {
  await assertCodexPetDirectory(root, dir);
  assertSafePetId(folderName);
  const petJson = join(dir, "pet.json");
  const parsed = JSON.parse((await readBoundedRegularFile(petJson, maxCodexPetJsonBytes, "pet.json")).toString("utf8")) as unknown;
  const metadata = validateCodexPetMetadata(parsed, folderName);
  assertSafePetId(metadata.id);
  return metadata;
}

async function validateSpritesheet(path: string, metadata: CodexPetMetadata): Promise<void> {
  await validateCodexPetSpritesheet(await readBoundedRegularFile(path, maxCodexSpritesheetBytes, "spritesheet.webp"), metadata);
}

async function createCodexThumbnailDataUrl(path: string): Promise<string> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size <= 0 || stats.size > maxCodexThumbnailSourceBytes) return "";
  const cacheKey = `${path}:${stats.size}:${stats.mtimeMs}`;
  const cached = codexThumbnailCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const image = sharp(path, { limitInputPixels: 50_000_000 });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) return "";
  const width = Math.min(192, metadata.width);
  const height = Math.min(208, metadata.height);
  const thumbnail = await sharp(path, { limitInputPixels: 50_000_000 })
    .extract({ left: 0, top: 0, width, height })
    .resize(54, 58, { fit: "fill" })
    .png()
    .toBuffer();
  const afterStats = await lstat(path);
  if (afterStats.isSymbolicLink() || !afterStats.isFile() || afterStats.size !== stats.size || afterStats.mtimeMs !== stats.mtimeMs) return "";
  const dataUrl = `data:image/png;base64,${thumbnail.toString("base64")}`;
  codexThumbnailCache.set(cacheKey, dataUrl);
  return dataUrl;
}

async function validateCodexRoot(): Promise<string> {
  const root = resolve(codexPetsRoot);
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink()) throw new Error("Codex pets root cannot be a symlink.");
  if (!rootStats.isDirectory()) throw new Error("Codex pets path is not a directory.");
  const realRoot = await realpath(root);
  if (realRoot !== root) throw new Error("Codex pets root path is not canonical.");
  return root;
}

async function assertCodexPetDirectory(root: string, target: string): Promise<void> {
  const resolvedTarget = resolve(target);
  if (resolvedTarget === root || !resolvedTarget.startsWith(`${root}${sep}`) || basename(resolvedTarget).startsWith(".")) {
    throw new Error("Resolved path escapes Codex pets directory.");
  }
  const dirStats = await lstat(resolvedTarget);
  if (dirStats.isSymbolicLink()) throw new Error("Codex pet directory cannot be a symlink.");
  if (!dirStats.isDirectory()) throw new Error("Codex pet path must be a directory.");
  const realTarget = await realpath(resolvedTarget);
  if (!realTarget.startsWith(`${root}${sep}`)) throw new Error("Codex pet directory escapes Codex pets root.");
}

async function validateInstalledRegularFile(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new Error("Imported pet file cannot be a symlink.");
  if (!stats.isFile()) throw new Error("Imported pet file must be a regular file.");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
