import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { app } from "electron";

import { defaultPetScale, defaultWaitingAnimationDurationMs, markOnboardingCompleted, normalizeOnboardingCompleted, normalizePetConfinementEnabled, normalizePetCrossDisplayEnabled, normalizePetGravityEnabled, normalizePetScale, normalizeWaitingAnimationDurationMs, petScaleOptions, waitingAnimationDurationOptions, type PetScaleValue, type WaitingAnimationDurationMs } from "./app-state-core.js";
import { builtInPet } from "./built-in-pet.js";
import type { Point } from "./display.js";
import { isSupportedLocale, type LocalePreference } from "./i18n/catalog.js";
import { allowedReactions, type OpenPetsReaction } from "./local-ipc-protocol.js";
import { assertSafePetId, getInstalledPetDir } from "./pet-paths.js";
import { normalizePetPoolOrder } from "./pet-pool.js";
import { publishPluginAgentActivity } from "./plugin-events-source.js";
import { normalizeReactionAnimationOverrides, type ReactionAnimationOverrides } from "./reaction-animation-mapping.js";

export { normalizePetPoolOrder } from "./pet-pool.js";

export interface InstalledPetState {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly builtIn: boolean;
  readonly protected: boolean;
  readonly installed: boolean;
  readonly source?: {
    readonly kind?: "catalog";
    readonly catalogVersion: 2;
    readonly zip: string;
    readonly preview: string;
  } | {
    readonly kind: "codex";
    readonly path: string;
  };
  readonly broken?: boolean;
  readonly brokenReason?: string;
}

export interface OpenPetsStateV1 {
  readonly version: 1;
  readonly preferences: {
    readonly defaultPetId: string;
    readonly openDefaultPetOnLaunch: boolean;
    readonly locale: LocalePreference;
    readonly speechBubblesEnabled: boolean;
    readonly petScale: number;
    readonly waitingAnimationDurationMs: WaitingAnimationDurationMs;
    readonly reactionAnimationOverrides?: ReactionAnimationOverrides;
    readonly onboardingCompleted: boolean;
    readonly claudeCommandPath?: string;
    readonly nodeCommandPath?: string;
    readonly opencodeCommandPath?: string;
    /** Ordered pool of pet IDs for sequential session assignment. Slot 0 is the primary pet.
     * When set (non-empty), no-pet sessions claim the next available slot before falling back to random.
     * Undefined / empty = legacy shared-default behaviour unchanged. */
    readonly petPoolOrder?: readonly string[];
    /** Master toggle for the ordered pet-pool assignment feature. When false,
     * the pool is ignored entirely and no-pet sessions use the legacy shared default pet,
     * even if petPoolOrder is configured. Defaults to true. Platform-independent
     * (works on macOS/Windows/Linux). */
    readonly petPoolEnabled: boolean;
    /** Global toggle for window-confinement. When true (default), session-bound pets are
     * confined to their terminal window. When false, all pets free-roam regardless of
     * whether a terminal window is tracked. Platform-independent. */
    readonly petConfinementEnabled: boolean;
    /** Global toggle for cross-display roaming. When true, pets may move
     * freely across all displays. When false, pets are confined to a single display.
     * Defaults to false.
     * Platform-independent kill-switch for the cross-display feature. */
    readonly petCrossDisplayEnabled: boolean;
    /** Host-level gravity toggle. When true, pets fall with physics on every registered
     * pet (default + agent). When false (default), no gravity is applied — the
     * Walkabout plugin's per-session physics path governs gravity instead. */
    readonly petGravityEnabled: boolean;
  };
  readonly pets: {
    readonly installed: readonly InstalledPetState[];
  };
  readonly defaultPet: {
    readonly position?: Point;
    /**
     * Per-monitor position map. Keys are stable display identifiers derived from
     * bounds: `"${bounds.x},${bounds.y},${bounds.width}x${bounds.height}"`.
     * Capped at 8 entries (LRU eviction) so the state file does not grow unboundedly.
     */
    readonly perMonitorPositions?: Readonly<Record<string, Point>>;
  };
  readonly activity: OpenPetsActivityState;
}

/** Local dashboard activity counters (not remote telemetry). */
export interface OpenPetsActivityState {
  readonly messagesSent: number;
  readonly reactionsSent: number;
  readonly reactionCounts: Record<OpenPetsReaction, number>;
  readonly perPetActivityCounts: Record<string, number>;
  readonly lastActivityAt?: number;
}

export type OpenPetsActivityRecord =
  | { readonly kind: "say"; readonly reaction?: OpenPetsReaction; readonly petId?: string; readonly surface?: "default" | "agent" }
  | { readonly kind: "react"; readonly reaction: OpenPetsReaction; readonly petId?: string; readonly surface?: "default" | "agent" };

export { defaultPetScale, defaultWaitingAnimationDurationMs, normalizePetScale, normalizeWaitingAnimationDurationMs, petScaleOptions, waitingAnimationDurationOptions, type PetScaleValue, type WaitingAnimationDurationMs };

const stateFileName = "openpets-state.json";
const directInstallLockName = ".install-pet.lock";
const directInstallLockStaleMs = 10 * 60 * 1000;
let statePath: string | null = null;
let currentState: OpenPetsStateV1 | null = null;
let startupInstallLockPath: string | null = null;

export function initializeAppState(): void {
  const userDataPath = app.getPath("userData");
  startupInstallLockPath = acquireStartupInstallLock(userDataPath);

  statePath = join(userDataPath, stateFileName);
  const nextState = normalizeState(readStateFile(statePath));
  writeStateToDisk(nextState);
  currentState = nextState;
  console.log(`OpenPets state initialized at ${statePath}.`);
}

export function releaseStartupInstallLock(): void {
  const lockPath = startupInstallLockPath;
  startupInstallLockPath = null;
  if (lockPath) rmSync(lockPath, { recursive: true, force: true });
}

export function getAppStateSnapshot(): OpenPetsStateV1 {
  return cloneState(getInitializedState());
}

export function updatePreferences(patch: Partial<OpenPetsStateV1["preferences"]>): OpenPetsStateV1 {
  const state = getInitializedState();
  const preferences = normalizePreferences({ ...state.preferences, ...patch });

  const nextState = normalizeState({
    ...state,
    preferences,
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

export function isOnboardingCompleted(): boolean {
  return getInitializedState().preferences.onboardingCompleted;
}

export function completeOnboarding(): OpenPetsStateV1 {
  const state = getInitializedState();
  const nextState = normalizeState(markOnboardingCompleted(state));
  commitState(nextState);
  return getAppStateSnapshot();
}

export function setDefaultPet(defaultPetId: string): OpenPetsStateV1 {
  const state = getInitializedState();
  const targetPet = state.pets.installed.find((pet) => pet.id === defaultPetId);

  if (!targetPet) {
    throw new Error(`Cannot set unknown pet as default: ${defaultPetId}`);
  }

  if (targetPet.broken) {
    throw new Error(`Cannot set broken pet as default: ${defaultPetId}`);
  }

  const nextState = normalizeState({
    ...state,
    preferences: {
      ...state.preferences,
      defaultPetId,
    },
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

/**
 * Replace the entire pet-pool order with a new list.
 * Duplicate / unsafe IDs are removed during normalisation.
 * Pass an empty array (or undefined) to clear the pool and revert to legacy behaviour.
 */
export function setPetPoolOrder(ids: readonly string[]): OpenPetsStateV1 {
  const nextState = normalizeState({
    ...getInitializedState(),
    preferences: {
      ...getInitializedState().preferences,
      petPoolOrder: normalizePetPoolOrder(ids),
    },
  });
  commitState(nextState);
  return getAppStateSnapshot();
}

export function setDefaultPetPosition(position: Point): OpenPetsStateV1 {
  const state = getInitializedState();

  const nextState = normalizeState({
    ...state,
    defaultPet: {
      ...state.defaultPet,
      position: normalizePosition(position),
    },
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

export function resetDefaultPetPosition(position: Point): OpenPetsStateV1 {
  const state = getInitializedState();

  const nextState = normalizeState({
    ...state,
    defaultPet: {
      ...state.defaultPet,
      position: normalizePosition(position),
      perMonitorPositions: undefined,
    },
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

export function getDefaultPetPosition(): Point | undefined {
  return getInitializedState().defaultPet.position;
}

/**
 * Record the pet's current position for a specific display key.
 * Keys are derived from display bounds: `"${bounds.x},${bounds.y},${bounds.width}x${bounds.height}"`.
 * Also updates the flat `defaultPet.position` for backwards compatibility.
 * The map is capped at maxPerMonitorPositions entries (oldest evicted).
 */
export function setPerMonitorPetPosition(displayKey: string, position: Point): OpenPetsStateV1 {
  const state = getInitializedState();
  const pos = normalizePosition(position);
  if (!pos) return getAppStateSnapshot();

  const existing = state.defaultPet.perMonitorPositions ?? {};
  const entries = Object.entries(existing).filter(([k]) => k !== displayKey);
  entries.push([displayKey, pos]);
  // Keep only the most recent maxPerMonitorPositions entries.
  const trimmed = entries.slice(-maxPerMonitorPositions);
  const perMonitorPositions: Record<string, Point> = Object.fromEntries(trimmed);

  const nextState = normalizeState({
    ...state,
    defaultPet: {
      ...state.defaultPet,
      position: normalizePosition(position),
      perMonitorPositions,
    },
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

/**
 * Look up the stored position for a display key.
 * Returns undefined if no position has been recorded for this display.
 */
export function getPerMonitorPetPosition(displayKey: string): Point | undefined {
  return getInitializedState().defaultPet.perMonitorPositions?.[displayKey];
}

export function getPetGravityEnabled(): boolean {
  return getInitializedState().preferences.petGravityEnabled;
}

export function setPetGravityEnabled(value: boolean): OpenPetsStateV1 {
  return updatePreferences({ petGravityEnabled: value });
}

export function recordOpenPetsActivity(activity: OpenPetsActivityRecord, now: number = Date.now()): OpenPetsStateV1 {
  publishPluginAgentActivity({ kind: activity.kind, reaction: activity.reaction, petId: activity.petId, surface: activity.surface });
  const state = getInitializedState();
  const current = state.activity;
  const reaction = activity.kind === "react" ? activity.reaction : activity.reaction;
  const petId = activity.petId;
  const nextState = normalizeState({
    ...state,
    activity: {
      messagesSent: current.messagesSent + (activity.kind === "say" ? 1 : 0),
      reactionsSent: current.reactionsSent + (reaction ? 1 : 0),
      reactionCounts: reaction
        ? { ...current.reactionCounts, [reaction]: (current.reactionCounts[reaction] ?? 0) + 1 }
        : current.reactionCounts,
      perPetActivityCounts: petId
        ? { ...current.perPetActivityCounts, [petId]: (current.perPetActivityCounts[petId] ?? 0) + 1 }
        : current.perPetActivityCounts,
      lastActivityAt: normalizeTimestamp(now) ?? Date.now(),
    },
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

export function installPetState(pet: Omit<InstalledPetState, "builtIn" | "protected" | "installed">): OpenPetsStateV1 {
  const state = getInitializedState();

  if (state.pets.installed.some((installedPet) => installedPet.id === pet.id)) {
    throw new Error(`Pet is already installed: ${pet.id}`);
  }

  const nextState = normalizeState({
    ...state,
    pets: {
      installed: [
        ...state.pets.installed,
        {
          ...pet,
          builtIn: false,
          protected: false,
          installed: true,
        },
      ],
    },
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

export function upsertPetState(pet: Omit<InstalledPetState, "builtIn" | "protected" | "installed">): OpenPetsStateV1 {
  const state = getInitializedState();
  const nextPet: InstalledPetState = {
    ...pet,
    builtIn: false,
    protected: false,
    installed: true,
  };
  const exists = state.pets.installed.some((installedPet) => installedPet.id === pet.id);
  const nextState = normalizeState({
    ...state,
    pets: {
      installed: exists
        ? state.pets.installed.map((installedPet) => installedPet.id === pet.id ? nextPet : installedPet)
        : [...state.pets.installed, nextPet],
    },
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

export function removePetState(petId: string): OpenPetsStateV1 {
  if (petId === builtInPet.id) {
    throw new Error("Built-in pet cannot be removed.");
  }

  const state = getInitializedState();
  const existing = state.pets.installed.find((pet) => pet.id === petId);

  if (!existing) {
    throw new Error(`Pet is not installed: ${petId}`);
  }

  const nextDefaultPetId = state.preferences.defaultPetId === petId ? builtInPet.id : state.preferences.defaultPetId;

  const nextState = normalizeState({
    ...state,
    preferences: {
      ...state.preferences,
      defaultPetId: nextDefaultPetId,
    },
    pets: {
      installed: state.pets.installed.filter((pet) => pet.id !== petId),
    },
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

export function markPetBroken(petId: string, brokenReason: string): OpenPetsStateV1 {
  const state = getInitializedState();

  if (petId === builtInPet.id) {
    return getAppStateSnapshot();
  }

  const nextState = normalizeState({
    ...state,
    preferences: {
      ...state.preferences,
      defaultPetId: state.preferences.defaultPetId === petId ? builtInPet.id : state.preferences.defaultPetId,
    },
    pets: {
      installed: state.pets.installed.map((pet) => pet.id === petId ? { ...pet, broken: true, brokenReason } : pet),
    },
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

export function getStateFilePath(): string {
  if (!statePath) {
    throw new Error("OpenPets app state has not been initialized.");
  }

  return statePath;
}

function getInitializedState(): OpenPetsStateV1 {
  if (!currentState) {
    throw new Error("OpenPets app state has not been initialized.");
  }

  return currentState;
}

function readStateFile(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    console.error(`Failed to read OpenPets state from ${path}; using defaults.`, error);
    return undefined;
  }
}

function normalizeState(value: unknown): OpenPetsStateV1 {
  const record = isRecord(value) ? value : {};
  const defaultPetRecord = isRecord(record.defaultPet) ? record.defaultPet : {};
  const preferencesRecord = isRecord(record.preferences) ? record.preferences : {};
  const defaultState = createDefaultState();
  const position = normalizeMaybePosition(defaultPetRecord.position);
  const perMonitorPositions = normalizePerMonitorPositions(defaultPetRecord.perMonitorPositions);
  const installedPets = normalizeInstalledPets(record);
  const defaultPetId = typeof preferencesRecord.defaultPetId === "string"
    && installedPets.some((pet) => pet.id === preferencesRecord.defaultPetId && !pet.broken)
    ? preferencesRecord.defaultPetId
    : builtInPet.id;

  const defaultPet: OpenPetsStateV1["defaultPet"] = {};
  if (position) (defaultPet as Record<string, unknown>).position = position;
  if (perMonitorPositions && Object.keys(perMonitorPositions).length > 0) {
    (defaultPet as Record<string, unknown>).perMonitorPositions = perMonitorPositions;
  }

  return {
    version: 1,
    preferences: normalizePreferences({
      ...defaultState.preferences,
      ...preferencesRecord,
      defaultPetId,
    }),
    pets: {
      installed: installedPets,
    },
    defaultPet,
    activity: normalizeActivity(record.activity),
  };
}

function normalizeActivity(value: unknown): OpenPetsActivityState {
  const record = isRecord(value) ? value : {};
  return {
    messagesSent: normalizeCount(record.messagesSent),
    reactionsSent: normalizeCount(record.reactionsSent),
    reactionCounts: normalizeReactionCounts(record.reactionCounts),
    perPetActivityCounts: normalizePerPetActivityCounts(record.perPetActivityCounts),
    lastActivityAt: normalizeTimestamp(record.lastActivityAt),
  };
}

function normalizeReactionCounts(value: unknown): Record<OpenPetsReaction, number> {
  const record = isRecord(value) ? value : {};
  const counts = {} as Record<OpenPetsReaction, number>;
  for (const reaction of allowedReactions) {
    counts[reaction] = normalizeCount(record[reaction]);
  }
  return counts;
}

function normalizePerPetActivityCounts(value: unknown): Record<string, number> {
  const record = isRecord(value) ? value : {};
  const counts: Record<string, number> = {};
  for (const [petId, rawCount] of Object.entries(record)) {
    if (petId !== builtInPet.id) {
      try {
        assertSafePetId(petId);
      } catch {
        continue;
      }
    }
    const count = normalizeCount(rawCount);
    if (count > 0) counts[petId] = count;
  }
  return counts;
}

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function normalizePreferences(value: Partial<OpenPetsStateV1["preferences"]>): OpenPetsStateV1["preferences"] {
  const defaultState = createDefaultState();

  return {
    defaultPetId: typeof value.defaultPetId === "string" ? value.defaultPetId : builtInPet.id,
    openDefaultPetOnLaunch: typeof value.openDefaultPetOnLaunch === "boolean"
      ? value.openDefaultPetOnLaunch
      : defaultState.preferences.openDefaultPetOnLaunch,
    locale: normalizeLocalePreference(value.locale),
    speechBubblesEnabled: true,
    petScale: normalizePetScale(value.petScale),
    waitingAnimationDurationMs: normalizeWaitingAnimationDurationMs(value.waitingAnimationDurationMs),
    reactionAnimationOverrides: normalizeReactionAnimationOverrides(value.reactionAnimationOverrides),
    onboardingCompleted: normalizeOnboardingCompleted(value),
    claudeCommandPath: normalizeCommandPath(value.claudeCommandPath),
    nodeCommandPath: normalizeCommandPath(value.nodeCommandPath),
    opencodeCommandPath: normalizeCommandPath(value.opencodeCommandPath),
    petPoolOrder: normalizePetPoolOrder(value.petPoolOrder),
    petPoolEnabled: typeof value.petPoolEnabled === "boolean"
      ? value.petPoolEnabled
      : defaultState.preferences.petPoolEnabled,
    petConfinementEnabled: normalizePetConfinementEnabled(value.petConfinementEnabled, defaultState.preferences.petConfinementEnabled),
    petCrossDisplayEnabled: normalizePetCrossDisplayEnabled(value.petCrossDisplayEnabled, defaultState.preferences.petCrossDisplayEnabled),
    petGravityEnabled: normalizePetGravityEnabled(value.petGravityEnabled, defaultState.preferences.petGravityEnabled),
  };
}

function normalizeLocalePreference(value: unknown): LocalePreference {
  if (value === "system") return "system";
  return isSupportedLocale(value) ? value : "system";
}

function normalizeCommandPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096 || /[\r\n\0]/.test(trimmed) || !isAbsolute(trimmed)) return undefined;
  if (process.platform === "win32" && /[&|<>^%!]/.test(trimmed)) return undefined;
  try {
    if (!statSync(trimmed).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return trimmed;
}

function normalizeInstalledPets(value: Record<string, unknown>): InstalledPetState[] {
  const installed = isRecord(value.pets) && Array.isArray(value.pets.installed)
    ? value.pets.installed
    : [];

  const normalized = installed
    .map((pet) => normalizeInstalledPet(pet))
    .filter((pet): pet is InstalledPetState => Boolean(pet && pet.id !== builtInPet.id));

  return [builtInPet, ...normalized];
}

function normalizeInstalledPet(value: unknown): InstalledPetState | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.displayName !== "string") {
    return null;
  }

  try {
    assertSafePetId(value.id);
  } catch {
    return null;
  }

  const brokenReason = validateInstalledPetFiles(value.id);

  return {
    id: value.id,
    displayName: value.displayName,
    description: typeof value.description === "string" ? value.description : undefined,
    builtIn: value.id === builtInPet.id ? true : value.builtIn === true,
    protected: value.id === builtInPet.id ? true : value.protected === true,
    installed: true,
    source: normalizeSource(value.source),
    broken: brokenReason ? true : typeof value.broken === "boolean" ? value.broken : undefined,
    brokenReason: brokenReason ?? (typeof value.brokenReason === "string" ? value.brokenReason : undefined),
  };
}

function createDefaultState(): OpenPetsStateV1 {
  return {
    version: 1,
    preferences: {
      defaultPetId: builtInPet.id,
      openDefaultPetOnLaunch: true,
      locale: "system",
      speechBubblesEnabled: true,
      petScale: defaultPetScale,
      waitingAnimationDurationMs: defaultWaitingAnimationDurationMs,
      reactionAnimationOverrides: undefined,
      onboardingCompleted: false,
      claudeCommandPath: undefined,
      nodeCommandPath: undefined,
      opencodeCommandPath: undefined,
      petPoolOrder: undefined,
      petPoolEnabled: true,
      petConfinementEnabled: true,
      petCrossDisplayEnabled: false,
      petGravityEnabled: false,
    },
    pets: {
      installed: [builtInPet],
    },
    defaultPet: {},
    activity: {
      messagesSent: 0,
      reactionsSent: 0,
      reactionCounts: normalizeReactionCounts(undefined),
      perPetActivityCounts: {},
      lastActivityAt: undefined,
    },
  };
}

function commitState(nextState: OpenPetsStateV1): void {
  writeStateToDisk(nextState);
  currentState = nextState;
}

function writeStateToDisk(state: OpenPetsStateV1): void {
  const path = getStateFilePath();

  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

function validateInstalledPetFiles(petId: string): string | undefined {
  try {
    const dir = getInstalledPetDir(petId);
    const petJsonPath = join(dir, "pet.json");
    const spritesheetPath = join(dir, "spritesheet.webp");
    JSON.parse(readFileSync(petJsonPath, "utf8")) as unknown;
    const spritesheet = statSync(spritesheetPath);
    if (!spritesheet.isFile()) return "spritesheet.webp is not a file.";
    if (spritesheet.size <= 0) return "spritesheet.webp is empty.";
    if (spritesheet.size > 100 * 1024 * 1024) return "spritesheet.webp is too large.";
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Installed pet files are invalid.";
  }
}

function normalizeSource(value: unknown): InstalledPetState["source"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.kind === "codex" && typeof value.path === "string") {
    return { kind: "codex", path: value.path };
  }

  if (value.catalogVersion !== 2 || typeof value.zip !== "string" || typeof value.preview !== "string") return undefined;

  return {
    kind: "catalog",
    catalogVersion: 2,
    zip: value.zip,
    preview: value.preview,
  };
}

const maxPerMonitorPositions = 8;

function normalizePerMonitorPositions(value: unknown): Readonly<Record<string, Point>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;
  const normalized: Record<string, Point> = {};
  // Accept up to maxPerMonitorPositions entries; extras are silently dropped on normalise.
  for (const [key, rawPos] of entries.slice(-maxPerMonitorPositions)) {
    if (typeof key !== "string" || !isDisplayKey(key)) continue;
    const pos = normalizeMaybePosition(rawPos);
    if (pos) normalized[key] = pos;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function isDisplayKey(key: string): boolean {
  // Expected format: "<x>,<y>,<width>x<height>" where all values are integers (may be negative).
  return /^-?\d+,-?\d+,\d+x\d+$/.test(key);
}

function normalizeMaybePosition(value: unknown): Point | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return normalizePosition(value);
}

function normalizePosition(value: Partial<Point>): Point | undefined {
  if (typeof value.x !== "number" || typeof value.y !== "number") {
    return undefined;
  }

  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    return undefined;
  }

  return {
    x: Math.round(value.x),
    y: Math.round(value.y),
  };
}

function cloneState(state: OpenPetsStateV1): OpenPetsStateV1 {
  return structuredClone(state) as OpenPetsStateV1;
}

function acquireStartupInstallLock(userDataPath: string): string {
  mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  const lockPath = join(userDataPath, directInstallLockName);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), command: "openpets-startup" })}\n`, "utf8");
      return lockPath;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
      if (isStaleInstallLock(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      throw new Error("OpenPets cannot start while a direct pet install is in progress. Wait for install-pet to finish, then reopen OpenPets.");
    }
  }
  throw new Error("Could not acquire OpenPets startup lock.");
}

function isStaleInstallLock(lockPath: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { readonly pid?: unknown; readonly createdAt?: unknown };
    if (typeof owner.createdAt === "number" && Date.now() - owner.createdAt > directInstallLockStaleMs) return true;
    if (typeof owner.pid === "number" && owner.pid > 0) return !isProcessAlive(owner.pid);
  } catch {
    // Fall back to mtime for old/partial locks.
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs > directInstallLockStaleMs;
  } catch {
    return true;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return code === "EPERM";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
