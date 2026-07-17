import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  defaultHostAiSettings,
  getHostAiSettings,
  initializeHostAiSettings,
  updateHostAiSettings,
  type HostAiProviderKind,
  type HostAiSettings,
} from "./host-ai-settings.js";

/**
 * Host-level plugin platform settings (§15 sensitive toggles, §2 quiet hours,
 * §13.2 AI provider). Quiet hours are a host primitive: speech, audio, voice,
 * and notification sound all read the same window. Sensitive capabilities
 * (AI-generated speech, microphone) default OFF.
 */

export type PluginAiProviderKind = HostAiProviderKind;

type PluginPlatformCoreSettings = {
  readonly allowPluginAudio: boolean;
  readonly allowDynamicSpeech: boolean;
  readonly allowPluginVoice: boolean;
  readonly allowMicrophone: boolean;
  readonly quietHours: { readonly enabled: boolean; readonly start: string; readonly end: string };
};

export type PluginPlatformSettings = PluginPlatformCoreSettings & {
  readonly ai: HostAiSettings;
};

const defaultPluginPlatformCoreSettings: PluginPlatformCoreSettings = {
  allowPluginAudio: true,
  allowDynamicSpeech: false,
  allowPluginVoice: true,
  allowMicrophone: false,
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
};

export const defaultPluginPlatformSettings: PluginPlatformSettings = {
  ...defaultPluginPlatformCoreSettings,
  ai: defaultHostAiSettings,
};

const settingsFileName = "openpets-plugin-platform.json";
let settingsPath: string | null = null;
let cachedCore: PluginPlatformCoreSettings = defaultPluginPlatformCoreSettings;

export function initializePluginPlatformSettings(userDataPath: string): PluginPlatformSettings {
  settingsPath = join(userDataPath, settingsFileName);
  const raw = readSettingsFile(settingsPath);
  cachedCore = normalizeCoreSettings(raw);
  initializeHostAiSettings(userDataPath, {
    legacyAi: raw.ai,
    migrateLegacyIfConfigured: true,
  });

  // The legacy field is removed once observed. Reads and future writes project
  // host settings through the old public shape without keeping two sources.
  if (Object.prototype.hasOwnProperty.call(raw, "ai")) writeSettingsFile(settingsPath, cachedCore);
  return getPluginPlatformSettings();
}

export function getPluginPlatformSettings(): PluginPlatformSettings {
  return { ...cachedCore, quietHours: { ...cachedCore.quietHours }, ai: getHostAiSettings() };
}

export function updatePluginPlatformSettings(patch: Partial<PluginPlatformSettings>): PluginPlatformSettings {
  cachedCore = normalizeCoreSettings({
    ...cachedCore,
    ...patch,
    quietHours: { ...cachedCore.quietHours, ...(patch.quietHours ?? {}) },
  });
  if (patch.ai) updateHostAiSettings(patch.ai);
  if (settingsPath) writeSettingsFile(settingsPath, cachedCore);
  return getPluginPlatformSettings();
}

/** Whether the quiet-hours window is currently active. */
export function isInQuietHours(now = new Date()): boolean {
  const { enabled, start, end } = cachedCore.quietHours;
  if (!enabled) return false;
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const startMinutes = parseTimeMinutes(start);
  const endMinutes = parseTimeMinutes(end);
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return minutesNow >= startMinutes && minutesNow < endMinutes;
  // Crosses midnight (e.g. 22:00 -> 08:00).
  return minutesNow >= startMinutes || minutesNow < endMinutes;
}

function parseTimeMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return 0;
  return Math.min(23, Number(match[1])) * 60 + Math.min(59, Number(match[2]));
}

function normalizeCoreSettings(value: unknown): PluginPlatformCoreSettings {
  const raw = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const quiet = typeof raw.quietHours === "object" && raw.quietHours !== null ? raw.quietHours as Record<string, unknown> : {};
  const isTime = (entry: unknown): entry is string => typeof entry === "string" && /^\d{2}:\d{2}$/.test(entry);
  return {
    allowPluginAudio: raw.allowPluginAudio !== false,
    allowDynamicSpeech: raw.allowDynamicSpeech === true,
    allowPluginVoice: raw.allowPluginVoice !== false,
    allowMicrophone: raw.allowMicrophone === true,
    quietHours: {
      enabled: quiet.enabled === true,
      start: isTime(quiet.start) ? quiet.start : "22:00",
      end: isTime(quiet.end) ? quiet.end : "08:00",
    },
  };
}

function readSettingsFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function writeSettingsFile(path: string, settings: PluginPlatformCoreSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}
