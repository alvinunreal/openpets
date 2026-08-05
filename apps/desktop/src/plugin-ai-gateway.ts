import { getPluginPlatformSettings } from "./plugin-platform-settings.js";
import type { PluginSecretsStore } from "./plugin-secrets.js";
import type { PluginAiRequest, PluginAiResult } from "./plugin-sdk-bridge.js";

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

export class PluginAiGateway {
  readonly #secrets: PluginSecretsStore;

  constructor(secrets: PluginSecretsStore) {
    this.#secrets = secrets;
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
  async transcribe(audio: Uint8Array, mimeType: string): Promise<string> {
    const { provider, baseUrl, apiKey } = await this.#resolveProvider();
    if (provider === "anthropic") throw new Error("Speech-to-text needs an OpenAI-compatible AI provider.");
    if (provider === "minimax") throw new Error("The configured MiniMax OpenAI-compatible provider/path does not support voice transcription in OpenPets. Choose a transcription-capable provider (OpenAI or Ollama) in OpenPets settings.");
    const url = `${openAiBase(baseUrl, provider)}/audio/transcriptions`;
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(audio)], { type: mimeType }), "speech.webm");
    form.append("model", "whisper-1");
    const response = await fetch(url, { method: "POST", headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, body: form });
    if (!response.ok) throw new Error(`Transcription failed with HTTP ${response.status}.`);
    const parsed = await response.json() as { text?: string };
    return typeof parsed.text === "string" ? parsed.text : "";
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
