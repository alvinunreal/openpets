import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Host gates and provider-profile selections. Secret values never belong here. */

/** Text, speech-to-text, and text-to-speech are the three selectable roles. */
export type ProviderRole = "text" | "stt" | "tts";
export type ProviderAdapter =
  | "openai-compatible-text"
  | "openai-realtime"
  | "anthropic-text"
  | "openai-compatible-transcription"
  | "system-tts"
  | "minimax-tts"
  | "elevenlabs-tts"
  | "openai-compatible-speech";

export type ProviderHeader = { readonly name: string; readonly value: string };
export type ProviderAuth = { readonly headerName: string; readonly strategy: "bearer" | "raw" };
export type ProviderProfile = {
  readonly id: string;
  readonly label: string;
  readonly adapter: ProviderAdapter;
  readonly model: string;
  readonly baseUrl?: string;
  /** Opaque key into PluginSecretsStore. It is not a secret value. */
  readonly secretRef?: string;
  /** Credential placement for providers that do not use Bearer auth. */
  readonly auth?: ProviderAuth;
  readonly headers?: readonly ProviderHeader[];
};

export type ProviderSelections = { readonly text: string | null; readonly stt: string | null; readonly tts: string | null };
export type PluginPlatformSettings = {
  readonly allowPluginAudio: boolean;
  readonly allowDynamicSpeech: boolean;
  readonly allowPluginVoice: boolean;
  readonly allowMicrophone: boolean;
  readonly quietHours: { readonly enabled: boolean; readonly start: string; readonly end: string };
  readonly profiles: Readonly<Record<string, ProviderProfile>>;
  readonly selections: ProviderSelections;
};

export type ProviderProfileInput = Omit<ProviderProfile, "id"> & { readonly id: string };
export type ProviderProfilePatch = Partial<Omit<ProviderProfile, "id" | "baseUrl" | "secretRef" | "auth">> & {
  readonly id?: string;
  /** null explicitly clears the optional endpoint field; omission preserves it. */
  readonly baseUrl?: string | null;
  /** null explicitly clears the opaque credential reference; omission preserves it. */
  readonly secretRef?: string | null;
  /** null explicitly clears custom credential placement; omission preserves it. */
  readonly auth?: ProviderAuth | null;
};
export type ProviderGatesPatch = Partial<Pick<PluginPlatformSettings, "allowPluginAudio" | "allowDynamicSpeech" | "allowPluginVoice" | "allowMicrophone">> & { readonly quietHours?: Partial<PluginPlatformSettings["quietHours"]> };
export type ProviderStatusState = "ready" | "disabled" | "invalid" | "missing-secret" | "unsupported";
export type ProviderStatus = {
  readonly role: ProviderRole | "realtime";
  readonly state: ProviderStatusState;
  readonly code: string;
  readonly message: string;
  readonly profileId?: string;
};
export type ProviderProfileSummary = Omit<ProviderProfile, "headers"> & { readonly headerNames: readonly string[]; readonly hasCredential: boolean };
export type ProviderPresetCredentialMode = "required" | "none";
export type ProviderControlCenterSnapshot = {
  readonly gates: Pick<PluginPlatformSettings, "allowPluginAudio" | "allowDynamicSpeech" | "allowPluginVoice" | "allowMicrophone" | "quietHours">;
  readonly profiles: readonly ProviderProfileSummary[];
  readonly selections: ProviderSelections;
  readonly statuses: Readonly<Record<ProviderRole | "realtime", ProviderStatus>>;
  readonly presets: typeof providerPresets;
};

export const PROVIDER_PROFILE_ID = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;
export const PROVIDER_MAX_HEADERS = 16;
export const PROVIDER_MAX_HEADER_NAME_BYTES = 128;
export const PROVIDER_MAX_HEADER_VALUE_BYTES = 2048;
export const PROVIDER_MAX_HEADER_BYTES = 8192;
const MAX_LABEL_BYTES = 160;
const MAX_MODEL_BYTES = 256;
const MAX_BASE_URL_BYTES = 512;
const MAX_SECRET_REF_BYTES = 160;
const reservedHeaders = new Set(["authorization", "proxy-authorization", "content-type", "content-length", "host", "connection", "keep-alive", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade", "cookie", "set-cookie", "user-agent"]);

export const defaultPluginPlatformSettings: PluginPlatformSettings = {
  allowPluginAudio: true,
  allowDynamicSpeech: false,
  allowPluginVoice: true,
  allowMicrophone: false,
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  profiles: {},
  selections: { text: null, stt: null, tts: null },
};

const settingsFileName = "openpets-plugin-platform.json";
let settingsPath: string | null = null;
let cached: PluginPlatformSettings = defaultPluginPlatformSettings;

export const providerPresets = Object.freeze([
  { id: "openai", label: "OpenAI", adapter: "openai-realtime" as const, model: "gpt-realtime-2.1", baseUrl: "https://api.openai.com/v1", credentialMode: "required" as const },
  { id: "anthropic", label: "Anthropic", adapter: "anthropic-text" as const, model: "claude-haiku-4-5-20251001", baseUrl: "https://api.anthropic.com", credentialMode: "required" as const },
  { id: "ollama", label: "Ollama", adapter: "openai-compatible-text" as const, model: "llama3.2", baseUrl: "http://127.0.0.1:11434/v1", credentialMode: "none" as const },
  { id: "lm-studio", label: "LM Studio", adapter: "openai-compatible-text" as const, model: "local-model", baseUrl: "http://127.0.0.1:1234/v1", credentialMode: "none" as const },
  { id: "vllm", label: "vLLM", adapter: "openai-compatible-text" as const, model: "local-model", baseUrl: "http://127.0.0.1:8000/v1", credentialMode: "none" as const },
  { id: "minimax-chat", label: "MiniMax chat", adapter: "openai-compatible-text" as const, model: "MiniMax-M3", baseUrl: "https://api.minimax.io/v1", credentialMode: "required" as const },
  { id: "whisper", label: "Whisper-compatible STT", adapter: "openai-compatible-transcription" as const, model: "whisper-1", baseUrl: "https://api.openai.com/v1", credentialMode: "required" as const },
  { id: "elevenlabs", label: "ElevenLabs TTS", adapter: "elevenlabs-tts" as const, model: "eleven_multilingual_v2", baseUrl: "https://api.elevenlabs.io/v1", credentialMode: "required" as const },
  { id: "system-tts", label: "System voice", adapter: "system-tts" as const, model: "", credentialMode: "none" as const },
] as const);

export function initializePluginPlatformSettings(userDataPath: string): PluginPlatformSettings {
  const path = join(userDataPath, settingsFileName);
  settingsPath = path;
  cached = readSettingsFile(path);
  return cached;
}

export function getPluginPlatformSettings(): PluginPlatformSettings { return cached; }

export function updatePluginPlatformSettings(patch: ProviderGatesPatch): PluginPlatformSettings {
  const value = normalizeSettings({ ...cached, ...patch, quietHours: { ...cached.quietHours, ...(patch.quietHours ?? {}) } });
  cached = value;
  if (settingsPath) writeSettingsFile(settingsPath, cached);
  return cached;
}

export function validateProviderGatesPatch(value: unknown): ProviderGatesPatch {
  if (!isRecord(value)) throw new Error("Provider gate update must be an object.");
  for (const key of ["allowPluginAudio", "allowDynamicSpeech", "allowPluginVoice", "allowMicrophone"] as const) if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error("Provider gate update contains an invalid flag.");
  if (value.quietHours !== undefined) {
    if (!isRecord(value.quietHours)) throw new Error("Provider quiet hours update is invalid.");
    if (value.quietHours.enabled !== undefined && typeof value.quietHours.enabled !== "boolean") throw new Error("Provider quiet hours enabled flag is invalid.");
    if (value.quietHours.start !== undefined && !validTime(value.quietHours.start)) throw new Error("Provider quiet hours start is invalid.");
    if (value.quietHours.end !== undefined && !validTime(value.quietHours.end)) throw new Error("Provider quiet hours end is invalid.");
  }
  return value as ProviderGatesPatch;
}

export function createProviderProfile(input: ProviderProfileInput): PluginPlatformSettings {
  const profile = validateProviderProfile(input);
  if (cached.profiles[profile.id]) throw new Error("Provider profile id is already in use.");
  cached = persist({ ...cached, profiles: { ...cached.profiles, [profile.id]: profile } });
  return cached;
}

export function updateProviderProfile(id: string, patch: ProviderProfilePatch): PluginPlatformSettings {
  assertProfileId(id);
  const existing = cached.profiles[id];
  if (!existing) throw new Error("Provider profile was not found.");
  const validatedPatch = validateProviderProfilePatch(patch);
  if (validatedPatch.id !== undefined && validatedPatch.id !== id) throw new Error("Provider profile id cannot be changed.");
  const merged: Record<string, unknown> = { ...existing, id };
  for (const [key, value] of Object.entries(validatedPatch)) {
    if (value === undefined) continue;
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  const profile = validateProviderProfile(merged);
  cached = persist({ ...cached, profiles: { ...cached.profiles, [id]: profile } });
  return cached;
}

export function deleteProviderProfile(id: string): PluginPlatformSettings {
  assertProfileId(id);
  if (!cached.profiles[id]) throw new Error("Provider profile was not found.");
  const profiles = { ...cached.profiles };
  delete profiles[id];
  const selections: ProviderSelections = { text: cached.selections.text === id ? null : cached.selections.text, stt: cached.selections.stt === id ? null : cached.selections.stt, tts: cached.selections.tts === id ? null : cached.selections.tts };
  cached = persist({ ...cached, profiles, selections });
  return cached;
}

export function selectProviderProfile(role: ProviderRole, profileId: string | null): PluginPlatformSettings {
  if (!isRole(role)) throw new Error("Invalid provider role.");
  if (profileId !== null) {
    assertProfileId(profileId);
    const profile = cached.profiles[profileId];
    if (!profile) throw new Error("Provider profile was not found.");
    if (!profileSupportsRole(profile, role)) throw new Error(`Provider profile does not support ${role}.`);
  }
  cached = persist({ ...cached, selections: { ...cached.selections, [role]: profileId } });
  return cached;
}

export function validateProviderProfile(input: unknown): ProviderProfile {
  if (!isRecord(input)) throw new Error("Provider profile must be an object.");
  const id = input.id;
  assertProfileId(id);
  const label = boundedString(input.label, "Provider profile label", MAX_LABEL_BYTES);
  const adapter = input.adapter;
  if (!isAdapter(adapter)) throw new Error("Provider profile adapter is invalid.");
  const model = boundedString(input.model, "Provider profile model", MAX_MODEL_BYTES, true);
  if (adapter !== "system-tts" && model.length === 0) throw new Error("Provider profile model is required.");
  const baseUrl = input.baseUrl === undefined || input.baseUrl === "" ? undefined : validateProviderBaseUrl(input.baseUrl);
  const secretRef = input.secretRef === undefined || input.secretRef === "" ? undefined : boundedString(input.secretRef, "Provider secret reference", MAX_SECRET_REF_BYTES);
  const headers = validateProviderHeaders(input.headers);
  const auth = validateProviderAuth(input.auth, adapter, secretRef);
  if (auth && headers.some((header) => header.name.toLowerCase() === auth.headerName.toLowerCase())) throw new Error("Provider auth header must not also be declared as a static header.");
  if (adapter === "system-tts" && (baseUrl || secretRef || auth || headers.length > 0)) throw new Error("System TTS profiles cannot define a network endpoint or credential.");
  if ((adapter === "anthropic-text" || adapter === "minimax-tts" || adapter === "elevenlabs-tts") && !baseUrl) throw new Error("This provider profile requires a base URL.");
  if ((adapter === "openai-compatible-text" || adapter === "openai-realtime" || adapter === "openai-compatible-transcription" || adapter === "openai-compatible-speech") && !baseUrl) throw new Error("OpenAI-compatible provider profiles require a base URL.");
  return Object.freeze({ id, label, adapter, model, ...(baseUrl ? { baseUrl } : {}), ...(secretRef ? { secretRef } : {}), ...(auth ? { auth } : {}), ...(headers.length > 0 ? { headers: Object.freeze(headers) } : {}) });
}

export function validateProviderProfilePatch(value: unknown): ProviderProfilePatch {
  if (!isRecord(value)) throw new Error("Provider profile patch must be an object.");
  const allowed = new Set(["id", "label", "adapter", "model", "baseUrl", "secretRef", "auth", "headers"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Provider profile patch field ${key} is not supported.`);
  if (value.id !== undefined) assertProfileId(value.id);
  if (value.label !== undefined) boundedString(value.label, "Provider profile label", MAX_LABEL_BYTES);
  if (value.adapter !== undefined && !isAdapter(value.adapter)) throw new Error("Provider profile adapter is invalid.");
  if (value.model !== undefined) boundedString(value.model, "Provider profile model", MAX_MODEL_BYTES, true);
  if (value.baseUrl !== undefined && value.baseUrl !== null) validateProviderBaseUrl(value.baseUrl);
  if (value.secretRef !== undefined && value.secretRef !== null) boundedString(value.secretRef, "Provider secret reference", MAX_SECRET_REF_BYTES);
  if (value.auth !== undefined && value.auth !== null) validateProviderAuth(value.auth, "openai-compatible-text", "patch-secret");
  if (value.headers !== undefined) validateProviderHeaders(value.headers);
  return value as ProviderProfilePatch;
}

export function profileSupportsRole(profile: ProviderProfile, role: ProviderRole): boolean {
  if (role === "text") return profile.adapter === "openai-compatible-text" || profile.adapter === "openai-realtime" || profile.adapter === "anthropic-text";
  if (role === "stt") return profile.adapter === "openai-compatible-transcription";
  return profile.adapter === "system-tts" || profile.adapter === "minimax-tts" || profile.adapter === "elevenlabs-tts" || profile.adapter === "openai-compatible-speech";
}

export function validateProviderBaseUrl(value: unknown): string {
  const text = boundedString(value, "Provider base URL", MAX_BASE_URL_BYTES);
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new Error("Provider base URL must be a valid HTTP or HTTPS URL."); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalHost(parsed.hostname))) throw new Error("Provider base URL must use HTTPS; HTTP is allowed only for local endpoints and URLs cannot contain credentials, query, or fragment.");
  return text.replace(/\/$/, "");
}

export function validateProviderHeaders(value: unknown): readonly ProviderHeader[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PROVIDER_MAX_HEADERS) throw new Error(`Provider headers must contain at most ${PROVIDER_MAX_HEADERS} entries.`);
  const seen = new Set<string>();
  let total = 0;
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error("Provider header must be an object.");
    const name = boundedString(entry.name, "Provider header name", PROVIDER_MAX_HEADER_NAME_BYTES);
    const normalized = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || reservedHeaders.has(normalized)) throw new Error(`Provider header ${name} is reserved or invalid.`);
    if (seen.has(normalized)) throw new Error("Provider headers must not contain duplicate names.");
    seen.add(normalized);
    const headerValue = boundedString(entry.value, "Provider header value", PROVIDER_MAX_HEADER_VALUE_BYTES);
    if (/[\r\n\0]/.test(headerValue)) throw new Error("Provider header value contains an invalid control character.");
    total += Buffer.byteLength(name) + Buffer.byteLength(headerValue);
    if (total > PROVIDER_MAX_HEADER_BYTES) throw new Error("Provider headers are too large.");
    return Object.freeze({ name, value: headerValue });
  });
}

export function validateProviderAuth(value: unknown, adapter: ProviderAdapter, secretRef?: string): ProviderAuth | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Provider auth configuration must be an object.");
  if (!secretRef) throw new Error("Provider auth configuration requires a secret reference.");
  const headerName = boundedString(value.headerName, "Provider auth header name", PROVIDER_MAX_HEADER_NAME_BYTES);
  const normalized = headerName.toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName) || reservedHeaders.has(normalized) && normalized !== "authorization") throw new Error(`Provider auth header ${headerName} is invalid.`);
  const strategy = value.strategy;
  if (strategy !== "bearer" && strategy !== "raw") throw new Error("Provider auth strategy is invalid.");
  if (adapter === "system-tts") throw new Error("System TTS profiles cannot define auth.");
  return Object.freeze({ headerName, strategy });
}

export function defaultProviderAuth(adapter: ProviderAdapter): ProviderAuth {
  if (adapter === "anthropic-text") return { headerName: "x-api-key", strategy: "raw" };
  if (adapter === "elevenlabs-tts") return { headerName: "xi-api-key", strategy: "raw" };
  return { headerName: "authorization", strategy: "bearer" };
}

export function profileStatus(settings: PluginPlatformSettings, role: ProviderRole, hasCredential: (profile: ProviderProfile) => boolean): ProviderStatus {
  const id = settings.selections[role];
  if (!id) return { role, state: "disabled", code: "provider.role.disabled", message: `No ${role} provider profile is selected.` };
  const profile = settings.profiles[id];
  if (!profile) return { role, state: "invalid", code: "provider.profile.missing", message: "The selected provider profile no longer exists.", profileId: id };
  if (!profileSupportsRole(profile, role)) return { role, state: "unsupported", code: "provider.role.unsupported", message: `The selected provider profile does not support ${role}.`, profileId: id };
  if (profile.adapter !== "system-tts" && profile.secretRef && !hasCredential(profile)) return { role, state: "missing-secret", code: "provider.credential.missing", message: "The selected provider profile has no credential.", profileId: id };
  return { role, state: "ready", code: "provider.ready", message: "Provider profile is ready.", profileId: id };
}

function getNormalizedProfileSummaries(settings: PluginPlatformSettings, hasCredential: (profile: ProviderProfile) => boolean): readonly ProviderProfileSummary[] {
  return Object.values(settings.profiles).map((profile) => {
    const { headers: _headers, ...safeProfile } = profile;
    return Object.freeze({ ...safeProfile, headerNames: Object.freeze((profile.headers ?? []).map((header) => header.name)), hasCredential: Boolean(profile.secretRef && hasCredential(profile)) });
  });
}

export function buildProviderControlCenterSnapshot(settings: PluginPlatformSettings, hasCredential: (profile: ProviderProfile) => boolean): ProviderControlCenterSnapshot {
  const statuses = Object.fromEntries(([
    ["text", profileStatus(settings, "text", hasCredential)],
    ["stt", profileStatus(settings, "stt", hasCredential)],
    ["tts", profileStatus(settings, "tts", hasCredential)],
    ["realtime", realtimeStatus(settings, hasCredential)],
  ] as const)) as ProviderControlCenterSnapshot["statuses"];
  return { gates: { allowPluginAudio: settings.allowPluginAudio, allowDynamicSpeech: settings.allowDynamicSpeech, allowPluginVoice: settings.allowPluginVoice, allowMicrophone: settings.allowMicrophone, quietHours: settings.quietHours }, profiles: getNormalizedProfileSummaries(settings, hasCredential), selections: settings.selections, statuses, presets: providerPresets };
}

export function realtimeStatus(settings: PluginPlatformSettings, hasCredential: (profile: ProviderProfile) => boolean): ProviderStatus {
  const id = settings.selections.text;
  if (!id) return { role: "realtime", state: "disabled", code: "provider.realtime.disabled", message: "Realtime is unavailable because no text profile is selected." };
  const profile = settings.profiles[id];
  if (!profile || profile.adapter !== "openai-realtime") return { role: "realtime", state: "unsupported", code: "provider.realtime.unsupported", message: "Realtime requires an explicit native OpenAI realtime profile.", profileId: id };
  if (profile.secretRef && !hasCredential(profile)) return { role: "realtime", state: "missing-secret", code: "provider.credential.missing", message: "The selected realtime profile has no credential.", profileId: id };
  return { role: "realtime", state: "ready", code: "provider.ready", message: "Realtime profile is ready.", profileId: id };
}

export function isProviderRole(value: unknown): value is ProviderRole { return isRole(value); }

export function isProviderSecretRefReferenced(settings: PluginPlatformSettings, ref: string): boolean {
  return Object.values(settings.profiles).some((profile) => profile.secretRef === ref);
}

function normalizeSettings(value: unknown): PluginPlatformSettings {
  const raw = isRecord(value) ? value : {};
  const quiet = isRecord(raw.quietHours) ? raw.quietHours : {};
  const profiles: Record<string, ProviderProfile> = {};
  if (isRecord(raw.profiles)) for (const [id, profile] of Object.entries(raw.profiles)) { try { const normalized = validateProviderProfile({ ...(isRecord(profile) ? profile : {}), id }); profiles[id] = normalized; } catch { /* invalid persisted profiles are surfaced by the missing selection/status path */ } }
  const selections = isRecord(raw.selections) ? { text: selection(raw.selections.text), stt: selection(raw.selections.stt), tts: selection(raw.selections.tts) } : defaultPluginPlatformSettings.selections;
  return { allowPluginAudio: raw.allowPluginAudio !== false, allowDynamicSpeech: raw.allowDynamicSpeech === true, allowPluginVoice: raw.allowPluginVoice !== false, allowMicrophone: raw.allowMicrophone === true, quietHours: { enabled: quiet.enabled === true, start: validTime(quiet.start) ? quiet.start as string : "22:00", end: validTime(quiet.end) ? quiet.end as string : "08:00" }, profiles, selections };
}

function persist(settings: PluginPlatformSettings): PluginPlatformSettings { cached = settings; if (settingsPath) writeSettingsFile(settingsPath, settings); return settings; }
function readSettingsFile(path: string): PluginPlatformSettings { try { if (!existsSync(path)) return defaultPluginPlatformSettings; return normalizeSettings(JSON.parse(readFileSync(path, "utf8"))); } catch { return defaultPluginPlatformSettings; } }
function writeSettingsFile(path: string, settings: PluginPlatformSettings): void { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8"); renameSync(tmp, path); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function boundedString(value: unknown, label: string, maxBytes: number, allowEmpty = false): string { if (typeof value !== "string" || (!allowEmpty && value.trim() === "") || Buffer.byteLength(value, "utf8") > maxBytes || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} is invalid.`); return value.trim(); }
function assertProfileId(value: unknown): asserts value is string { if (typeof value !== "string" || !PROVIDER_PROFILE_ID.test(value)) throw new Error("Provider profile id is invalid."); }
function isAdapter(value: unknown): value is ProviderAdapter { return ["openai-compatible-text", "openai-realtime", "anthropic-text", "openai-compatible-transcription", "system-tts", "minimax-tts", "elevenlabs-tts", "openai-compatible-speech"].includes(String(value)); }
function isRole(value: unknown): value is ProviderRole { return ["text", "stt", "tts"].includes(String(value)); }
function validTime(value: unknown): value is string { return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function selection(value: unknown): string | null { return typeof value === "string" && PROVIDER_PROFILE_ID.test(value) ? value : null; }
function isLocalHost(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".local")) return true;
  const octets = host.split(".").map(Number);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) && (octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

export function isInQuietHours(now = new Date()): boolean { const { enabled, start, end } = cached.quietHours; if (!enabled) return false; const current = now.getHours() * 60 + now.getMinutes(); const from = timeMinutes(start); const to = timeMinutes(end); if (from === to) return false; return from < to ? current >= from && current < to : current >= from || current < to; }
function timeMinutes(value: string): number { const [hours, minutes] = value.split(":").map(Number); return hours * 60 + minutes; }
