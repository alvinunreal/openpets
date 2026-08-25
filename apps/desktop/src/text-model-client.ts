import type { PluginSecretsStore } from "./plugin-secrets.js";
import { HostProviderService, type HostProviderOperations, type ProviderOperationSnapshot } from "./provider-service.js";
import type {
  AssistantJsonObject,
  PetAssistantMessage,
  PetAssistantTextModel,
  PetAssistantTextModelRequest,
  PetAssistantTextModelResponse,
  PetAssistantToolCall,
} from "./pet-assistant-types.js";

export const TEXT_MODEL_DEFAULT_TIMEOUT_MS = 30_000;
export const TEXT_MODEL_MAX_REQUEST_BYTES = 256 * 1024;
export const TEXT_MODEL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type TextModelClientOptions = {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
};

export class TextModelClient implements PetAssistantTextModel {
  readonly #provider: HostProviderOperations;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  #snapshotPromise: Promise<ProviderOperationSnapshot> | null = null;

  constructor(secretsOrProvider: PluginSecretsStore | HostProviderOperations, options: TextModelClientOptions = {}) {
    this.#provider = "snapshot" in secretsOrProvider
      ? secretsOrProvider
      : new HostProviderService(secretsOrProvider, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), timeoutMs: options.timeoutMs });
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? TEXT_MODEL_DEFAULT_TIMEOUT_MS, "text model timeout");
    this.#maxRequestBytes = positiveInteger(options.maxRequestBytes ?? TEXT_MODEL_MAX_REQUEST_BYTES, "text model request limit");
    this.#maxResponseBytes = positiveInteger(options.maxResponseBytes ?? TEXT_MODEL_MAX_RESPONSE_BYTES, "text model response limit");
  }

  async generate(request: PetAssistantTextModelRequest, signal: AbortSignal): Promise<PetAssistantTextModelResponse> {
    validateRequest(request);
    const snapshot = this.#snapshotPromise ??= this.#provider.snapshot("text");
    const provider = await snapshot;
    const model = provider.profile.model;

    if (provider.profile.adapter === "anthropic-text") {
      const body = encodeAnthropicRequest(request, model);
      return decodeAnthropicResponse(await this.#request(provider, "/v1/messages", body, signal));
    }
    const body = encodeOpenAiRequest(request, model);
    return decodeOpenAiResponse(await this.#request(provider, "/chat/completions", body, signal));
  }

  async #request(snapshot: ProviderOperationSnapshot, path: string, body: AssistantJsonObject, signal: AbortSignal): Promise<unknown> {
    let serialized: string;
    try { serialized = JSON.stringify(body); } catch { throw new Error("Text model request is not JSON-compatible."); }
    if (byteLength(serialized) > this.#maxRequestBytes) throw new Error("Text model request is too large.");
    try { return await this.#provider.json(snapshot, path, body, signal, this.#maxResponseBytes); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code === "provider.cancelled") throw new Error("Text model request was cancelled.");
      if (code === "provider.timeout") throw new Error("Text model request timed out.");
      throw error;
    }
  }

  /** Pet Assistant calls this once per turn so settings edits cannot change a turn mid-loop. */
  async beginOperation(): Promise<TextModelClient> {
    const operation = new TextModelClient(this.#provider, { timeoutMs: this.#timeoutMs, maxRequestBytes: this.#maxRequestBytes, maxResponseBytes: this.#maxResponseBytes });
    operation.#snapshotPromise = this.#provider.snapshot("text");
    await operation.#snapshotPromise;
    return operation;
  }
}

export function createTextModelClient(secrets: PluginSecretsStore, options?: TextModelClientOptions): TextModelClient {
  return new TextModelClient(secrets, options);
}

function encodeOpenAiRequest(request: PetAssistantTextModelRequest, model: string): AssistantJsonObject {
  return {
    model,
    messages: request.messages.map((message) => encodeOpenAiMessage(message)),
    tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
  };
}

function encodeOpenAiMessage(message: PetAssistantMessage): AssistantJsonObject {
  if (message.role === "system" || message.role === "user") return { role: message.role, content: message.content };
  if (message.role === "assistant") return {
    role: "assistant",
    content: message.content ?? null,
    ...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}),
  };
  return { role: "tool", tool_call_id: message.toolCallId, name: message.name, content: JSON.stringify(message.result) };
}

function encodeAnthropicRequest(request: PetAssistantTextModelRequest, model: string): AssistantJsonObject {
  const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  return {
    model,
    max_tokens: 4096,
    ...(system ? { system } : {}),
    messages: request.messages.filter((message) => message.role !== "system").map(encodeAnthropicMessage),
    tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
  };
}

function encodeAnthropicMessage(message: Exclude<PetAssistantMessage, { readonly role: "system" }>): AssistantJsonObject {
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "assistant") return {
    role: "assistant",
    content: message.toolCalls
      ? [
        ...(message.content === undefined ? [] : [{ type: "text", text: message.content }]),
        ...message.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })),
      ]
      : message.content,
  };
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: JSON.stringify(message.result), ...(message.result.status === "completed" ? {} : { is_error: true }) }],
  };
}

function decodeOpenAiResponse(value: unknown): PetAssistantTextModelResponse {
  const root = record(value, "Text model returned an invalid OpenAI response.");
  if (!Array.isArray(root.choices) || root.choices.length !== 1) throw new Error("Text model returned an invalid OpenAI response.");
  const choice = record(root.choices[0], "Text model returned an invalid OpenAI choice.");
  const message = record(choice.message, "Text model returned an invalid OpenAI message.");
  if (message.content !== undefined && message.content !== null && typeof message.content !== "string") throw new Error("Text model returned invalid OpenAI message content.");
  const rawCalls = message.tool_calls;
  if (rawCalls !== undefined) {
    if (!Array.isArray(rawCalls) || rawCalls.length === 0) throw new Error("Text model returned invalid OpenAI tool calls.");
    return { type: "tool-calls", ...(message.content === undefined || message.content === null ? {} : { text: message.content }), toolCalls: decodeOpenAiToolCalls(rawCalls) };
  }
  if (typeof message.content !== "string" || message.content.trim() === "") throw new Error("Text model returned no assistant text.");
  return { type: "text", text: message.content };
}

function decodeOpenAiToolCalls(value: readonly unknown[]): readonly PetAssistantToolCall[] {
  const ids = new Set<string>();
  return value.map((entry) => {
    const call = record(entry, "Text model returned an invalid OpenAI tool call.");
    if (typeof call.id !== "string" || call.id.trim() === "" || ids.has(call.id)) throw new Error("Text model returned missing or duplicate tool-call ids.");
    const fn = record(call.function, "Text model returned an invalid OpenAI function call.");
    if (typeof fn.name !== "string" || fn.name.trim() === "" || typeof fn.arguments !== "string") throw new Error("Text model returned malformed tool-call arguments.");
    const args = parseArguments(fn.arguments);
    ids.add(call.id);
    return Object.freeze({ id: call.id, name: fn.name, arguments: args });
  });
}

function decodeAnthropicResponse(value: unknown): PetAssistantTextModelResponse {
  const root = record(value, "Text model returned an invalid Anthropic response.");
  if (!Array.isArray(root.content) || root.content.length === 0) throw new Error("Text model returned an invalid Anthropic response.");
  let text = "";
  let hasText = false;
  const calls: PetAssistantToolCall[] = [];
  const ids = new Set<string>();
  for (const entry of root.content) {
    const block = record(entry, "Text model returned an invalid Anthropic content block.");
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new Error("Text model returned malformed Anthropic text.");
      hasText = true;
      text += block.text;
    } else if (block.type === "tool_use") {
      if (typeof block.id !== "string" || block.id.trim() === "" || ids.has(block.id) || typeof block.name !== "string" || block.name.trim() === "") throw new Error("Text model returned missing or duplicate tool-call ids.");
      if (!isPlainObject(block.input)) throw new Error("Text model returned malformed tool-call arguments.");
      ids.add(block.id);
      calls.push(Object.freeze({ id: block.id, name: block.name, arguments: cloneAndFreeze(block.input) }));
    } else {
      throw new Error("Text model returned an unsupported Anthropic content block.");
    }
  }
  if (calls.length > 0) return { type: "tool-calls", ...(hasText ? { text } : {}), toolCalls: Object.freeze(calls) };
  if (text.trim() === "") throw new Error("Text model returned no assistant text.");
  return { type: "text", text };
}

function validateRequest(request: PetAssistantTextModelRequest): void {
  if (!request || !Array.isArray(request.messages) || !Array.isArray(request.tools)) throw new Error("Text model request is malformed.");
  for (const message of request.messages) {
    if (!message || typeof message !== "object") throw new Error("Text model request contains a malformed message.");
    if (message.role === "system" || message.role === "user") {
      if (typeof message.content !== "string") throw new Error("Text model request contains malformed message content.");
    } else if (message.role === "assistant") {
      if (message.content !== undefined && typeof message.content !== "string") throw new Error("Text model request contains malformed assistant content.");
      const ids = new Set<string>();
      for (const call of message.toolCalls ?? []) validateCall(call, ids);
    } else if (message.role === "tool") {
      if (typeof message.toolCallId !== "string" || message.toolCallId.trim() === "" || typeof message.name !== "string" || message.name.trim() === "") throw new Error("Text model request contains malformed tool result.");
      if (!isJsonObject(message.result)) throw new Error("Text model request contains malformed tool result.");
    } else throw new Error("Text model request contains an unsupported message role.");
  }
  for (const tool of request.tools) {
    if (!tool || typeof tool.name !== "string" || tool.name.trim() === "" || typeof tool.description !== "string" || !isJsonObject(tool.inputSchema)) throw new Error("Text model request contains a malformed tool.");
  }
}

function validateCall(call: PetAssistantToolCall, ids: Set<string>): void {
  if (!call || typeof call.id !== "string" || call.id.trim() === "" || ids.has(call.id) || typeof call.name !== "string" || call.name.trim() === "" || !isJsonObject(call.arguments)) throw new Error("Text model request contains malformed or duplicate tool calls.");
  ids.add(call.id);
}

function parseArguments(value: string): AssistantJsonObject {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("Text model returned malformed tool-call arguments."); }
  if (!isPlainObject(parsed)) throw new Error("Text model returned malformed tool-call arguments.");
  return cloneAndFreeze(parsed);
}

function record(value: unknown, message: string): Record<string, any> {
  if (!isPlainObject(value)) throw new Error(message);
  return value as Record<string, any>;
}

function isJsonObject(value: unknown): value is AssistantJsonObject {
  if (!isPlainObject(value)) return false;
  return isStrictJsonValue(value);
}

function isStrictJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isStrictJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isStrictJsonValue);
}

function isPlainObject(value: unknown): value is AssistantJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneAndFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map((child) => cloneAndFreeze(child))) as T;
  const clone: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) clone[key] = cloneAndFreeze(child);
  return Object.freeze(clone) as T;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Text model response is too large.");
  if (!response.body) throw new Error("Text model returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error("Text model response is too large."); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function byteLength(value: string): number { return Buffer.byteLength(value, "utf8"); }

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${label}.`);
  return value;
}
