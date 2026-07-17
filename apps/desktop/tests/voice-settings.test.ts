import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultVoiceSettings, getVoiceSettings, initializeVoiceSettings, normalizeVoiceSettings, updateVoiceSettings } from "../src/voice-settings.js";

const malformed = normalizeVoiceSettings({
  output: { providerId: "unknown", overlapPolicy: "forever", providerFallback: "mystery" },
  providers: { pockettts: { baseUrl: "javascript:alert(1)", voiceId: 42 }, system: { rate: 99 } },
  petOverrides: { "safe.pet": { providerId: "pockettts", voiceId: " alba " }, "../../unsafe": { providerId: "system" } },
  listening: { timeoutMs: 99_999 },
  wake: { enabled: true, phrase: "x".repeat(400) },
});

assert.equal(malformed.output.providerId, "system");
assert.equal(malformed.output.overlapPolicy, "interrupt");
assert.equal(malformed.providers.pockettts.baseUrl, defaultVoiceSettings.providers.pockettts.baseUrl);
assert.equal(malformed.providers.system.rate, 2);
assert.equal(malformed.petOverrides["safe.pet"]?.providerId, "pockettts");
assert.equal(malformed.petOverrides["safe.pet"]?.voiceId, "alba");
assert.equal(malformed.petOverrides["../../unsafe"], undefined);
assert.equal(malformed.listening.timeoutMs, 30_000);
assert.equal(malformed.wake.phrase.length, 120);

const userData = mkdtempSync(join(tmpdir(), "openpets-voice-settings-"));
initializeVoiceSettings(userData);
updateVoiceSettings({ output: { providerId: "pockettts", voiceId: "alba" }, providers: { pockettts: { baseUrl: "http://127.0.0.1:8000" } } });
assert.equal(getVoiceSettings().output.providerId, "pockettts");
assert.equal(getVoiceSettings().providers.pockettts.voiceId, "alba");
const persisted = JSON.parse(readFileSync(join(userData, "openpets-voice-settings.json"), "utf8")) as Record<string, unknown>;
assert.equal("apiKey" in persisted, false);

console.log("voice settings behavior verified");
