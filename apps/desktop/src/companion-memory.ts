import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { assertSafeCompanionPetId } from "./companion-settings.js";

export type CompanionMemoryRole = "user" | "assistant" | "proactive";

export type CompanionProactiveMemoryMetadata = {
  readonly candidateId: string;
  readonly dedupeKey: string;
  readonly source: "time" | "goal" | "plugin";
  readonly pluginId?: string;
};

export type CompanionMemoryEntry = {
  readonly id: string;
  readonly petId: string;
  readonly role: CompanionMemoryRole;
  readonly text: string;
  readonly createdAt: number;
  /** Policy identity for restart-safe proactive dedupe and source accounting. */
  readonly proactive?: CompanionProactiveMemoryMetadata;
};

export type CompanionMemorySnapshot = {
  readonly version: 1;
  readonly entries: readonly CompanionMemoryEntry[];
};

export type CompanionMemoryCommitInput = {
  readonly petId: string;
  readonly text: string;
  readonly now?: number;
  readonly id?: string;
  /** Accepted only for proactive entries; omitted entries remain legacy-compatible. */
  readonly proactive?: CompanionProactiveMemoryMetadata;
};

export type CompanionMemoryCommitResult = {
  readonly entry: CompanionMemoryEntry;
  /** False means the runtime kept the entry, but disk persistence failed or was not initialized. */
  readonly persisted: boolean;
};

export type CompanionMemoryMutationResult = {
  readonly snapshot: CompanionMemorySnapshot;
  readonly persisted: boolean;
};

export const companionMemoryRetentionMs = 24 * 60 * 60 * 1_000;
export const maxCompanionMemoryEntries = 200;
export const maxCompanionMemoryEntriesPerPet = 60;
export const maxCompanionMemoryContextEntries = 24;
export const maxCompanionMemoryTextCharacters = 2_000;
export const maxCompanionMemoryFileBytes = 512 * 1_024;
export const companionMemoryFileName = "openpets-companion-memory.json";

const maximumFutureSkewMs = 5 * 60 * 1_000;
const validRoles = new Set<CompanionMemoryRole>(["user", "assistant", "proactive"]);
const safeEntryIdPattern = /^[A-Za-z0-9._:-]{1,120}$/;
// Plugin dedupe identity is host-scoped as `<pluginId>:<pluginKey>`, so its
// durable bound must accommodate both individually bounded components.
const safeProactiveIdentityPattern = /^[A-Za-z0-9._:-]{1,192}$/;
const safePluginIdPattern = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;
const proactiveSources = new Set<CompanionProactiveMemoryMetadata["source"]>(["time", "goal", "plugin"]);

let memoryPath: string | null = null;
let cached: CompanionMemorySnapshot = { version: 1, entries: [] };

export function initializeCompanionMemory(userDataPath: string, now = Date.now()): CompanionMemorySnapshot {
  memoryPath = join(userDataPath, companionMemoryFileName);
  const existed = existsSync(memoryPath);
  const raw = readCompanionMemoryFile(memoryPath);
  cached = normalizeCompanionMemory(raw, now);
  // Existing files are rewritten on startup so stale, malformed, or over-limit
  // data is removed from disk as well as from the runtime snapshot.
  if (existed) persistCompanionMemory(cached);
  return snapshot();
}

export function getCompanionMemoryFilePath(): string {
  if (!memoryPath) throw new Error("Companion memory has not been initialized.");
  return memoryPath;
}

/** Prunes before returning so context construction never sees expired entries. */
export function getCompanionMemorySnapshot(now = Date.now()): CompanionMemorySnapshot {
  pruneCompanionMemory(now);
  return snapshot();
}

export function selectRecentCompanionMemory(input: {
  readonly petId: string;
  readonly now?: number;
  readonly limit?: number;
}): readonly CompanionMemoryEntry[] {
  assertSafeCompanionPetId(input.petId);
  const state = getCompanionMemorySnapshot(input.now ?? Date.now());
  const limit = Math.min(maxCompanionMemoryContextEntries, Math.max(0, Math.floor(input.limit ?? maxCompanionMemoryContextEntries)));
  if (limit === 0) return [];
  return state.entries.filter((entry) => entry.petId === input.petId).slice(-limit);
}

/** Call immediately after a typed or transcribed user turn is accepted. */
export function commitCompanionUserTurn(input: CompanionMemoryCommitInput): CompanionMemoryCommitResult {
  return commitEntry("user", input);
}

/** Call only after an assistant response has actually been displayed. */
export function commitCompanionAssistantTurn(input: CompanionMemoryCommitInput): CompanionMemoryCommitResult {
  return commitEntry("assistant", input);
}

/** Call only after a generated proactive check-in has actually been displayed. */
export function commitCompanionProactiveTurn(input: CompanionMemoryCommitInput): CompanionMemoryCommitResult {
  if (input.proactive !== undefined && normalizeProactiveMetadata(input.proactive) === undefined) {
    throw new Error("Invalid proactive companion memory metadata.");
  }
  return commitEntry("proactive", input);
}

export function pruneCompanionMemory(now = Date.now()): CompanionMemorySnapshot {
  const next = normalizeCompanionMemory(cached, now);
  if (!sameEntries(cached.entries, next.entries)) {
    cached = next;
    persistCompanionMemory(cached);
  }
  return snapshot();
}

export function removeCompanionMemoryForPet(petId: string, now = Date.now()): CompanionMemoryMutationResult {
  assertSafeCompanionPetId(petId);
  const next = normalizeCompanionMemory({
    version: 1,
    entries: cached.entries.filter((entry) => entry.petId !== petId),
  }, now);
  cached = next;
  return { snapshot: snapshot(), persisted: persistCompanionMemory(next) };
}

/** Clear all recent memory, or only one pet's memory when petId is supplied. */
export function clearCompanionMemory(petId?: string): CompanionMemoryMutationResult {
  if (petId !== undefined) return removeCompanionMemoryForPet(petId);
  cached = { version: 1, entries: [] };
  return { snapshot: snapshot(), persisted: persistCompanionMemory(cached) };
}

export function normalizeCompanionMemory(value: unknown, now = Date.now()): CompanionMemorySnapshot {
  const raw = isRecord(value) && Array.isArray(value.entries) ? value.entries : [];
  const resolvedNow = normalizeNow(now);
  const cutoff = resolvedNow - companionMemoryRetentionMs;
  const futureLimit = resolvedNow + maximumFutureSkewMs;
  const entries: CompanionMemoryEntry[] = [];

  for (const item of raw) {
    if (!isRecord(item)
      || typeof item.id !== "string"
      || !safeEntryIdPattern.test(item.id)
      || typeof item.petId !== "string"
      || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.petId)
      || !validRoles.has(item.role as CompanionMemoryRole)
      || typeof item.createdAt !== "number"
      || !Number.isFinite(item.createdAt)) continue;
    const createdAt = Math.floor(item.createdAt);
    if (createdAt < cutoff || createdAt > futureLimit) continue;
    const text = normalizeMemoryText(item.text);
    if (!text) continue;
    const role = item.role as CompanionMemoryRole;
    const proactive = role === "proactive" ? normalizeProactiveMetadata(item.proactive) : undefined;
    entries.push({ id: item.id, petId: item.petId, role, text, createdAt, ...(proactive ? { proactive } : {}) });
  }

  entries.sort(compareEntries);
  const perPetCounts = new Map<string, number>();
  const perPetBounded: CompanionMemoryEntry[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const count = perPetCounts.get(entry.petId) ?? 0;
    if (count >= maxCompanionMemoryEntriesPerPet) continue;
    perPetCounts.set(entry.petId, count + 1);
    perPetBounded.push(entry);
  }
  perPetBounded.reverse();
  return boundMemoryFileSize(perPetBounded.slice(-maxCompanionMemoryEntries));
}

function commitEntry(role: CompanionMemoryRole, input: CompanionMemoryCommitInput): CompanionMemoryCommitResult {
  assertSafeCompanionPetId(input.petId);
  const text = normalizeMemoryText(input.text);
  if (!text) throw new Error("Companion memory text is required.");
  const now = normalizeNow(input.now ?? Date.now());
  const id = input.id ?? randomUUID();
  if (!safeEntryIdPattern.test(id)) throw new Error("Invalid companion memory entry id.");
  const proactive = role === "proactive" ? normalizeProactiveMetadata(input.proactive) : undefined;
  const entry: CompanionMemoryEntry = { id, petId: input.petId, role, text, createdAt: now, ...(proactive ? { proactive } : {}) };
  cached = normalizeCompanionMemory({ version: 1, entries: [...cached.entries, entry] }, now);
  return { entry, persisted: persistCompanionMemory(cached) };
}

function readCompanionMemoryFile(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    if (statSync(path).size > maxCompanionMemoryFileBytes) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function persistCompanionMemory(state: CompanionMemorySnapshot): boolean {
  if (!memoryPath) return false;
  const path = memoryPath;
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > maxCompanionMemoryFileBytes) return false;
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    return true;
  } catch {
    try { rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
    return false;
  }
}

function normalizeMemoryText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\0/g, "").trim().slice(0, maxCompanionMemoryTextCharacters)
    : "";
}

function normalizeProactiveMetadata(value: unknown): CompanionProactiveMemoryMetadata | undefined {
  if (!isRecord(value)
    || typeof value.candidateId !== "string"
    || !safeProactiveIdentityPattern.test(value.candidateId)
    || typeof value.dedupeKey !== "string"
    || !safeProactiveIdentityPattern.test(value.dedupeKey)
    || !proactiveSources.has(value.source as CompanionProactiveMemoryMetadata["source"])) return undefined;
  const source = value.source as CompanionProactiveMemoryMetadata["source"];
  if (source === "plugin") {
    if (typeof value.pluginId !== "string" || !safePluginIdPattern.test(value.pluginId)) return undefined;
    return { candidateId: value.candidateId, dedupeKey: value.dedupeKey, source, pluginId: value.pluginId };
  }
  return { candidateId: value.candidateId, dedupeKey: value.dedupeKey, source };
}

function normalizeNow(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : Date.now();
}

function compareEntries(left: CompanionMemoryEntry, right: CompanionMemoryEntry): number {
  return left.createdAt - right.createdAt || compareAscii(left.id, right.id);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameEntries(left: readonly CompanionMemoryEntry[], right: readonly CompanionMemoryEntry[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return other !== undefined
      && entry.id === other.id
      && entry.petId === other.petId
      && entry.role === other.role
      && entry.text === other.text
      && entry.createdAt === other.createdAt
      && sameProactiveMetadata(entry.proactive, other.proactive);
  });
}

function sameProactiveMetadata(left: CompanionProactiveMemoryMetadata | undefined, right: CompanionProactiveMemoryMetadata | undefined): boolean {
  return left === right || (left !== undefined
    && right !== undefined
    && left.candidateId === right.candidateId
    && left.dedupeKey === right.dedupeKey
    && left.source === right.source
    && left.pluginId === right.pluginId);
}

function boundMemoryFileSize(entries: readonly CompanionMemoryEntry[]): CompanionMemorySnapshot {
  let bounded = [...entries];
  while (bounded.length > 0) {
    const serialized = `${JSON.stringify({ version: 1, entries: bounded }, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") <= maxCompanionMemoryFileBytes) break;
    bounded = bounded.slice(1);
  }
  return { version: 1, entries: bounded };
}

function snapshot(): CompanionMemorySnapshot {
  return { version: 1, entries: [...cached.entries] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
