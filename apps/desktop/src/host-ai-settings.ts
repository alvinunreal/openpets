import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type HostAiProviderKind = "none" | "anthropic" | "openai" | "ollama";

export type HostAiSettings = {
  readonly provider: HostAiProviderKind;
  readonly model: string;
  readonly baseUrl?: string;
};

export const defaultHostAiSettings: HostAiSettings = {
  provider: "none",
  model: "",
};

export const defaultHostAiModels: Readonly<Record<Exclude<HostAiProviderKind, "none">, string>> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  ollama: "llama3.2",
};

export type InitializeHostAiSettingsOptions = {
  readonly legacyAi?: unknown;
  readonly migrateLegacyIfConfigured?: boolean;
};

const settingsFileName = "openpets-host-ai-settings.json";
let settingsPath: string | null = null;
let cached: HostAiSettings = defaultHostAiSettings;

export function initializeHostAiSettings(userDataPath: string, options: InitializeHostAiSettingsOptions = {}): HostAiSettings {
  settingsPath = join(userDataPath, settingsFileName);
  const persisted = readSettingsFile(settingsPath);
  if (persisted.valid) {
    cached = persisted.settings;
    return cached;
  }

  const legacy = normalizeHostAiSettings(options.legacyAi);
  if (options.migrateLegacyIfConfigured === true && legacy.provider !== "none") {
    cached = legacy;
    writeSettingsFile(settingsPath, cached);
    return cached;
  }

  cached = defaultHostAiSettings;
  return cached;
}

export function getHostAiSettings(): HostAiSettings {
  return cached;
}

export function updateHostAiSettings(patch: Partial<HostAiSettings>): HostAiSettings {
  cached = normalizeHostAiSettings({ ...cached, ...patch });
  if (settingsPath) writeSettingsFile(settingsPath, cached);
  return cached;
}

export function normalizeHostAiSettings(value: unknown): HostAiSettings {
  const raw = isRecord(value) ? value : {};
  const provider = isProvider(raw.provider) ? raw.provider : "none";
  if (provider === "none") return defaultHostAiSettings;

  const model = typeof raw.model === "string" ? raw.model.trim().slice(0, 120) : "";
  const trimmedBaseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim().slice(0, 300) : "";
  const baseUrl = /^https?:\/\//.test(trimmedBaseUrl) ? trimmedBaseUrl : undefined;
  return { provider, model, ...(baseUrl === undefined ? {} : { baseUrl }) };
}

function isProvider(value: unknown): value is HostAiProviderKind {
  return value === "none" || value === "anthropic" || value === "openai" || value === "ollama";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettingsFile(path: string): { readonly valid: boolean; readonly settings: HostAiSettings } {
  try {
    if (!existsSync(path)) return { valid: false, settings: defaultHostAiSettings };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed) || !isProvider(parsed.provider)) return { valid: false, settings: defaultHostAiSettings };
    return { valid: true, settings: normalizeHostAiSettings(parsed) };
  } catch {
    return { valid: false, settings: defaultHostAiSettings };
  }
}

function writeSettingsFile(path: string, settings: HostAiSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}
