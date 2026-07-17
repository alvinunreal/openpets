import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultHostAiSettings,
  getHostAiSettings,
  initializeHostAiSettings,
  normalizeHostAiSettings,
} from "../src/host-ai-settings.js";
import {
  getPluginPlatformSettings,
  initializePluginPlatformSettings,
  updatePluginPlatformSettings,
} from "../src/plugin-platform-settings.js";

assert.deepEqual(normalizeHostAiSettings(null), defaultHostAiSettings);
assert.deepEqual(normalizeHostAiSettings({ provider: "invalid", model: "ignored" }), defaultHostAiSettings);
assert.deepEqual(normalizeHostAiSettings({ provider: "none", model: "ignored", baseUrl: "https://ignored.test" }), defaultHostAiSettings);
const normalized = normalizeHostAiSettings({
  provider: "openai",
  model: `  ${"m".repeat(140)}  `,
  baseUrl: "  https://ai.example.test/v1/  ",
});
assert.equal(normalized.model.length, 120);
assert.equal(normalized.model.startsWith("m"), true);
assert.equal(normalized.baseUrl, "https://ai.example.test/v1/");
assert.equal(normalizeHostAiSettings({ provider: "ollama", baseUrl: "javascript:alert(1)" }).baseUrl, undefined);

const migratedUserData = mkdtempSync(join(tmpdir(), "openpets-host-ai-migrate-"));
const legacyPath = join(migratedUserData, "openpets-plugin-platform.json");
writeFileSync(legacyPath, JSON.stringify({
  allowPluginAudio: false,
  allowDynamicSpeech: true,
  allowPluginVoice: false,
  allowMicrophone: true,
  quietHours: { enabled: true, start: "21:30", end: "07:15" },
  ai: { provider: "openai", model: "legacy-model", baseUrl: "https://legacy.example.test/v1" },
}));

const migrated = initializePluginPlatformSettings(migratedUserData);
assert.equal(migrated.ai.provider, "openai");
assert.equal(migrated.ai.model, "legacy-model");
assert.equal(migrated.allowPluginAudio, false);
assert.equal(migrated.quietHours.start, "21:30");
const hostFile = JSON.parse(readFileSync(join(migratedUserData, "openpets-host-ai-settings.json"), "utf8")) as Record<string, unknown>;
assert.equal(hostFile.provider, "openai");
const migratedPluginFile = JSON.parse(readFileSync(legacyPath, "utf8")) as Record<string, unknown>;
assert.equal("ai" in migratedPluginFile, false);
assert.equal(migratedPluginFile.allowPluginAudio, false);

const updated = updatePluginPlatformSettings({
  ai: { provider: "ollama", model: "qwen2.5", baseUrl: "http://127.0.0.1:11434/v1" },
});
assert.equal(updated.ai.provider, "ollama");
assert.equal(getPluginPlatformSettings().ai.model, "qwen2.5");
const updatedPluginFile = JSON.parse(readFileSync(legacyPath, "utf8")) as Record<string, unknown>;
assert.equal("ai" in updatedPluginFile, false);
const updatedHostFile = JSON.parse(readFileSync(join(migratedUserData, "openpets-host-ai-settings.json"), "utf8")) as Record<string, unknown>;
assert.equal(updatedHostFile.provider, "ollama");

initializeHostAiSettings(migratedUserData);
assert.equal(getHostAiSettings().provider, "ollama");

const explicitDisabledUserData = mkdtempSync(join(tmpdir(), "openpets-host-ai-disabled-"));
writeFileSync(join(explicitDisabledUserData, "openpets-host-ai-settings.json"), JSON.stringify({ provider: "none", model: "" }));
writeFileSync(join(explicitDisabledUserData, "openpets-plugin-platform.json"), JSON.stringify({
  allowPluginAudio: false,
  ai: { provider: "anthropic", model: "stale-legacy-model" },
}));
const explicitlyDisabled = initializePluginPlatformSettings(explicitDisabledUserData);
assert.equal(explicitlyDisabled.ai.provider, "none");
assert.equal(explicitlyDisabled.allowPluginAudio, false);

console.log("host AI settings and forward migration behavior verified");
