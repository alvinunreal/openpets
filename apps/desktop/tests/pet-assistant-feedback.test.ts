import assert from "node:assert/strict";

import { applyPetAssistantFeedback, feedbackForAssistantEvent, feedbackForVoiceActivity, PetAssistantFeedbackReducer } from "../src/pet-assistant-feedback.js";
import { PET_ASSISTANT_CONVERSATION_ID } from "../src/pet-assistant-conversation.js";
import { composeVoiceActivityBadge, composeVoiceActivityDisplay } from "../src/voice-activity-slot.js";

assert.deepEqual(["listening", "thinking", "acting", "speaking"].map((activity) => feedbackForVoiceActivity(activity as "listening" | "thinking" | "acting" | "speaking").state), ["listening", "thinking", "acting", "speaking"]);
assert.equal(feedbackForVoiceActivity("acting").reaction, "working");

const terminal = feedbackForAssistantEvent({ type: "terminal", sequence: 1, result: { conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "turn-1", status: "completed", toolOutcomes: [{ id: "call", name: "focus", result: { status: "rejected", reason: "private" } }] } });
assert.equal(terminal?.state, "failure", "a rejected action is failure, not missing information without canonical evidence");
assert.equal(feedbackForAssistantEvent({ type: "terminal", sequence: 4, result: { conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "turn-4", status: "completed", toolOutcomes: [{ id: "call", name: "focus", result: { status: "rejected", reason: "duration required", missingInformation: true } }] } })?.state, "missing-information");
assert.equal(feedbackForAssistantEvent({ type: "terminal", sequence: 2, result: { conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "turn-2", status: "completed" } })?.state, "success");
assert.equal(feedbackForAssistantEvent({ type: "activity", sequence: 3, conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "turn-3", activity: "failed" }), null, "activity failure is not a terminal feedback trigger");
assert.equal(composeVoiceActivityBadge("waiting", "waiting", "success"), "success", "terminal feedback has priority over next listening activity");
assert.equal(composeVoiceActivityDisplay({ message: "Done." }, "waiting", "success")?.reaction, "success");

const applied: string[] = [];
applyPetAssistantFeedback({
  setActivity: (reaction) => applied.push(`activity:${reaction}`),
  setStatus: (reaction) => applied.push(`status:${reaction}`),
  showReaction: (reaction) => applied.push(`reaction:${reaction}`),
}, terminal);
assert.deepEqual(applied, ["activity:null", "status:error", "reaction:error"]);

const deferred: string[] = [];
const reducer = new PetAssistantFeedbackReducer({
  setActivity: (reaction) => deferred.push(`activity:${reaction}`),
  setStatus: (reaction) => deferred.push(`status:${reaction}`),
  showReaction: (reaction) => deferred.push(`reaction:${reaction}`),
});
reducer.applyVoiceEvent({ type: "snapshot", sequence: 1, snapshot: { status: "active", activity: "thinking", muted: false, conversationId: PET_ASSISTANT_CONVERSATION_ID, generation: 1, turnId: "voice-turn-1", userTranscript: null, assistantTranscript: null, interruptionCount: 0, error: null } });
reducer.applyAssistantEvent({ type: "activity", sequence: 2, conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "voice-turn-1", activity: "responding" });
reducer.applyAssistantEvent({ type: "terminal", sequence: 3, result: { conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "voice-turn-1", status: "completed" } });
assert.equal(deferred.some((entry) => entry.startsWith("status:")), false, "voice terminal feedback waits for playback settlement");
reducer.applyVoiceEvent({ type: "turn-settled", sequence: 4, turnId: "voice-turn-1", outcome: "completed" });
reducer.applyVoiceEvent({ type: "turn-settled", sequence: 5, turnId: "voice-turn-1", outcome: "completed" });
reducer.applyVoiceEvent({ type: "snapshot", sequence: 6, snapshot: { status: "active", activity: "listening", muted: false, conversationId: PET_ASSISTANT_CONVERSATION_ID, generation: 1, turnId: "voice-turn-1", userTranscript: null, assistantTranscript: null, interruptionCount: 0, error: null } });
assert.deepEqual(deferred.filter((entry) => entry === "status:success" || entry === "reaction:success"), ["status:success", "reaction:success"], "settled terminal feedback is delivered exactly once");

console.log("Pet assistant feedback mapping verified.");
