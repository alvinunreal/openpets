import assert from "node:assert/strict";

import { voiceBadgeClass, voiceStatusLabel } from "../src/renderer/src/conversation/conversation-types.js";

assert.equal(voiceStatusLabel("ending", "speaking", true), "Ending…", "ending status takes precedence over muted/activity label state");
assert.equal(voiceBadgeClass("ending", "speaking", true), "voice-badge-neutral", "ending status takes precedence over muted/activity badge state");

console.log("Renderer Talk ending state verified.");
