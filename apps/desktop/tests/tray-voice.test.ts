import assert from "node:assert/strict";

import { createVoiceAssistantTalkMenuLabel, createVoiceMenuItems } from "../src/tray-voice-menu.js";
import { VoiceOperationState } from "../src/voice-operation-state.js";

const state = new VoiceOperationState();
const menu = () => createVoiceMenuItems(state.snapshot());

assert.deepEqual(menu(), [], "no voice menu item should appear without an active operation");

let cancelCount = 0;
state.begin(async () => { cancelCount += 1; });
assert.equal(menu()[0]?.label, "Stop microphone listening", "acquisition should offer microphone cancellation");

state.setPhase("recording");
assert.equal(menu()[0]?.label, "Stop microphone listening", "recording should offer microphone cancellation");

state.setPhase("transcribing");
assert.equal(menu()[0]?.label, "Cancel transcription", "transcription should offer transcription cancellation");

menu()[0]?.click();
assert.equal(cancelCount, 1, "clicking the voice menu item should cancel once");

state.settle();
assert.deepEqual(menu(), [], "settling should remove the voice menu item");

assert.equal(createVoiceAssistantTalkMenuLabel("ended"), "Talk to your pet", "ended Talk state offers start");
for (const status of ["active", "muted", "paused", "ending"] as const) {
  assert.equal(createVoiceAssistantTalkMenuLabel(status), "End talk", `${status} Talk state offers end`);
}

console.log("Tray voice cancellation behavior verified.");
