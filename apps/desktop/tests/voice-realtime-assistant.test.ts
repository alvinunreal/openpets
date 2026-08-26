import assert from "node:assert/strict";

import { PetAssistantConversationController, PET_ASSISTANT_CONVERSATION_ID } from "../src/pet-assistant-conversation.js";
import { PetAssistantModalityCoordinator } from "../src/pet-assistant-modality.js";
import { PetAssistantService } from "../src/pet-assistant-service.js";
import { petAssistantToolName } from "../src/pet-assistant-tools.js";
import type { PetAssistantCapabilityRuntime, PetAssistantGenerationHandle, PetAssistantTextModel } from "../src/pet-assistant-types.js";
import type { HostProviderOperations, ProviderOperationSnapshot } from "../src/provider-service.js";
import { VoiceMicrophoneArbiter } from "../src/voice-microphone-arbiter.js";
import { VoicePrivacyIndicator, type VoicePrivacyIndicatorSurface } from "../src/voice-privacy-indicator.js";
import { OpenAIRealtimeVoiceAssistantSession, buildOpenAIRealtimeSessionConfig } from "../src/voice-realtime-assistant.js";
import { createOpenAIRealtimeToolResultEvents, parseStrictJsonObject } from "../src/voice-realtime-protocol.js";
import type { VoiceConversationEvent, VoiceConversationTransport, VoiceConversationTransportContext } from "../src/voice-conversation.js";

class Surface implements VoicePrivacyIndicatorSurface {
  show(): void {}
  hide(): void {}
  destroy(): void {}
}

class Transport implements VoiceConversationTransport {
  readonly context: VoiceConversationTransportContext;
  readonly sent: string[] = [];
  closeCount = 0;

  constructor(context: VoiceConversationTransportContext) { this.context = context; }
  async start(): Promise<void> {
    this.context.emit({ type: "microphone-acquired" });
    this.context.emit({ type: "negotiating" });
    this.context.emit({ type: "connected" });
  }
  setMuted(): void {}
  async close(): Promise<void> { this.closeCount += 1; }
  async sendToolResult(command: { readonly callId: string; readonly result: unknown }): Promise<void> {
    this.sent.push(JSON.stringify(command));
  }
  emit(event: VoiceConversationEvent): void { this.context.emit(event); }
}

const handle = { generation: 1 } as PetAssistantGenerationHandle;
const capability = { pluginId: "focus.buddy", capability: { id: "start", description: "Start focus", inputSchema: { type: "object" } }, handle };
const toolName = petAssistantToolName("focus.buddy", "start");

function provider(): HostProviderOperations {
  const snapshot: ProviderOperationSnapshot = { role: "realtime", profile: { id: "native", label: "Native", adapter: "openai-realtime", model: "gpt-realtime-2.1", baseUrl: "https://api.openai.com/v1" } };
  return {
    snapshot: async () => snapshot,
    negotiateRealtime: async () => "v=0\r\no=answer",
  } as unknown as HostProviderOperations;
}

function model(): PetAssistantTextModel { return { generate: async () => ({ type: "text", text: "unused" }) }; }

async function flush(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function fixture(options: { readonly runtime?: PetAssistantCapabilityRuntime } = {}) {
  const runtime = options.runtime ?? { snapshot: () => ({ capabilities: [capability] }), execute: async () => ({ ok: true, result: { started: true } }) };
  const assistant = new PetAssistantService(model(), runtime);
  const surface = new Surface();
  const indicator = new VoicePrivacyIndicator(() => surface);
  const transports: Transport[] = [];
  const session = new OpenAIRealtimeVoiceAssistantSession({
    provider: provider(),
    assistant,
    microphoneArbiter: new VoiceMicrophoneArbiter(),
    privacyIndicator: indicator,
    modalityCoordinator: new PetAssistantModalityCoordinator(),
    transportFactory: () => (context) => {
      const transport = new Transport(context);
      transports.push(transport);
      return transport;
    },
  });
  return { assistant, session, transports, indicator };
}

// Canonical tools are translated to the current Realtime schema, including the deliberate empty-tool mode.
{
  const noTools = buildOpenAIRealtimeSessionConfig("gpt-realtime-2.1", { instructions: "rules", tools: [] });
  assert.deepEqual(noTools.tools, []);
  assert.equal(noTools.tool_choice, "none");
  const withTools = buildOpenAIRealtimeSessionConfig("gpt-realtime-2.1", { instructions: "rules", tools: [{ name: "op_tool", description: "Tool", inputSchema: { type: "object" } }] });
  assert.deepEqual(withTools.tools, [{ type: "function", name: "op_tool", description: "Tool", parameters: { type: "object" } }]);
  assert.equal(withTools.tool_choice, "auto");
}

// Tool output uses function_call_output followed by response.create, preserving structured status.
{
  const events = createOpenAIRealtimeToolResultEvents("call_1", { status: "rejected", reason: "missing", missingInformation: true });
  assert.deepEqual(events.map((event) => JSON.parse(event).type), ["conversation.item.create", "response.create"]);
  assert.equal(JSON.parse(events[0]!).item.output, JSON.stringify({ status: "rejected", reason: "missing", missingInformation: true }));
  assert.equal(parseStrictJsonObject("[]"), null);
  assert.equal(parseStrictJsonObject("not-json"), null);
}

// A valid provider function call executes once through PetAssistantService and projects a truthful action result.
{
  let executions = 0;
  const current = fixture({ runtime: { snapshot: () => ({ capabilities: [capability] }), execute: async () => { executions += 1; return { ok: true, result: { started: true } }; } } });
  const projection = new PetAssistantConversationController(current.assistant);
  current.session.subscribe((event) => {
    if (event.type === "transcript") projection.applyNormalizedVoiceTranscript({ type: "transcript", sequence: event.sequence, conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: event.turnId, entryId: `entry-${event.sequence}`, speaker: event.speaker, text: event.text, status: event.kind });
  });
  await current.session.start();
  const transport = current.transports[0]!;
  transport.emit({ type: "speech-started" });
  transport.emit({ type: "transcript", entryId: "input-1", speaker: "user", status: "final", text: "Start focus" });
  transport.emit({ type: "tool-call", callId: "call_1", name: toolName, arguments: JSON.stringify({ minutes: 25 }) });
  transport.emit({ type: "response-completed" });
  await flush();
  assert.equal(executions, 1);
  assert.match(transport.sent[0] ?? "", /completed/);
  transport.emit({ type: "transcript", entryId: "output-1", speaker: "assistant", status: "final", text: "Focus started." });
  transport.emit({ type: "response-completed" });
  await flush();
  const action = projection.getSnapshot().items.find((item) => item.kind === "action");
  assert.equal(action?.kind === "action" ? action.status : "missing", "completed");
  await current.session.end();
  projection.dispose();
  await current.assistant.stop();
}

// Malformed, non-object, and unknown calls never execute and preserve unavailable/rejected outcomes.
{
  let executions = 0;
  const current = fixture({ runtime: { snapshot: () => ({ capabilities: [capability] }), execute: async () => { executions += 1; return { ok: true, result: {} }; } } });
  await current.session.start();
  const transport = current.transports[0]!;
  transport.emit({ type: "speech-started" });
  transport.emit({ type: "tool-call", callId: "bad_json", name: toolName, arguments: "{bad" });
  transport.emit({ type: "tool-call", callId: "array_args", name: toolName, arguments: "[]" });
  transport.emit({ type: "tool-call", callId: "unknown", name: "op_missing", arguments: "{}" });
  await flush();
  assert.equal(executions, 0);
  assert.match(current.transports[0]?.sent.join(" ") ?? "", /rejected/);
  assert.match(current.transports[0]?.sent.join(" ") ?? "", /unavailable/);
  await current.session.end();
  await current.assistant.stop();
}

// Duplicate completion and stale events are ignored; an interrupted side effect remains indeterminate and cannot enter a new session.
{
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const runtime: PetAssistantCapabilityRuntime = {
    snapshot: () => ({ capabilities: [capability] }),
    execute: async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); return { ok: true, result: {} }; },
  };
  const current = fixture({ runtime });
  await current.session.start();
  const oldTransport = current.transports[0]!;
  oldTransport.emit({ type: "speech-started" });
  oldTransport.emit({ type: "tool-call", callId: "running", name: toolName, arguments: "{}" });
  await startedPromise;
  await current.session.interrupt();
  release();
  await flush();
  assert.equal(current.transports[0]?.sent.some((value) => value.includes("running")), false, "late result must not be sent after interruption");
  oldTransport.emit({ type: "tool-call", callId: "running", name: toolName, arguments: "{}" });
  assert.equal(current.transports[0]?.sent.length, 0);
  await current.session.end();
  assert.equal(oldTransport.closeCount, 1);
  await current.assistant.stop();
}

console.log("OpenAI Realtime Pet Assistant adapter tests passed.");
