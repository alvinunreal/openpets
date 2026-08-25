import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildProviderControlCenterSnapshot, createProviderProfile, deleteProviderProfile, getPluginPlatformSettings, initializePluginPlatformSettings, isProviderSecretRefReferenced, providerPresets, selectProviderProfile, updateProviderProfile, validateProviderBaseUrl, validateProviderHeaders, validateProviderProfile, validateProviderProfilePatch } from "../src/plugin-platform-settings.js";

const dir = mkdtempSync(join(tmpdir(), "openpets-provider-profiles-"));
try {
  initializePluginPlatformSettings(dir);
  const presetModes = Object.fromEntries(providerPresets.map((preset) => [preset.id, preset.credentialMode]));
  assert.deepEqual(presetModes, { openai: "required", anthropic: "required", ollama: "none", "lm-studio": "none", vllm: "none", "minimax-chat": "required", whisper: "required", elevenlabs: "required", "system-tts": "none" });
  createProviderProfile({ id: "text-local", label: "Local text", adapter: "openai-compatible-text", model: "llama", baseUrl: "http://127.0.0.1:11434/v1", headers: [{ name: "X-Client", value: "openpets" }] });
  createProviderProfile({ id: "stt-cloud", label: "Whisper", adapter: "openai-compatible-transcription", model: "whisper-1", baseUrl: "https://stt.example/v1", secretRef: "stt" });
  createProviderProfile({ id: "system-voice", label: "System", adapter: "system-tts", model: "" });
  selectProviderProfile("text", "text-local"); selectProviderProfile("stt", "stt-cloud"); selectProviderProfile("tts", "system-voice");
  assert.deepEqual(getPluginPlatformSettings().selections, { text: "text-local", stt: "stt-cloud", tts: "system-voice" });
  const persisted = JSON.parse(readFileSync(join(dir, "openpets-plugin-platform.json"), "utf8")) as Record<string, unknown>;
  assert.equal("ai" in persisted, false, "legacy single-provider settings must not be persisted or read");
  const snapshot = buildProviderControlCenterSnapshot(getPluginPlatformSettings(), () => false);
  assert.deepEqual(Object.keys(snapshot.selections), ["text", "stt", "tts"]);
  assert.deepEqual(Object.keys(snapshot.statuses), ["text", "stt", "tts", "realtime"]);
  assert.equal(JSON.stringify(snapshot).includes("openpets"), false);
  assert.equal(JSON.stringify(snapshot).includes("header-value"), false);
  assert.deepEqual(snapshot.profiles.find((profile) => profile.id === "text-local")?.headerNames, ["X-Client"]);
  updateProviderProfile("text-local", { label: "Local text renamed", headers: undefined });
  assert.deepEqual(getPluginPlatformSettings().profiles["text-local"]?.headers, [{ name: "X-Client", value: "openpets" }]);
  updateProviderProfile("text-local", { headers: [] });
  assert.deepEqual(getPluginPlatformSettings().profiles["text-local"]?.headers, undefined);
  assert.equal(snapshot.statuses.stt.state, "missing-secret");
  assert.throws(() => validateProviderBaseUrl("http://cloud.example/v1"), /HTTPS/);
  assert.throws(() => validateProviderBaseUrl("https://user:pass@example/v1"), /credentials/);
  assert.throws(() => validateProviderBaseUrl("https://example/v1?key=secret"), /query/);
  assert.throws(() => validateProviderHeaders([{ name: "X-Test", value: "1" }, { name: "x-test", value: "2" }]), /duplicate/);
  assert.throws(() => validateProviderHeaders([{ name: "Connection", value: "keep-alive" }]), /reserved/);
  assert.throws(() => validateProviderHeaders(Array.from({ length: 17 }, (_, index) => ({ name: `X-${index}`, value: "x" }))), /at most/);
  assert.deepEqual(validateProviderProfile({ id: "raw-auth", label: "Raw auth", adapter: "openai-compatible-text", model: "model", baseUrl: "https://provider.example/v1", secretRef: "raw", auth: { headerName: "X-API-Key", strategy: "raw" } }).auth, { headerName: "X-API-Key", strategy: "raw" });
  assert.throws(() => validateProviderProfile({ id: "conflicting-auth", label: "Conflict", adapter: "openai-compatible-text", model: "model", baseUrl: "https://provider.example/v1", secretRef: "raw", auth: { headerName: "X-API-Key", strategy: "raw" }, headers: [{ name: "X-API-Key", value: "wrong" }] }), /static header/);
  createProviderProfile({ id: "clearable-network", label: "Clearable", adapter: "openai-compatible-text", model: "model", baseUrl: "https://provider.example/v1", secretRef: "clearable", auth: { headerName: "X-API-Key", strategy: "raw" }, headers: [{ name: "X-Route", value: "gateway" }] });
  const beforeLabelPatch = getPluginPlatformSettings().profiles["clearable-network"];
  updateProviderProfile("clearable-network", { label: "Renamed only" });
  assert.deepEqual(getPluginPlatformSettings().profiles["clearable-network"], { ...beforeLabelPatch, label: "Renamed only" }, "label-only patches preserve endpoint, credential, auth, and headers");
  updateProviderProfile("clearable-network", { adapter: "system-tts", model: "", baseUrl: null, secretRef: null, auth: null, headers: [] });
  assert.deepEqual(getPluginPlatformSettings().profiles["clearable-network"], { id: "clearable-network", label: "Renamed only", adapter: "system-tts", model: "" }, "nullable clears permit deliberate conversion to system TTS");
  assert.throws(() => validateProviderProfilePatch({ baseUrl: "" }), /base URL/);
  assert.throws(() => validateProviderProfilePatch({ unsupported: true }), /not supported/);
  assert.throws(() => selectProviderProfile("stt", "text-local"), /does not support/);
  createProviderProfile({ id: "shared-secret-a", label: "Shared A", adapter: "openai-compatible-text", model: "a", baseUrl: "https://shared.example/v1", secretRef: "shared" });
  createProviderProfile({ id: "shared-secret-b", label: "Shared B", adapter: "openai-compatible-text", model: "b", baseUrl: "https://shared.example/v1", secretRef: "shared" });
  deleteProviderProfile("shared-secret-a");
  assert.equal(getPluginPlatformSettings().profiles["shared-secret-b"]?.secretRef, "shared", "deleting a sibling profile must not remove its shared credential reference");
  assert.equal(isProviderSecretRefReferenced(getPluginPlatformSettings(), "shared"), true);
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log("provider profile validation tests passed.");
