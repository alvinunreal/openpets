import assert from "node:assert/strict";

import { PetAssistantConversationController, PET_ASSISTANT_CONVERSATION_ID } from "../src/pet-assistant-conversation.js";
import { PetAssistantModalityCoordinator } from "../src/pet-assistant-modality.js";
import { PetAssistantService } from "../src/pet-assistant-service.js";
import { VoiceAssistantSession } from "../src/voice-assistant-session.js";
import { VoiceMicrophoneArbiter } from "../src/voice-microphone-arbiter.js";

const coordinator = new PetAssistantModalityCoordinator();
const typedService = new PetAssistantService({ generate: async () => ({ type: "text", text: "done" }) }, { snapshot: () => ({ capabilities: [] }), execute: async () => ({ ok: true, result: {} }) });
const typedController = new PetAssistantConversationController(typedService, undefined, coordinator);

let releaseCapture!: () => void;
let captures = 0;
const voiceSession = new VoiceAssistantSession({
  conversationId: PET_ASSISTANT_CONVERSATION_ID,
  microphoneArbiter: new VoiceMicrophoneArbiter(),
  modalityCoordinator: coordinator,
  input: {
    listen: async () => { captures += 1; await new Promise<void>((resolve) => { releaseCapture = resolve; }); return { status: "cancelled" as const, reason: "test" }; },
    cancel: async () => { releaseCapture?.(); },
  },
  assistant: { startTurn: async () => ({ status: "cancelled" as const }), subscribe: () => () => {} },
  synthesizer: { synthesize: async () => ({ kind: "system" as const, text: "" }) },
  player: { play: async () => undefined, stop: async () => undefined },
});

await voiceSession.start();
assert.equal(captures, 1, "Talk acquires the shared modality before capture");
await assert.rejects(typedController.sendTypedMessage("typed while Talk is listening"), /typed Pet Assistant turn while a voice turn is active/);
await voiceSession.end();

const typedLease = coordinator.acquire("typed");
const blockedVoice = new VoiceAssistantSession({
  conversationId: PET_ASSISTANT_CONVERSATION_ID,
  microphoneArbiter: new VoiceMicrophoneArbiter(),
  modalityCoordinator: coordinator,
  input: { listen: async () => { throw new Error("capture must not start"); }, cancel: async () => undefined },
  assistant: { startTurn: async () => ({ status: "cancelled" as const }), subscribe: () => () => {} },
  synthesizer: { synthesize: async () => ({ kind: "system" as const, text: "" }) },
  player: { play: async () => undefined, stop: async () => undefined },
});
await assert.rejects(blockedVoice.start(), /voice Pet Assistant turn while a typed turn is active/);
typedLease.release();
await blockedVoice.shutdown();
await typedService.stop();

console.log("Pet Assistant modality races verified.");
