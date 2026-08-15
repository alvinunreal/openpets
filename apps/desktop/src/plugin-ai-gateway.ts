import { getPluginPlatformSettings } from "./plugin-platform-settings.js";
import type { PluginSecretsStore } from "./plugin-secrets.js";
import type { PluginAiRequest, PluginAiResult } from "./plugin-sdk-bridge.js";
import type { VoiceRealtimeSessionConfig } from "./voice-conversation.js";

/**
 * Host AI gateway (§13.2): one user-configured provider/model serves every
 * plugin. Keys live in the encrypted host secrets store, never in plugin
 * code. Supports Anthropic, OpenAI, Ollama, and MiniMax (OpenAI-compatible)
 * backends, including function-calling tools and token streaming.
 */

export const hostSecretsOwner = "__openpets-host";
export const hostAiApiKeySecret = "ai-api-key";

const defaultModels: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  ollama: "llama3.2",
  minimax: "MiniMax-M3",
};

export const minimaxSpeechModels = [
  "speech-2.8-hd",
  "speech-2.8-turbo",
  "speech-2.6-hd",
  "speech-2.6-turbo",
  "speech-02-hd",
  "speech-02-turbo",
  "speech-01-hd",
  "speech-01-turbo",
] as const;

export const defaultMinimaxSpeechVoiceId = "English_expressive_narrator";

export const VOICE_REALTIME_MAX_SDP_BYTES = 256 * 1024;
export const VOICE_REALTIME_MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
export const VOICE_REALTIME_NEGOTIATION_TIMEOUT_MS = 30_000;

export type SynthesizedSpeech = { readonly bytes: Uint8Array; readonly mimeType: "audio/mpeg" };

export type PluginAiGatewayOptions = {
  readonly realtimeNegotiationTimeoutMs?: number;
};

export class PluginAiGateway {
  readonly #secrets: PluginSecretsStore;
  readonly #realtimeNegotiationTimeoutMs: number;

  constructor(secrets: PluginSecretsStore, options: PluginAiGatewayOptions = {}) {
    this.#secrets = secrets;
    this.#realtimeNegotiationTimeoutMs = options.realtimeNegotiationTimeoutMs ?? VOICE_REALTIME_NEGOTIATION_TIMEOUT_MS;
  }

  async available(): Promise<boolean> {
    const settings = getPluginPlatformSettings().ai;
    if (settings.provider === "none") return false;
    if (settings.provider === "ollama") return true;
    return (await this.#secrets.get(hostSecretsOwner, hostAiApiKeySecret)) !== undefined;
  }

  async complete(req: PluginAiRequest): Promise<PluginAiResult> {
    const { provider, model, baseUrl, apiKey } = await this.#resolveProvider();
    if (provider === "anthropic") return this.#anthropicComplete(req, model, apiKey, baseUrl);
    return this.#openAiComplete(req, model, apiKey, baseUrl, provider);
  }

  async stream(req: PluginAiRequest, onToken: (chunk: string) => void): Promise<{ text: string }> {
    const { provider, model, baseUrl, apiKey } = await this.#resolveProvider();
    if (provider === "anthropic") return this.#anthropicStream(req, model, apiKey, baseUrl, onToken);
    return this.#openAiStream(req, model, apiKey, baseUrl, provider, onToken);
  }

  /** One-shot audio transcription backing voice.listen (OpenAI-compatible only). */
  async transcribe(audio: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<string> {
    const { provider, baseUrl, apiKey } = await this.#resolveProvider();
    if (provider === "anthropic") throw new Error("Speech-to-text needs an OpenAI-compatible AI provider.");
    if (provider === "minimax") throw new Error("The configured MiniMax OpenAI-compatible provider/path does not support voice transcription in OpenPets. Choose a transcription-capable provider (OpenAI or Ollama) in OpenPets settings.");
    const url = `${openAiBase(baseUrl, provider)}/audio/transcriptions`;
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(audio)], { type: mimeType }), `speech.${audioFileExtension(mimeType)}`);
    form.append("model", "whisper-1");
    const response = await fetch(url, { method: "POST", headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, body: form, ...(signal ? { signal } : {}) });
    if (!response.ok) throw new Error(`Transcription failed with HTTP ${response.status}.`);
    const parsed = await response.json() as { text?: string };
    return typeof parsed.text === "string" ? parsed.text : "";
  }

  /** Host-private SDP negotiation for the realtime conversation foundation. */
  async negotiateRealtime(sdp: string, session: VoiceRealtimeSessionConfig, signal?: AbortSignal): Promise<string> {
    if (getPluginPlatformSettings().ai.provider !== "openai") {
      throw new Error("Realtime voice currently requires the OpenAI provider.");
    }
    const offer = validateRealtimeSdp(sdp, "Voice realtime offer");
    let serializedSession: string;
    try {
      serializedSession = JSON.stringify(session);
    } catch {
      throw new Error("Voice realtime session configuration is invalid.");
    }
    if (Buffer.byteLength(serializedSession, "utf8") > 64 * 1024) throw new Error("Voice realtime session configuration is too large.");
    const apiKey = await this.#secrets.get(hostSecretsOwner, hostAiApiKeySecret);
    if (!apiKey) throw new Error("The configured OpenAI provider has no API key.");

    const body = new FormData();
    body.set("sdp", offer);
    body.set("session", serializedSession);
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) throw new Error("Voice realtime negotiation was cancelled.");
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.#realtimeNegotiationTimeoutMs);
    try {
      const response = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      const responseText = await readBoundedResponseText(response, VOICE_REALTIME_MAX_PROVIDER_RESPONSE_BYTES);
      if (!response.ok) throw new Error(`OpenAI realtime negotiation failed with HTTP ${response.status}.`);
      return validateRealtimeSdp(responseText, "OpenAI realtime answer");
    } catch (error) {
      if (controller.signal.aborted) {
        if (signal?.aborted) throw new Error("Voice realtime negotiation was cancelled.");
        throw new Error("Voice realtime negotiation timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  /** Synthesize plugin speech when MiniMax is the configured provider. */
  async synthesizeSpeech(text: string, opts: { voice?: string; rate?: number }): Promise<SynthesizedSpeech | null> {
    const settings = getPluginPlatformSettings().ai;
    if (settings.provider !== "minimax") return null;
    const { baseUrl, apiKey } = await this.#resolveProvider();
    const configuredModel = settings.speechModel;
    const model = configuredModel && minimaxSpeechModels.includes(configuredModel as typeof minimaxSpeechModels[number])
      ? configuredModel
      : minimaxSpeechModels[0];
    const voiceSetting = {
      voice_id: opts.voice || defaultMinimaxSpeechVoiceId,
      ...(opts.rate === undefined ? {} : { speed: opts.rate }),
    };
    const response = await fetch(`${openAiBase(baseUrl, "minimax")}/t2a_v2`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey ?? ""}` },
      body: JSON.stringify({
        model,
        text,
        stream: false,
        output_format: "hex",
        audio_setting: { format: "mp3" },
        ...(voiceSetting ? { voice_setting: voiceSetting } : {}),
      }),
    });
    if (!response.ok) throw new Error(`Speech synthesis failed with HTTP ${response.status}.`);
    const parsed = await response.json() as { data?: { audio?: string; status?: number } | null; base_resp?: { status_code?: number; status_msg?: string } };
    if (parsed.base_resp?.status_code !== undefined && parsed.base_resp.status_code !== 0) {
      throw new Error(`Speech synthesis failed: ${parsed.base_resp.status_msg || `status ${parsed.base_resp.status_code}`}.`);
    }
    const hex = parsed.data?.audio;
    if (parsed.data?.status !== 2 || typeof hex !== "string" || hex.length === 0 || hex.length > 64 * 1024 * 1024 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
      throw new Error("Speech synthesis returned invalid audio data.");
    }
    return { bytes: Buffer.from(hex, "hex"), mimeType: "audio/mpeg" };
  }

  async #resolveProvider(): Promise<{ provider: "anthropic" | "openai" | "ollama" | "minimax"; model: string; baseUrl?: string; apiKey?: string }> {
    const settings = getPluginPlatformSettings().ai;
    if (settings.provider === "none") throw new Error("No AI provider is configured in OpenPets settings.");
    const apiKey = await this.#secrets.get(hostSecretsOwner, hostAiApiKeySecret);
    if (settings.provider !== "ollama" && !apiKey) throw new Error("The configured AI provider has no API key.");
    return {
      provider: settings.provider,
      model: settings.model || defaultModels[settings.provider] || "",
      baseUrl: settings.baseUrl,
      apiKey,
    };
  }

  async #anthropicComplete(req: PluginAiRequest, model: string, apiKey: string | undefined, baseUrl: string | undefined): Promise<PluginAiResult> {
    const response = await fetch(`${baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 1024,
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(req.system === undefined ? {} : { system: req.system }),
        messages: req.messages,
        ...(req.tools === undefined ? {} : { tools: req.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) }),
      }),
    });
    if (!response.ok) throw new Error(`AI request failed with HTTP ${response.status}.`);
    const parsed = await response.json() as { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> };
    const blocks = parsed.content ?? [];
    const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
    const toolCalls = blocks.filter((block) => block.type === "tool_use" && typeof block.name === "string").map((block) => ({ name: block.name!, input: block.input ?? {} }));
    return { text, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
  }

  async #anthropicStream(req: PluginAiRequest, model: string, apiKey: string | undefined, baseUrl: string | undefined, onToken: (chunk: string) => void): Promise<{ text: string }> {
    const response = await fetch(`${baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 1024,
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(req.system === undefined ? {} : { system: req.system }),
        messages: req.messages,
        stream: true,
      }),
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
    });
    return { text };
  }

  async #openAiComplete(req: PluginAiRequest, model: string, apiKey: string | undefined, baseUrl: string | undefined, provider: "openai" | "ollama" | "minimax"): Promise<PluginAiResult> {
    const response = await fetch(`${openAiBase(baseUrl, provider)}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages],
        ...(req.tools === undefined ? {} : { tools: req.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) }),
      }),
    });
    if (!response.ok) throw new Error(`AI request failed with HTTP ${response.status}.`);
    const parsed = await response.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> };
    const message = parsed.choices?.[0]?.message;
    const toolCalls = (message?.tool_calls ?? []).flatMap((call) => {
      if (!call.function?.name) return [];
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(call.function.arguments ?? "{}") as Record<string, unknown>; } catch { /* leave empty */ }
      return [{ name: call.function.name, input }];
    });
    return { text: message?.content ?? "", ...(toolCalls.length > 0 ? { toolCalls } : {}) };
  }

  async #openAiStream(req: PluginAiRequest, model: string, apiKey: string | undefined, baseUrl: string | undefined, provider: "openai" | "ollama" | "minimax", onToken: (chunk: string) => void): Promise<{ text: string }> {
    const response = await fetch(`${openAiBase(baseUrl, provider)}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages],
        stream: true,
      }),
    });
    if (!response.ok || !response.body) throw new Error(`AI request failed with HTTP ${response.status}.`);
    let text = "";
    await readSseStream(response.body, (data) => {
      if (data === "[DONE]") return;
      try {
        const event = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const token = event.choices?.[0]?.delta?.content;
        if (token) { text += token; onToken(token); }
      } catch { /* keepalive/non-JSON lines */ }
    });
    return { text };
  }
}

function audioFileExtension(mimeType: string): string {
  const baseType = mimeType.toLowerCase().split(";", 1)[0] ?? "";
  if (baseType.includes("ogg")) return "ogg";
  if (baseType.includes("wav")) return "wav";
  if (baseType.includes("mp4")) return "mp4";
  return "webm";
}

function openAiBase(baseUrl: string | undefined, provider: "openai" | "ollama" | "minimax"): string {
  if (baseUrl) return baseUrl.replace(/\/$/, "");
  if (provider === "ollama") return "http://127.0.0.1:11434/v1";
  if (provider === "minimax") return "https://api.minimax.io/v1";
  return "https://api.openai.com/v1";
}

async function readSseStream(body: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 32 * 1024 * 1024) { await reader.cancel().catch(() => undefined); throw new Error("AI stream is too large."); }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) onData(trimmed.slice(5).trim());
    }
  }
}

function validateRealtimeSdp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const sdp = value.trim();
  if (sdp.length === 0 || sdp.includes("\0") || !/^v=0(?:\r?\n|$)/.test(sdp) || Buffer.byteLength(sdp, "utf8") > VOICE_REALTIME_MAX_SDP_BYTES) {
    throw new Error(`${label} is invalid.`);
  }
  return sdp;
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("OpenAI realtime response is too large.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("OpenAI realtime response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
