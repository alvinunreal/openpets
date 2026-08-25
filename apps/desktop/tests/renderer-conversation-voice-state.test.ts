import assert from "node:assert/strict";

import { createVoiceSnapshotOrdering, voiceBadgeClass, voiceStatusLabel } from "../src/renderer/src/conversation/conversation-types.js";

assert.equal(voiceStatusLabel("ending", "speaking", true), "Ending…", "ending status takes precedence over muted/activity label state");
assert.equal(voiceBadgeClass("ending", "speaking", true), "voice-badge-neutral", "ending status takes precedence over muted/activity badge state");

const ordering = createVoiceSnapshotOrdering();
const initialRequestVersion = ordering.beginInitialRequest();
ordering.noteEvent();
assert.equal(ordering.shouldApplyInitialSnapshot(initialRequestVersion), false, "an event received before the initial snapshot resolves remains authoritative");

console.log("Renderer Talk ending state verified.");
