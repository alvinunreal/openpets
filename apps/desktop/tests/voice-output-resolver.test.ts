import assert from "node:assert/strict";

import { defaultVoiceSettings, normalizeVoiceSettings, resolveVoiceAttemptPlan, resolveVoiceSelection } from "../src/voice-settings.js";

const settings = normalizeVoiceSettings({
  ...defaultVoiceSettings,
  output: { ...defaultVoiceSettings.output, providerId: "pockettts", voiceId: "alba", model: "base", overlapPolicy: "queue" },
  petOverrides: {
    cat: { providerId: "elevenlabs", voiceId: "voice-1", overlapPolicy: "interrupt", providerFallback: "fail" },
    dog: { voiceId: "marius" },
  },
});

assert.deepEqual(resolveVoiceSelection(settings, "cat"), {
  providerId: "elevenlabs",
  voiceId: "voice-1",
  model: "base",
  overlapPolicy: "interrupt",
  providerFallback: "fail",
  voiceFallback: "provider-default",
});
assert.equal(resolveVoiceSelection(settings, "dog").providerId, "pockettts");
assert.equal(resolveVoiceSelection(settings, "dog").voiceId, "marius");
assert.equal(resolveVoiceSelection(settings, "unknown").overlapPolicy, "queue");

const catSelection = resolveVoiceSelection(settings, "cat");
assert.deepEqual(resolveVoiceAttemptPlan(catSelection, "voice-1", false), [
  { providerId: "elevenlabs", useProviderDefault: false },
], "provider tests must not hide a failure behind voice or System Voice fallback");
assert.equal(resolveVoiceAttemptPlan(resolveVoiceSelection(settings, "dog"), "marius", true).at(-1)?.providerId, "system");

console.log("voice output selection behavior verified");
