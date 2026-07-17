import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { companionFrequencies, companionTargetIds, type CompanionFrequency, type CompanionTargetId } from "./companion-types.js";

export type CompanionProfile = {
  readonly name: string;
  readonly preferredAddress: string;
  readonly goals: readonly string[];
};

export type CompanionPetSettings = {
  readonly personality: string;
};

export type CompanionSettings = {
  readonly version: 1;
  /** Version 0 has not accepted the Companion disclosure and therefore cannot be enabled. */
  readonly consentVersion: 0 | 1;
  readonly enabled: boolean;
  readonly target: CompanionTargetId;
  readonly profile: CompanionProfile;
  readonly pets: Readonly<Record<string, CompanionPetSettings>>;
  readonly memory: { readonly enabled: boolean };
  readonly proactivity: { readonly enabled: boolean; readonly frequency: CompanionFrequency };
  readonly context: {
    readonly pluginEnabled: boolean;
    readonly sensitivePluginEnabled: boolean;
    readonly screenEnabled: boolean;
  };
  readonly wake: { readonly enabled: boolean };
};

export type CompanionSettingsPatch = {
  readonly target?: CompanionTargetId;
  readonly profile?: Partial<CompanionProfile>;
  readonly memory?: { readonly enabled?: boolean };
  readonly proactivity?: { readonly enabled?: boolean; readonly frequency?: CompanionFrequency };
  readonly context?: {
    readonly pluginEnabled?: boolean;
    readonly sensitivePluginEnabled?: boolean;
    readonly screenEnabled?: boolean;
  };
  readonly wake?: { readonly enabled?: boolean };
};

export const maxCompanionGoals = 5;
export const maxCompanionGoalCharacters = 240;
export const maxCompanionPersonalityCharacters = 800;
export const maxCompanionPetSettings = 200;

export const defaultCompanionSettings: CompanionSettings = {
  version: 1,
  consentVersion: 0,
  enabled: false,
  target: "codex",
  profile: { name: "", preferredAddress: "", goals: [] },
  pets: {},
  memory: { enabled: false },
  proactivity: { enabled: false, frequency: "sometimes" },
  context: { pluginEnabled: false, sensitivePluginEnabled: false, screenEnabled: false },
  wake: { enabled: false },
};

export const companionSettingsFileName = "openpets-companion-settings.json";

let settingsPath: string | null = null;
let cached: CompanionSettings = defaultCompanionSettings;
const listeners = new Set<(settings: CompanionSettings) => void>();

export function initializeCompanionSettings(userDataPath: string): CompanionSettings {
  settingsPath = join(userDataPath, companionSettingsFileName);
  cached = readCompanionSettingsFile(settingsPath);
  return cached;
}

export function getCompanionSettings(): CompanionSettings {
  return cached;
}

export function getCompanionSettingsFilePath(): string {
  if (!settingsPath) throw new Error("Companion settings have not been initialized.");
  return settingsPath;
}

/**
 * Accept the disclosure and turn Companion on. The first call commits all
 * disclosed defaults as one atomic file replacement; later re-enables preserve
 * the user's independently reversible choices.
 */
export function enableCompanion(): CompanionSettings {
  const next = cached.consentVersion === 0
    ? normalizeCompanionSettings({
      ...cached,
      consentVersion: 1,
      enabled: true,
      memory: { enabled: true },
      proactivity: { enabled: true, frequency: "sometimes" },
      context: { pluginEnabled: false, sensitivePluginEnabled: false, screenEnabled: false },
      wake: { enabled: false },
    })
    : normalizeCompanionSettings({ ...cached, enabled: true });
  return commitSettings(next);
}

export function disableCompanion(): CompanionSettings {
  return commitSettings(normalizeCompanionSettings({ ...cached, enabled: false }));
}

/** Update allow-listed preferences without granting disclosure consent. */
export function updateCompanionSettings(patch: unknown): CompanionSettings {
  if (!isRecord(patch)) throw new Error("Invalid companion settings patch.");
  const next: Record<string, unknown> = { ...cached };
  if ("target" in patch) next.target = patch.target;
  if (isRecord(patch.profile)) next.profile = { ...cached.profile, ...patch.profile };
  if (isRecord(patch.memory)) next.memory = { ...cached.memory, ...patch.memory };
  if (isRecord(patch.proactivity)) next.proactivity = { ...cached.proactivity, ...patch.proactivity };
  if (isRecord(patch.context)) next.context = { ...cached.context, ...patch.context };
  if (isRecord(patch.wake)) next.wake = { ...cached.wake, ...patch.wake };
  return commitSettings(normalizeCompanionSettings(next));
}

export function updateCompanionPetSettings(petId: string, patch: unknown): CompanionSettings {
  assertSafeCompanionPetId(petId);
  if (!isRecord(patch)) throw new Error("Invalid companion pet settings patch.");
  const previous = cached.pets[petId] ?? { personality: "" };
  const personality = normalizeText("personality" in patch ? patch.personality : previous.personality, maxCompanionPersonalityCharacters);
  const pets = { ...cached.pets };
  if (personality) pets[petId] = { personality };
  else delete pets[petId];
  return commitSettings(normalizeCompanionSettings({ ...cached, pets }));
}

export function removeCompanionPetSettings(petId: string): CompanionSettings {
  assertSafeCompanionPetId(petId);
  if (!cached.pets[petId]) return cached;
  const pets = { ...cached.pets };
  delete pets[petId];
  return commitSettings(normalizeCompanionSettings({ ...cached, pets }));
}

export function onCompanionSettingsChanged(listener: (settings: CompanionSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function normalizeCompanionSettings(value: unknown): CompanionSettings {
  const raw = isRecord(value) ? value : {};
  const profile = isRecord(raw.profile) ? raw.profile : {};
  const memory = isRecord(raw.memory) ? raw.memory : {};
  const proactivity = isRecord(raw.proactivity) ? raw.proactivity : {};
  const context = isRecord(raw.context) ? raw.context : {};
  const wake = isRecord(raw.wake) ? raw.wake : {};
  const consentVersion = raw.consentVersion === 1 ? 1 : 0;

  return {
    version: 1,
    consentVersion,
    enabled: consentVersion === 1 && raw.enabled === true,
    target: companionTargetIds.includes(raw.target as CompanionTargetId) ? raw.target as CompanionTargetId : "codex",
    profile: {
      name: normalizeText(profile.name, 120),
      preferredAddress: normalizeText(profile.preferredAddress, 120),
      goals: normalizeGoals(profile.goals),
    },
    pets: normalizePetSettings(raw.pets),
    memory: { enabled: memory.enabled === true },
    proactivity: {
      enabled: proactivity.enabled === true,
      frequency: companionFrequencies.includes(proactivity.frequency as CompanionFrequency)
        ? proactivity.frequency as CompanionFrequency
        : "sometimes",
    },
    context: {
      pluginEnabled: context.pluginEnabled === true,
      sensitivePluginEnabled: context.sensitivePluginEnabled === true,
      // Screen awareness has no packaged capability yet. Never retain advance
      // consent that could silently activate when a future plugin ships.
      screenEnabled: false,
    },
    wake: { enabled: wake.enabled === true },
  };
}

export function assertSafeCompanionPetId(petId: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(petId)) throw new Error(`Invalid companion pet id: ${petId}`);
}

function normalizePetSettings(value: unknown): Readonly<Record<string, CompanionPetSettings>> {
  if (!isRecord(value)) return {};
  const pets: Record<string, CompanionPetSettings> = {};
  for (const [petId, entry] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(petId) || !isRecord(entry)) continue;
    const personality = normalizeText(entry.personality, maxCompanionPersonalityCharacters);
    if (personality) pets[petId] = { personality };
    if (Object.keys(pets).length >= maxCompanionPetSettings) break;
  }
  return pets;
}

function normalizeGoals(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const goals: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const goal = normalizeText(entry, maxCompanionGoalCharacters);
    const key = goal.toLowerCase();
    if (!goal || seen.has(key)) continue;
    seen.add(key);
    goals.push(goal);
    if (goals.length >= maxCompanionGoals) break;
  }
  return goals;
}

function normalizeText(value: unknown, maxCharacters: number): string {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, maxCharacters) : "";
}

function readCompanionSettingsFile(path: string): CompanionSettings {
  try {
    if (!existsSync(path)) return normalizeCompanionSettings(undefined);
    return normalizeCompanionSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return normalizeCompanionSettings(undefined);
  }
}

function commitSettings(next: CompanionSettings): CompanionSettings {
  if (settingsPath) writeCompanionSettingsFile(settingsPath, next);
  cached = next;
  for (const listener of listeners) {
    try { listener(cached); } catch { /* listeners are isolated */ }
  }
  return cached;
}

function writeCompanionSettingsFile(path: string, settings: CompanionSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
