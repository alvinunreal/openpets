import assert from "node:assert/strict";

import {
  MAX_CONVERSATION_MESSAGE_BYTES,
  MAX_CONVERSATION_ITEMS,
  PET_ASSISTANT_CONVERSATION_ID,
  PetAssistantConversationController,
  PetAssistantConversationProjection,
  validateConversationMessageInput,
  type PetAssistantNormalizedVoiceTranscriptEvent,
} from "../src/pet-assistant-conversation.js";
import { PetAssistantService } from "../src/pet-assistant-service.js";
import { petAssistantToolName } from "../src/pet-assistant-tools.js";
import type { PetAssistantCapabilityRuntime, PetAssistantGenerationHandle, PetAssistantTextModelResponse } from "../src/pet-assistant-types.js";
import { applyConversationEvent, applyConversationSnapshot, emptyConversationSnapshot } from "../src/renderer/src/conversation/conversation-state.js";

const handle = { generation: 1 } as PetAssistantGenerationHandle;
const capability = { pluginId: "focus.buddy", capability: { id: "start", description: "Start focus", inputSchema: { type: "object" } }, handle };

function createService(responses: readonly PetAssistantTextModelResponse[], runtime: PetAssistantCapabilityRuntime = { snapshot: () => ({ capabilities: [] }), execute: async () => ({ ok: true, result: {} }) }): PetAssistantService {
  let index = 0;
  return new PetAssistantService({ generate: () => responses[index++] ?? { type: "text", text: "fallback" } }, runtime);
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

// Typed turns use one stable conversation id and project only display-safe messages.
{
  const service = createService([{ type: "text", text: "Hello from the pet." }]);
  const controller = new PetAssistantConversationController(service);
  const result = await controller.sendTypedMessage("Hello");
  assert.equal(result.conversationId, PET_ASSISTANT_CONVERSATION_ID);
  assert.deepEqual(controller.getSnapshot().items, [
    { kind: "message", id: "message:turn-1:2", turnId: "turn-1", role: "user", source: "typed", text: "Hello" },
    { kind: "message", id: "message:turn-1:5", turnId: "turn-1", role: "assistant", source: "typed", text: "Hello from the pet." },
  ]);
  assert.equal(controller.getSnapshot().terminal?.status, "completed");
  controller.dispose();
  await service.stop();
}

// Capability activity is summarized without leaking the structured capability result.
{
  const service = createService([
    { type: "tool-calls", toolCalls: [{ id: "focus-call", name: petAssistantToolName("focus.buddy", "start"), arguments: { minutes: 25 } }] },
    { type: "text", text: "Focus started." },
  ], {
    snapshot: () => ({ capabilities: [capability] }),
    execute: async () => ({ ok: true, result: { privatePluginPayload: "not projected" } }),
  });
  const controller = new PetAssistantConversationController(service);
  await controller.sendTypedMessage("Start focus.");
  const action = controller.getSnapshot().items.find((item) => item.kind === "action");
  assert.deepEqual(action, {
    kind: "action",
    id: "focus-call",
    turnId: "turn-1",
    toolName: petAssistantToolName("focus.buddy", "start"),
    status: "completed",
  });
  assert.equal(JSON.stringify(controller.getSnapshot()).includes("privatePluginPayload"), false);
  controller.dispose();
  await service.stop();
}

// Provider and capability failure details never cross the display projection.
{
  const service = createService([
    { type: "tool-calls", toolCalls: [{ id: "secret-call", name: petAssistantToolName("focus.buddy", "start"), arguments: {} }] },
    { type: "text", text: "Done." },
  ], {
    snapshot: () => ({ capabilities: [capability] }),
    execute: async () => ({ ok: false, error: { stage: "provider", code: "failure", message: "capability secret must not cross" } }),
  });
  const controller = new PetAssistantConversationController(service);
  await controller.sendTypedMessage("Try it.");
  const serialized = JSON.stringify(controller.getSnapshot());
  assert.equal(serialized.includes("capability secret must not cross"), false);
  assert.equal(serialized.includes("Capability result was unavailable."), true);
  controller.dispose();
  await service.stop();
}

// Failed turns retain a terminal failure and do not expose provider error objects.
{
  const failingService = new PetAssistantService({ generate: async () => { throw new Error("provider secret should not cross the projection"); } }, { snapshot: () => ({ capabilities: [] }), execute: async () => ({ ok: true, result: {} }) });
  const controller = new PetAssistantConversationController(failingService);
  const result = await controller.sendTypedMessage("Fail");
  assert.equal(result.status, "failed");
  assert.equal(controller.getSnapshot().terminal?.status, "failed");
  assert.equal(JSON.stringify(controller.getSnapshot()).includes("provider secret"), false);
  controller.dispose();
  await failingService.stop();
}

// The controller owns the typed-turn AbortController and preserves cancellation semantics.
{
  const service = new PetAssistantService({ generate: () => new Promise<PetAssistantTextModelResponse>(() => undefined) }, { snapshot: () => ({ capabilities: [] }), execute: async () => ({ ok: true, result: {} }) });
  const controller = new PetAssistantConversationController(service);
  const pending = controller.sendTypedMessage("Cancel me");
  await flush();
  assert.equal(controller.cancelTypedTurn(), true);
  assert.equal((await pending).status, "cancelled");
  assert.equal(controller.getSnapshot().terminal?.status, "cancelled");
  assert.equal(controller.cancelTypedTurn(), false);
  controller.dispose();
  await service.stop();
}

// Canonical and normalized voice ordering reject stale updates and retain one voice message.
{
  const projection = new PetAssistantConversationProjection();
  const voice = (sequence: number, status: "partial" | "final", text: string): PetAssistantNormalizedVoiceTranscriptEvent => ({
    type: "transcript", sequence, conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "voice-turn", entryId: "voice-entry", speaker: "user", status, text,
  });
  assert.equal(projection.applyNormalizedVoiceTranscript(voice(1, "partial", "Set a timer")), true);
  assert.equal(projection.applyNormalizedVoiceTranscript(voice(1, "final", "Set a timer")), false);
  assert.equal(projection.applyNormalizedVoiceTranscript(voice(2, "final", "Set a timer for 25 minutes")), true);
  assert.equal(projection.getSnapshot().items.length, 1);
  const voiceItem = projection.getSnapshot().items[0];
  assert.equal(voiceItem?.kind === "message" ? voiceItem.partial : "not-message", undefined);
  assert.equal(projection.applyAssistantEvent({ type: "activity", sequence: 2, conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "voice-turn", activity: "thinking" }), true);
  assert.equal(projection.applyAssistantEvent({ type: "activity", sequence: 1, conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "voice-turn", activity: "failed" }), false);
  assert.equal(projection.getSnapshot().lastSequence, 2);
  projection.dispose();
}

// The canonical assistant transcript can arrive before the session adapter's
// normalized voice event; the shared projection must replace it, not duplicate it.
{
  const projection = new PetAssistantConversationProjection();
  assert.equal(projection.applyAssistantEvent({ type: "transcript", sequence: 1, conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "voice-turn", message: { role: "assistant", content: "spoken answer" } }), true);
  assert.equal(projection.applyNormalizedVoiceTranscript({ type: "transcript", sequence: 3, conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "voice-turn", entryId: "voice-answer", speaker: "assistant", status: "final", text: "spoken answer" }), true);
  assert.equal(projection.getSnapshot().items.length, 1);
  const item = projection.getSnapshot().items[0];
  assert.equal(item?.kind === "message" ? item.source : "", "voice");
  projection.dispose();
}

// Voice correlation never falls back to matching text from another turn.
{
  const projection = new PetAssistantConversationProjection();
  assert.equal(projection.applyNormalizedVoiceTranscript({ type: "transcript", sequence: 1, conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "voice-turn-a", entryId: "entry-a", speaker: "user", status: "final", text: "same words" }), true);
  assert.equal(projection.applyAssistantEvent({ type: "transcript", sequence: 2, conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "canonical-turn-b", message: { role: "user", content: "same words" } }), true);
  assert.equal(projection.getSnapshot().items.length, 2);
  projection.dispose();
}

// The host projection keeps a bounded current-session transcript.
{
  const projection = new PetAssistantConversationProjection();
  for (let sequence = 1; sequence <= MAX_CONVERSATION_ITEMS + 1; sequence += 1) {
    assert.equal(projection.applyAssistantEvent({ type: "transcript", sequence, conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: `turn-${sequence}`, message: { role: "user", content: `message-${sequence}` } }), true);
  }
  assert.equal(projection.getSnapshot().items.length, MAX_CONVERSATION_ITEMS);
  const oldest = projection.getSnapshot().items[0];
  assert.equal(oldest?.kind === "message" ? oldest.text : "", "message-2");
  projection.dispose();
}

// Renderer remounts start from a host snapshot and ignore malformed or stale events.
{
  const current = emptyConversationSnapshot();
  const next = { ...current, revision: 1, lastSequence: 3, items: [{ kind: "message", id: "m", turnId: "t", role: "assistant", source: "typed", text: "hello" }] } as const;
  const applied = applyConversationEvent(current, { type: "snapshot", sequence: 3, snapshot: next });
  assert.equal(applied.items[0]?.kind, "message");
  assert.equal(applyConversationEvent(applied, { type: "snapshot", sequence: 2, snapshot: next }), applied);
  assert.equal(applyConversationEvent(applied, { type: "snapshot", sequence: 4, snapshot: { ...next, revision: 2, items: [{ kind: "message", id: "bad", turnId: "t", role: "assistant", source: "typed", text: 4 }] } }), applied);
  assert.equal(applyConversationSnapshot(applied, { ...current, revision: 0, lastSequence: 0 }), applied);
}

// Cancelling a turn settles only that turn's outstanding capability actions as indeterminate.
{
  const projection = new PetAssistantConversationProjection();
  assert.equal(projection.applyAssistantEvent({ type: "lifecycle", sequence: 1, lifecycle: "opening", conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "turn-1" }), true);
  assert.equal(projection.applyAssistantEvent({
    type: "transcript",
    sequence: 2,
    conversationId: PET_ASSISTANT_CONVERSATION_ID,
    turnId: "turn-1",
    message: { role: "assistant", toolCalls: [{ id: "call-1", name: "focus_start", arguments: {} }] },
  }), true);
  assert.equal(projection.applyAssistantEvent({ type: "activity", sequence: 3, conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "turn-1", activity: "acting", toolName: "focus_start" }), true);
  assert.equal(projection.applyAssistantEvent({
    type: "transcript",
    sequence: 4,
    conversationId: PET_ASSISTANT_CONVERSATION_ID,
    turnId: "turn-2",
    message: { role: "assistant", toolCalls: [{ id: "call-2", name: "reminder_create", arguments: {} }] },
  }), true);
  assert.equal(projection.applyAssistantEvent({ type: "terminal", sequence: 5, result: { conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "turn-1", status: "cancelled" } }), true);
  const actions = projection.getSnapshot().items.filter((item) => item.kind === "action");
  assert.equal(projection.getSnapshot().terminal?.status, "cancelled");
  assert.deepEqual(actions, [
    { kind: "action", id: "call-1", turnId: "turn-1", toolName: "focus_start", status: "indeterminate", reason: "Capability result was unavailable." },
    { kind: "action", id: "call-2", turnId: "turn-2", toolName: "reminder_create", status: "pending" },
  ]);
  assert.equal(actions.some((item) => item.kind === "action" && item.turnId === "turn-1" && (item.status === "pending" || item.status === "running")), false);
  projection.dispose();
}

assert.throws(() => validateConversationMessageInput(""), /must not be empty/);
assert.throws(() => validateConversationMessageInput("x".repeat(MAX_CONVERSATION_MESSAGE_BYTES + 1)), /too large/);
console.log("pet-assistant-conversation tests passed.");
