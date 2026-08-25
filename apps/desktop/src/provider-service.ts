import type { PluginSecretsStore } from "./plugin-secrets.js";
import { defaultProviderAuth, getPluginPlatformSettings, type ProviderProfile, type ProviderRole } from "./plugin-platform-settings.js";

export const hostSecretsOwner = "__openpets-host";
export const providerSecretKey = (ref: string): string => `provider:${ref}`;
export const MINIMAX_MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MINIMAX_MAX_RESPONSE_BYTES = MINIMAX_MAX_AUDIO_BYTES * 2 + 16 * 1024;

export type ProviderOperationSnapshot = {
  readonly role: ProviderRole | "realtime";
  readonly profile: ProviderProfile;
  readonly secret?: string;
};
export type ProviderFetch = typeof fetch;
export type ProviderServiceOptions = { readonly fetchImpl?: ProviderFetch; readonly timeoutMs?: number };

/** Narrow host-owned operation boundary. Callers never receive settings or secret-store internals. */
export interface HostProviderOperations {
  snapshot(role: ProviderRole | "realtime"): Promise<ProviderOperationSnapshot>;
  json(snapshot: ProviderOperationSnapshot, path: string, body: Record<string, unknown>, signal?: AbortSignal, maxBytes?: number): Promise<unknown>;
  binary(snapshot: ProviderOperationSnapshot, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Uint8Array>;
  stream(snapshot: ProviderOperationSnapshot, path: string, body: Record<string, unknown>, onData: (data: string) => void, signal?: AbortSignal): Promise<void>;
  transcribe(snapshot: ProviderOperationSnapshot, audio: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<string>;
  synthesize(snapshot: ProviderOperationSnapshot, text: string, opts: { voice?: string; rate?: number }): Promise<{ readonly bytes: Uint8Array; readonly mimeType: "audio/mpeg" } | null>;
  negotiateRealtime(snapshot: ProviderOperationSnapshot, sdp: string, session: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<string>;
}

export class HostProviderService implements HostProviderOperations {
  readonly #secrets: PluginSecretsStore;
  readonly #fetch: ProviderFetch;
  readonly #timeoutMs: number;

  constructor(secrets: PluginSecretsStore, options: ProviderServiceOptions = {}) {
    this.#secrets = secrets;
    this.#fetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async snapshot(role: ProviderRole | "realtime"): Promise<ProviderOperationSnapshot> {
    const settings = getPluginPlatformSettings();
    const id = role === "realtime" ? settings.selections.text : settings.selections[role];
    if (!id) throw providerError(`${role === "realtime" ? "Realtime" : role} provider is disabled.`, "provider.disabled");
    const profile = settings.profiles[id];
    if (!profile) throw providerError("Selected provider profile is invalid.", "provider.profile.invalid");
    if (role !== "realtime" && !supports(profile, role)) throw providerError(`Selected provider does not support ${role}.`, "provider.role.unsupported");
    if (role === "realtime" && profile.adapter !== "openai-realtime") throw providerError("Realtime requires an explicit native OpenAI realtime profile.", "provider.realtime.unsupported");
    const secret = profile.secretRef ? await this.#secrets.get(hostSecretsOwner, providerSecretKey(profile.secretRef)) : undefined;
    if (profile.secretRef && !secret) throw providerError("Selected provider profile has no credential.", "provider.credential.missing");
    return Object.freeze({ role, profile, ...(secret === undefined ? {} : { secret }) });
  }

  async json(snapshot: ProviderOperationSnapshot, path: string, body: Record<string, unknown>, signal?: AbortSignal, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
    const request = await this.#request(snapshot, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, signal);
    try {
      const text = await boundedText(request.response, maxBytes, request.abortPromise);
      if (!request.response.ok) throw providerError(`Provider request failed with HTTP ${request.response.status}.`, "provider.request.failed");
      try { return JSON.parse(text) as unknown; } catch { throw providerError("Provider returned malformed JSON.", "provider.response.invalid"); }
    } finally { await request.release(); }
  }

  async binary(snapshot: ProviderOperationSnapshot, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Uint8Array> {
    const request = await this.#request(snapshot, path, { method: "POST", headers: { "content-type": "application/json", accept: "audio/mpeg" }, body: JSON.stringify(body) }, signal);
    try {
      if (!request.response.ok) throw providerError(`Provider request failed with HTTP ${request.response.status}.`, "provider.request.failed");
      return readBoundedBytes(request.response, 64 * 1024 * 1024, request.abortPromise, "Provider audio response is too large.");
    } finally { await request.release(); }
  }

  async stream(snapshot: ProviderOperationSnapshot, path: string, body: Record<string, unknown>, onData: (data: string) => void, signal?: AbortSignal): Promise<void> {
    const request = await this.#request(snapshot, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, stream: true }) }, signal);
    try {
      if (!request.response.ok || !request.response.body) throw providerError(`Provider request failed with HTTP ${request.response.status}.`, "provider.request.failed");
      await readSseStream(request.response.body, onData, request.abortPromise);
    } finally { await request.release(); }
  }

  async transcribe(snapshot: ProviderOperationSnapshot, audio: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<string> {
    if (snapshot.profile.adapter !== "openai-compatible-transcription") throw providerError("Selected provider is not a transcription profile.", "provider.role.unsupported");
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(audio)], { type: mimeType }), `speech.${extension(mimeType)}`);
    form.append("model", snapshot.profile.model);
    const request = await this.#request(snapshot, "/audio/transcriptions", { method: "POST", body: form }, signal);
    try {
      if (!request.response.ok) throw providerError(`Transcription failed with HTTP ${request.response.status}.`, "provider.request.failed");
      const parsed = JSON.parse(await boundedText(request.response, 2 * 1024 * 1024, request.abortPromise)) as { text?: unknown };
      return typeof parsed.text === "string" ? parsed.text : "";
    } finally { await request.release(); }
  }

  async synthesize(snapshot: ProviderOperationSnapshot, text: string, opts: { voice?: string; rate?: number }): Promise<{ readonly bytes: Uint8Array; readonly mimeType: "audio/mpeg" } | null> {
    const profile = snapshot.profile;
    if (profile.adapter === "system-tts") return null;
    if (profile.adapter === "minimax-tts") {
      const parsed = await this.json(snapshot, "/t2a_v2", { model: profile.model, text, stream: false, output_format: "hex", audio_setting: { format: "mp3" }, voice_setting: { voice_id: opts.voice || "English_expressive_narrator", ...(opts.rate === undefined ? {} : { speed: opts.rate }) } }, undefined, MINIMAX_MAX_RESPONSE_BYTES) as { data?: { audio?: string; status?: number }; base_resp?: { status_code?: number; status_msg?: string } };
      if (parsed.base_resp?.status_code !== undefined && parsed.base_resp.status_code !== 0) throw providerError("MiniMax speech synthesis failed.", "provider.response.invalid");
      const hex = parsed.data?.audio;
      if (parsed.data?.status !== 2 || typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) throw providerError("MiniMax returned invalid speech audio.", "provider.response.invalid");
      if (hex.length > MINIMAX_MAX_AUDIO_BYTES * 2) throw providerError("MiniMax speech audio is too large.", "provider.response.too_large");
      return { bytes: Buffer.from(hex, "hex"), mimeType: "audio/mpeg" };
    }
    if (profile.adapter === "elevenlabs-tts") {
      const voice = opts.voice || "21m00Tcm4TlvDq8ikWAM";
      return { bytes: await this.binary(snapshot, `/text-to-speech/${encodeURIComponent(voice)}`, { text, model_id: profile.model, ...(opts.rate === undefined ? {} : { voice_settings: { speed: opts.rate } }) }), mimeType: "audio/mpeg" };
    }
    if (profile.adapter === "openai-compatible-speech") {
      return { bytes: await this.binary(snapshot, "/audio/speech", { model: profile.model, input: text, voice: opts.voice || "alloy", response_format: "mp3", ...(opts.rate === undefined ? {} : { speed: opts.rate }) }), mimeType: "audio/mpeg" };
    }
    throw providerError("Selected provider is not a TTS profile.", "provider.role.unsupported");
  }

  async negotiateRealtime(snapshot: ProviderOperationSnapshot, sdp: string, session: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<string> {
    const body = new FormData();
    body.set("sdp", sdp);
    body.set("session", JSON.stringify(session));
    const request = await this.#request(snapshot, "/realtime/calls", { method: "POST", body }, signal);
    try {
      const answer = await boundedText(request.response, 2 * 1024 * 1024, request.abortPromise);
      if (!request.response.ok) throw providerError(`Realtime negotiation failed with HTTP ${request.response.status}.`, "provider.request.failed");
      return answer;
    } finally { await request.release(); }
  }

  async #request(snapshot: ProviderOperationSnapshot, path: string, init: RequestInit, signal?: AbortSignal): Promise<{ readonly response: Response; readonly abortPromise: Promise<never>; readonly release: () => Promise<void> }> {
    const controller = new AbortController();
    let rejectAbort!: (error: unknown) => void;
    const abortPromise = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    let timedOut = false;
    let handedOff = false;
    const abort = () => { controller.abort(); rejectAbort(providerError("Provider request was cancelled.", "provider.cancelled")); };
    if (signal?.aborted) throw providerError("Provider request was cancelled.", "provider.cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); rejectAbort(providerError("Provider request timed out.", "provider.timeout")); }, this.#timeoutMs);
    try {
      const headers = new Headers(snapshot.profile.headers?.map((header) => [header.name, header.value]));
      if (snapshot.secret) {
        const auth = snapshot.profile.auth ?? defaultProviderAuth(snapshot.profile.adapter);
        headers.set(auth.headerName, auth.strategy === "bearer" ? `Bearer ${snapshot.secret}` : snapshot.secret);
      }
      if (snapshot.profile.adapter === "anthropic-text") headers.set("anthropic-version", "2023-06-01");
      for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
      const url = endpoint(snapshot.profile, path);
      const response = await Promise.race([this.#fetch(url, { ...init, headers, redirect: "error", signal: controller.signal }), abortPromise]);
      handedOff = true;
      let released = false;
      return { response, abortPromise, release: async () => {
        if (released) return;
        released = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        controller.abort();
        await response.body?.cancel().catch(() => undefined);
      } };
    } catch (error) {
      if (signal?.aborted) throw providerError("Provider request was cancelled.", "provider.cancelled");
      if (timedOut) throw providerError("Provider request timed out.", "provider.timeout");
      throw error;
    } finally { if (!handedOff) { clearTimeout(timeout); signal?.removeEventListener("abort", abort); } }
  }
}

export function providerError(message: string, code: string): Error & { readonly code: string } { const error = new Error(message) as Error & { code: string }; error.code = code; return error; }
function supports(profile: ProviderProfile, role: ProviderRole): boolean { return role === "stt" ? profile.adapter === "openai-compatible-transcription" : role === "tts" ? ["system-tts", "minimax-tts", "elevenlabs-tts", "openai-compatible-speech"].includes(profile.adapter) : ["openai-compatible-text", "openai-realtime", "anthropic-text"].includes(profile.adapter); }
function endpoint(profile: ProviderProfile, path: string): string { const base = profile.baseUrl?.replace(/\/$/, "") ?? ""; return `${base}${path.startsWith("/") ? path : `/${path}`}`; }
async function boundedText(response: Response, maxBytes: number, abortPromise: Promise<never>): Promise<string> { const length = Number(response.headers.get("content-length")); if (Number.isFinite(length) && length > maxBytes) throw providerError("Provider response is too large.", "provider.response.too_large"); if (!response.body) return ""; const bytes = await readBoundedBytes(response, maxBytes, abortPromise, "Provider response is too large."); return new TextDecoder().decode(bytes); }
async function readBoundedBytes(response: Response, maxBytes: number, abortPromise: Promise<never>, message: string): Promise<Uint8Array> { const length = Number(response.headers.get("content-length")); if (Number.isFinite(length) && length > maxBytes) throw providerError(message, "provider.response.too_large"); if (!response.body) return new Uint8Array(); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0; try { for (;;) { const { done, value } = await Promise.race([reader.read(), abortPromise]); if (done) break; bytes += value.byteLength; if (bytes > maxBytes) throw providerError(message, "provider.response.too_large"); chunks.push(value); } } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); } const result = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result; }
async function readSseStream(body: ReadableStream<Uint8Array>, onData: (data: string) => void, abortPromise: Promise<never>): Promise<void> { const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let bytes = 0; try { for (;;) { const { done, value } = await Promise.race([reader.read(), abortPromise]); if (done) break; bytes += value.byteLength; if (bytes > 32 * 1024 * 1024) throw providerError("Provider stream is too large.", "provider.response.too_large"); buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) { const item = line.trim(); if (item.startsWith("data:")) onData(item.slice(5).trim()); } } } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); } }
function extension(mime: string): string { const base = mime.toLowerCase().split(";", 1)[0] ?? ""; return base.includes("ogg") ? "ogg" : base.includes("wav") ? "wav" : base.includes("mp4") ? "mp4" : "webm"; }
