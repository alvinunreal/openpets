import { createHash } from "node:crypto";

import {
  defaultHostAiModels,
  getHostAiSettings,
  type HostAiProviderKind,
} from "./host-ai-settings.js";

export const hostSecretsOwner = "__openpets-host";
export const hostAiApiKeySecret = "ai-api-key";

export type HostAiRequest = {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
  tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
};

export type HostAiResult = {
  text: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
};

export type HostAiHealthStatus = "unconfigured" | "configured-unverified" | "probing" | "ready" | "error";
export type HostAiHealthEvidence = "anthropic-model" | "openai-model" | "openai-compatible-models";

export type HostAiHealthSnapshot = {
  readonly status: HostAiHealthStatus;
  readonly configured: boolean;
  readonly ready: boolean;
  readonly provider: HostAiProviderKind;
  readonly model: string;
  readonly baseUrl?: string;
  readonly checkedAt?: number;
  readonly stale: boolean;
  readonly evidence?: HostAiHealthEvidence;
  readonly error?: string;
};

export type HostAiSecrets = {
  get(owner: string, key: string): Promise<string | undefined>;
};

export type HostAiGatewayOptions = {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly healthTtlMs?: number;
};

export type HostAiCallOptions = { readonly signal?: AbortSignal };
export type HostAiProbeOptions = HostAiCallOptions & { readonly force?: boolean };

type ActiveProvider = Exclude<HostAiProviderKind, "none">;
type ProviderContext = {
  readonly provider: ActiveProvider;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
};
type HealthContext = {
  readonly provider: HostAiProviderKind;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly configured: boolean;
  readonly cacheKey: string;
};
type HealthCache = { readonly key: string; readonly snapshot: HostAiHealthSnapshot };

const defaultHealthTtlMs = 5 * 60_000;
const maxNonStreamJsonBytes = 2 * 1024 * 1024;

/**
 * Host-owned AI provider gateway shared by companion, voice, and plugin
 * compatibility surfaces. Provider settings and encrypted credentials remain
 * outside callers; readiness is an explicit cached probe rather than an
 * overloaded meaning of `available()`.
 */
export class HostAiGateway {
  readonly #secrets: HostAiSecrets;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #healthTtlMs: number;
  #healthCache: HealthCache | null = null;
  #probingKey: string | null = null;

  constructor(secrets: HostAiSecrets, options: HostAiGatewayOptions = {}) {
    this.#secrets = secrets;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#healthTtlMs = Math.max(0, options.healthTtlMs ?? defaultHealthTtlMs);
  }

  /** Compatibility readiness: configured enough to attempt, without a probe. */
  async available(): Promise<boolean> {
    return (await this.#resolveHealthContext()).configured;
  }

  async complete(req: HostAiRequest, options: HostAiCallOptions = {}): Promise<HostAiResult> {
    const provider = await this.#resolveProvider();
    if (provider.provider === "anthropic") return this.#anthropicComplete(req, provider, options.signal);
    return this.#openAiComplete(req, provider, options.signal);
  }

  async stream(req: HostAiRequest, onToken: (chunk: string) => void, options: HostAiCallOptions = {}): Promise<{ text: string }> {
    const provider = await this.#resolveProvider();
    if (provider.provider === "anthropic") return this.#anthropicStream(req, provider, onToken, options.signal);
    return this.#openAiStream(req, provider, onToken, options.signal);
  }

  /** One-shot audio transcription for OpenAI-compatible providers. */
  async transcribe(audio: Uint8Array, mimeType: string, options: HostAiCallOptions = {}): Promise<string> {
    const provider = await this.#resolveProvider();
    if (provider.provider === "anthropic") throw new Error("Speech-to-text needs an OpenAI-compatible AI provider.");
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(audio)], { type: mimeType }), "speech.webm");
    form.append("model", "whisper-1");
    const response = await this.#fetch(`${provider.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
      body: form,
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`Transcription failed with HTTP ${response.status}.`);
    const parsed = await readBoundedJson<{ text?: string }>(response, "Transcription response", options.signal);
    return typeof parsed.text === "string" ? parsed.text : "";
  }

  async getHealthSnapshot(): Promise<HostAiHealthSnapshot> {
    return this.#snapshotForContext(await this.#resolveHealthContext());
  }

  async probeHealth(options: HostAiProbeOptions = {}): Promise<HostAiHealthSnapshot> {
    const context = await this.#resolveHealthContext();
    const current = this.#snapshotForContext(context);
    if (!context.configured) return current;
    if (options.force !== true && (current.status === "ready" || current.status === "error") && !current.stale) return current;

    throwIfAborted(options.signal);
    this.#probingKey = context.cacheKey;
    const evidence = probeEvidence(context.provider);
    try {
      const response = await this.#probeProvider(context, options.signal);
      throwIfAborted(options.signal);
      const checkedAt = this.#now();
      const snapshot: HostAiHealthSnapshot = response.ok
        ? this.#baseHealth(context, { status: "ready", configured: true, ready: true, checkedAt, stale: false, evidence })
        : this.#baseHealth(context, {
            status: "error",
            configured: true,
            ready: false,
            checkedAt,
            stale: false,
            evidence,
            error: `AI provider probe failed with HTTP ${response.status}.`,
          });
      this.#healthCache = { key: context.cacheKey, snapshot };
      return snapshot;
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      const snapshot = this.#baseHealth(context, {
        status: "error",
        configured: true,
        ready: false,
        checkedAt: this.#now(),
        stale: false,
        evidence,
        error: "AI provider probe failed.",
      });
      this.#healthCache = { key: context.cacheKey, snapshot };
      return snapshot;
    } finally {
      if (this.#probingKey === context.cacheKey) this.#probingKey = null;
    }
  }

  invalidateHealth(): void {
    this.#healthCache = null;
    this.#probingKey = null;
  }

  async #resolveProvider(): Promise<ProviderContext> {
    const settings = getHostAiSettings();
    if (settings.provider === "none") throw new Error("No AI provider is configured in OpenPets settings.");
    const apiKey = await this.#secrets.get(hostSecretsOwner, hostAiApiKeySecret);
    if (settings.provider !== "ollama" && !apiKey) throw new Error("The configured AI provider has no API key.");
    return {
      provider: settings.provider,
      model: settings.model || defaultHostAiModels[settings.provider],
      baseUrl: effectiveBaseUrl(settings.provider, settings.baseUrl),
      apiKey,
    };
  }

  async #resolveHealthContext(): Promise<HealthContext> {
    const settings = getHostAiSettings();
    const apiKey = settings.provider === "none"
      ? undefined
      : await this.#secrets.get(hostSecretsOwner, hostAiApiKeySecret);
    const configured = settings.provider !== "none" && (settings.provider === "ollama" || Boolean(apiKey));
    const model = settings.provider === "none" ? "" : settings.model || defaultHostAiModels[settings.provider];
    const baseUrl = settings.provider === "none" ? undefined : effectiveBaseUrl(settings.provider, settings.baseUrl);
    const keyFingerprint = apiKey ? createHash("sha256").update(apiKey).digest("hex") : "none";
    return {
      provider: settings.provider,
      model,
      baseUrl,
      apiKey,
      configured,
      cacheKey: `${settings.provider}\u0000${model}\u0000${baseUrl ?? ""}\u0000${keyFingerprint}`,
    };
  }

  #snapshotForContext(context: HealthContext): HostAiHealthSnapshot {
    if (!context.configured) {
      return this.#baseHealth(context, { status: "unconfigured", configured: false, ready: false, stale: false });
    }
    if (this.#probingKey === context.cacheKey) {
      return this.#baseHealth(context, { status: "probing", configured: true, ready: false, stale: false });
    }
    if (this.#healthCache?.key === context.cacheKey) {
      const checkedAt = this.#healthCache.snapshot.checkedAt;
      const stale = checkedAt === undefined || this.#now() - checkedAt >= this.#healthTtlMs;
      return { ...this.#healthCache.snapshot, stale };
    }
    return this.#baseHealth(context, { status: "configured-unverified", configured: true, ready: false, stale: false });
  }

  #baseHealth(
    context: HealthContext,
    state: Omit<HostAiHealthSnapshot, "provider" | "model" | "baseUrl">,
  ): HostAiHealthSnapshot {
    return {
      ...state,
      provider: context.provider,
      model: context.model,
      ...(context.baseUrl === undefined ? {} : { baseUrl: context.baseUrl }),
    };
  }

  async #probeProvider(context: HealthContext, signal?: AbortSignal): Promise<Response> {
    if (context.provider === "anthropic") {
      return this.#fetch(`${context.baseUrl}/v1/models/${encodeURIComponent(context.model)}`, {
        method: "GET",
        headers: { "x-api-key": context.apiKey ?? "", "anthropic-version": "2023-06-01" },
        signal,
      });
    }
    if (context.provider === "openai") {
      return this.#fetch(`${context.baseUrl}/models/${encodeURIComponent(context.model)}`, {
        method: "GET",
        headers: { authorization: `Bearer ${context.apiKey ?? ""}` },
        signal,
      });
    }
    return this.#fetch(`${context.baseUrl}/models`, { method: "GET", signal });
  }

  async #anthropicComplete(req: HostAiRequest, provider: ProviderContext, signal?: AbortSignal): Promise<HostAiResult> {
    const response = await this.#fetch(`${provider.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": provider.apiKey ?? "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: req.maxTokens ?? 1024,
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(req.system === undefined ? {} : { system: req.system }),
        messages: req.messages,
        ...(req.tools === undefined ? {} : { tools: req.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) }),
      }),
      signal,
    });
    if (!response.ok) throw new Error(`AI request failed with HTTP ${response.status}.`);
    const parsed = await readBoundedJson<{ content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> }>(response, "AI response", signal);
    const blocks = parsed.content ?? [];
    const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
    const toolCalls = blocks
      .filter((block) => block.type === "tool_use" && typeof block.name === "string")
      .map((block) => ({ name: block.name!, input: block.input ?? {} }));
    return { text, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
  }

  async #anthropicStream(req: HostAiRequest, provider: ProviderContext, onToken: (chunk: string) => void, signal?: AbortSignal): Promise<{ text: string }> {
    const response = await this.#fetch(`${provider.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": provider.apiKey ?? "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: req.maxTokens ?? 1024,
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(req.system === undefined ? {} : { system: req.system }),
        messages: req.messages,
        stream: true,
      }),
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`AI request failed with HTTP ${response.status}.`);
    let text = "";
    await readSseStream(response.body, (data) => {
      try {
        const event = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string } };
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          text += event.delta.text;
          onToken(event.delta.text);
        }
      } catch { /* keepalive/non-JSON lines */ }
    }, signal);
    return { text };
  }

  async #openAiComplete(req: HostAiRequest, provider: ProviderContext, signal?: AbortSignal): Promise<HostAiResult> {
    const response = await this.#fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
      body: JSON.stringify({
        model: provider.model,
        ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages],
        ...(req.tools === undefined ? {} : { tools: req.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) }),
      }),
      signal,
    });
    if (!response.ok) throw new Error(`AI request failed with HTTP ${response.status}.`);
    const parsed = await readBoundedJson<{ choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> }>(response, "AI response", signal);
    const message = parsed.choices?.[0]?.message;
    const toolCalls = (message?.tool_calls ?? []).flatMap((call) => {
      if (!call.function?.name) return [];
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(call.function.arguments ?? "{}") as Record<string, unknown>; } catch { /* leave empty */ }
      return [{ name: call.function.name, input }];
    });
    return { text: message?.content ?? "", ...(toolCalls.length > 0 ? { toolCalls } : {}) };
  }

  async #openAiStream(req: HostAiRequest, provider: ProviderContext, onToken: (chunk: string) => void, signal?: AbortSignal): Promise<{ text: string }> {
    const response = await this.#fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
      body: JSON.stringify({
        model: provider.model,
        ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages],
        stream: true,
      }),
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`AI request failed with HTTP ${response.status}.`);
    let text = "";
    await readSseStream(response.body, (data) => {
      if (data === "[DONE]") return;
      try {
        const event = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const token = event.choices?.[0]?.delta?.content;
        if (token) {
          text += token;
          onToken(token);
        }
      } catch { /* keepalive/non-JSON lines */ }
    }, signal);
    return { text };
  }
}

function effectiveBaseUrl(provider: ActiveProvider, baseUrl: string | undefined): string {
  if (baseUrl) return baseUrl.replace(/\/+$/, "");
  if (provider === "anthropic") return "https://api.anthropic.com";
  return provider === "ollama" ? "http://127.0.0.1:11434/v1" : "https://api.openai.com/v1";
}

function probeEvidence(provider: HostAiProviderKind): HostAiHealthEvidence {
  if (provider === "anthropic") return "anthropic-model";
  if (provider === "openai") return "openai-model";
  return "openai-compatible-models";
}

async function readBoundedJson<T>(response: Response, label: string, signal?: AbortSignal): Promise<T> {
  const body = response.body;
  if (!body) throw new Error(`${label} was empty.`);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxNonStreamJsonBytes) {
      await body.cancel().catch(() => undefined);
      throw new Error(`${label} is too large.`);
    }
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  const onAbort = () => { void reader.cancel(abortReason(signal)).catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) {
      await reader.cancel(abortReason(signal)).catch(() => undefined);
      throw abortReason(signal);
    }
    for (;;) {
      const chunk = await reader.read().catch((error: unknown) => {
        if (signal?.aborted) throw abortReason(signal);
        throw error;
      });
      throwIfAborted(signal);
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxNonStreamJsonBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} is too large.`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} was not valid JSON.`);
  }
}

async function readSseStream(body: ReadableStream<Uint8Array>, onData: (data: string) => void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  const onAbort = () => { void reader.cancel(abortReason(signal)).catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) {
      await reader.cancel(abortReason(signal)).catch(() => undefined);
      throw abortReason(signal);
    }
    for (;;) {
      const chunk = await reader.read().catch((error: unknown) => {
        if (signal?.aborted) throw abortReason(signal);
        throw error;
      });
      throwIfAborted(signal);
      const { done, value } = chunk;
      if (done) break;
      total += value.byteLength;
      if (total > 32 * 1024 * 1024) {
        await reader.cancel().catch(() => undefined);
        throw new Error("AI stream is too large.");
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) onData(trimmed.slice(5).trim());
      }
    }
    const trailing = buffer.trim();
    if (trailing.startsWith("data:")) onData(trailing.slice(5).trim());
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal | undefined): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}
