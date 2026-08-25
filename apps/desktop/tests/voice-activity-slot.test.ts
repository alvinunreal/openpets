import assert from "node:assert/strict";

import { composeVoiceActivityBadge, composeVoiceActivityDisplay } from "../src/voice-activity-slot.js";

const externalDisplay = {
  message: "Plugin-owned message",
  mediaPath: "/tmp/plugin-media.png",
  clickUrl: "https://example.test/plugin",
  dismissToken: "plugin-display-1",
  reaction: "success" as const,
};

assert.deepEqual(composeVoiceActivityDisplay(externalDisplay, "thinking"), {
  ...externalDisplay,
  reaction: "thinking",
  suppressReactionMessage: true,
}, "voice activity overlays animation while preserving unrelated plugin content");
assert.deepEqual(composeVoiceActivityDisplay(externalDisplay, null), externalDisplay, "clearing voice activity restores the unrelated display unchanged");
assert.deepEqual(composeVoiceActivityBadge("success", "running"), "running");
assert.deepEqual(composeVoiceActivityBadge("success", null), "success", "clearing voice activity restores the unrelated badge");

console.log("Voice activity slot composition verified.");
