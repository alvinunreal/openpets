import type { PluginAiRequest, PluginAiResult } from "./plugin-sdk-bridge.js";
import { HostProviderService, type HostProviderOperations, type ProviderOperationSnapshot } from "./provider-service.js";
import type { PluginSecretsStore } from "./plugin-secrets.js";
import type { VoiceRealtimeSessionConfig } from "./voice-conversation.js";

export const minimaxSpeechModels = ["speech-2.8-hd", "speech-2.8-turbo", "speech-2.6-hd", "speech-2.6-turbo", "speech-02-hd", "speech-02-turbo", "speech-01-hd", "speech-01-turbo"] as const;
export const defaultMinimaxSpeechVoiceId = "English_expressive_narrator";
export const VOICE_REALTIME_MAX_SDP_BYTES = 256 * 1024;
export const VOICE_REALTIME_MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
export const VOICE_REALTIME_NEGOTIATION_TIMEOUT_MS = 30_000;
export type SynthesizedSpeech = { readonly bytes: Uint8Array; readonly mimeType: "audio/mpeg" };
export type PluginAiGatewayOptions = { readonly realtimeNegotiationTimeoutMs?: number; readonly provider?: HostProviderOperations };

/** Compatibility-neutral facade for the plugin SDK and voice lifecycle. */
export class PluginAiGateway {
  readonly #provider: HostProviderOperations;

  constructor(secretsOrProvider: PluginSecretsStore | HostProviderOperations, options: PluginAiGatewayOptions = {}) {
    this.#provider = options.provider ?? ("snapshot" in secretsOrProvider ? secretsOrProvider : new HostProviderService(secretsOrProvider, { timeoutMs: options.realtimeNegotiationTimeoutMs ?? VOICE_REALTIME_NEGOTIATION_TIMEOUT_MS }));
  }

  async available(): Promise<boolean> { try { await this.#provider.snapshot("text"); return true; } catch { return false; } }

  async complete(req: PluginAiRequest): Promise<PluginAiResult> {
    const snapshot = await this.#provider.snapshot("text");
    return completeWithSnapshot(this.#provider, snapshot, req);
  }

  async stream(req: PluginAiRequest, onToken: (chunk: string) => void): Promise<{ text: string }> {
    const snapshot = await this.#provider.snapshot("text");
    return streamWithSnapshot(this.#provider, snapshot, req, onToken);
  }

  async transcribe(audio: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<string> {
    return this.#provider.transcribe(await this.#provider.snapshot("stt"), audio, mimeType, signal);
  }

  async beginTranscriptionOperation(): Promise<(audio: Uint8Array, mimeType: string, signal?: AbortSignal) => Promise<string>> {
    const snapshot = await this.#provider.snapshot("stt");
    return (audio, mimeType, signal) => this.#provider.transcribe(snapshot, audio, mimeType, signal);
  }

  async negotiateRealtime(sdp: string, session: VoiceRealtimeSessionConfig, signal?: AbortSignal): Promise<string> {
    return (await this.beginRealtimeOperation())(sdp, session, signal);
  }

  async beginRealtimeOperation(): Promise<(sdp: string, session: VoiceRealtimeSessionConfig, signal?: AbortSignal) => Promise<string>> {
    const snapshot = await this.#provider.snapshot("realtime");
    return async (sdp, session, signal) => {
    const offer = validateRealtimeSdp(sdp, "Voice realtime offer");
    const serialized = JSON.stringify(session);
    if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) throw new Error("Voice realtime session configuration is too large.");
    const answer = await this.#provider.negotiateRealtime(snapshot, offer, session, signal);
    return validateRealtimeSdp(answer, "OpenAI realtime answer");
    };
  }

  async synthesizeSpeech(text: string, opts: { voice?: string; rate?: number }): Promise<SynthesizedSpeech | null> {
    return this.#provider.synthesize(await this.#provider.snapshot("tts"), text, opts);
  }

  /** Voice and SDK operations use a fresh facade, while the provider operation snapshots at call start. */
  beginOperation(): PluginAiGateway { return new PluginAiGateway(this.#provider); }
}

async function completeWithSnapshot(provider: HostProviderOperations, snapshot: ProviderOperationSnapshot, req: PluginAiRequest): Promise<PluginAiResult> {
  const body = {
    model: snapshot.profile.model,
    ...(snapshot.profile.adapter === "anthropic-text" ? {
      max_tokens: req.maxTokens ?? 1024,
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      ...(req.system === undefined ? {} : { system: req.system }),
      messages: req.messages,
      ...(req.tools === undefined ? {} : { tools: req.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) }),
    } : {
      ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }),
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages],
      ...(req.tools === undefined ? {} : { tools: req.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) }),
    }),
  };
  const path = snapshot.profile.adapter === "anthropic-text" ? "/v1/messages" : "/chat/completions";
  const parsed = await provider.json(snapshot, path, body);
  if (snapshot.profile.adapter === "anthropic-text") {
    const content = (parsed as { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> }).content ?? [];
    return { text: content.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""), ...toolCalls(content.filter((block) => block.type === "tool_use").map((block) => ({ name: block.name, input: block.input }))) };
  }
  const message = (parsed as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> }).choices?.[0]?.message;
  const calls = (message?.tool_calls ?? []).flatMap((call) => { if (!call.function?.name) return []; let input: Record<string, unknown> = {}; try { input = JSON.parse(call.function.arguments ?? "{}"); } catch { /* malformed provider arguments become an empty object for SDK compatibility */ } return [{ name: call.function.name, input }]; });
  return { text: message?.content ?? "", ...(calls.length ? { toolCalls: calls } : {}) };
}

async function streamWithSnapshot(provider: HostProviderOperations, snapshot: ProviderOperationSnapshot, req: PluginAiRequest, onToken: (chunk: string) => void): Promise<{ text: string }> {
  let text = "";
  const body = snapshot.profile.adapter === "anthropic-text"
    ? { model: snapshot.profile.model, max_tokens: req.maxTokens ?? 1024, ...(req.system ? { system: req.system } : {}), messages: req.messages }
    : { model: snapshot.profile.model, ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }), ...(req.system ? { messages: [{ role: "system", content: req.system }, ...req.messages] } : { messages: req.messages }) };
  await provider.stream(snapshot, snapshot.profile.adapter === "anthropic-text" ? "/v1/messages" : "/chat/completions", body, (data) => {
    if (data === "[DONE]") return;
    try { const event = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string }; choices?: Array<{ delta?: { content?: string } }> }; const token = snapshot.profile.adapter === "anthropic-text" ? event.delta?.text : event.choices?.[0]?.delta?.content; if (token) { text += token; onToken(token); } } catch { /* ignore keepalive lines */ }
  });
  return { text };
}

function toolCalls(value: Array<{ name?: string; input?: Record<string, unknown> }>): { toolCalls: Array<{ name: string; input: Record<string, unknown> }> } | Record<string, never> { const calls = value.flatMap((call) => typeof call.name === "string" && call.name ? [{ name: call.name, input: call.input ?? {} }] : []); return calls.length ? { toolCalls: calls } : {}; }
function validateRealtimeSdp(value: unknown, label: string): string { if (typeof value !== "string") throw new Error(`${label} is invalid.`); const sdp = value.trim(); if (!sdp || sdp.includes("\0") || !/^v=0(?:\r?\n|$)/.test(sdp) || Buffer.byteLength(sdp, "utf8") > VOICE_REALTIME_MAX_SDP_BYTES) throw new Error(`${label} is invalid.`); return sdp; }
