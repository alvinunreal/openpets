import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Host-level plugin platform settings (§15 sensitive toggles, §2 quiet hours,
 * §13.2 AI provider). Quiet hours are a host primitive: speech, audio, voice,
 * and notification sound all read the same window. Sensitive capabilities
 * (AI-generated speech, microphone) default OFF.
 */

export type PluginAiProviderKind = "none" | "anthropic" | "openai" | "ollama" | "minimax";

export type PluginPlatformSettings = {
  readonly allowPluginAudio: boolean;
  readonly allowDynamicSpeech: boolean;
  readonly allowPluginVoice: boolean;
  readonly allowMicrophone: boolean;
  readonly quietHours: { readonly enabled: boolean; readonly start: string; readonly end: string };
  readonly ai: { readonly provider: PluginAiProviderKind; readonly model: string; readonly baseUrl?: string };
};

export const defaultPluginPlatformSettings: PluginPlatformSettings = {
  allowPluginAudio: true,
  allowDynamicSpeech: false,
  allowPluginVoice: true,
  allowMicrophone: false,
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  ai: { provider: "none", model: "" },
};

const settingsFileName = "openpets-plugin-platform.json";
let settingsPath: string | null = null;
let cached: PluginPlatformSettings = defaultPluginPlatformSettings;

export function initializePluginPlatformSettings(userDataPath: string): PluginPlatformSettings {
  settingsPath = join(userDataPath, settingsFileName);
  cached = readSettingsFile(settingsPath);
  return cached;
}

export function getPluginPlatformSettings(): PluginPlatformSettings {
  return cached;
}

export function updatePluginPlatformSettings(patch: Partial<PluginPlatformSettings>): PluginPlatformSettings {
  cached = normalizeSettings({ ...cached, ...patch, quietHours: { ...cached.quietHours, ...(patch.quietHours ?? {}) }, ai: { ...cached.ai, ...(patch.ai ?? {}) } });
  if (settingsPath) writeSettingsFile(settingsPath, cached);
  return cached;
}

/** Whether the quiet-hours window is currently active. */
export function isInQuietHours(now = new Date()): boolean {
  const { enabled, start, end } = cached.quietHours;
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

function normalizeSettings(value: unknown): PluginPlatformSettings {
  const raw = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const quiet = typeof raw.quietHours === "object" && raw.quietHours !== null ? raw.quietHours as Record<string, unknown> : {};
  const ai = typeof raw.ai === "object" && raw.ai !== null ? raw.ai as Record<string, unknown> : {};
  const isTime = (entry: unknown): entry is string => typeof entry === "string" && /^\d{2}:\d{2}$/.test(entry);
  const provider = ["none", "anthropic", "openai", "ollama", "minimax"].includes(String(ai.provider)) ? String(ai.provider) as PluginAiProviderKind : "none";
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
    ai: {
      provider,
      model: typeof ai.model === "string" ? ai.model.slice(0, 120) : "",
      baseUrl: typeof ai.baseUrl === "string" && /^https?:\/\//.test(ai.baseUrl) ? ai.baseUrl.slice(0, 300) : undefined,
    },
  };
}

function readSettingsFile(path: string): PluginPlatformSettings {
  try {
    if (!existsSync(path)) return defaultPluginPlatformSettings;
    return normalizeSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return defaultPluginPlatformSettings;
  }
}

function writeSettingsFile(path: string, settings: PluginPlatformSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}
