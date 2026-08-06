import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginSdkBridge, type PluginHostCapabilities } from "../src/plugin-sdk-bridge.js";
import type { OpenPetsJavascriptPluginManifest } from "../src/plugin-manifest.js";
import { PluginStateStore, type PluginStateRecord } from "../src/plugin-state.js";
import { pluginSdkQuotas } from "../src/plugin-sdk-quotas.js";

const root = mkdtempSync(join(tmpdir(), "openpets-voice-bridge-"));
try {
  const store = new PluginStateStore({ statePath: join(root, "state.json") });
  store.initialize();
  const record: PluginStateRecord = {
    id: "plug",
    version: "1.0.0",
    manifestPath: join(root, "openpets.plugin.json"),
    installPath: root,
    source: "local",
    manifestVersion: 3,
    runtime: "javascript",
    sdkVersion: "3.0.0",
    enabled: true,
    approvedPermissions: ["voice:listen"],
    config: {},
  };
  store.upsertRecord(record);
  const requests: Array<{ timeoutMs?: number; pluginId?: string }> = [];
  const capabilities = createCapabilities(requests);
  const bridge = new PluginSdkBridge({
    stateStore: store,
    petApi: { speak() {}, react() {}, moveBy() {}, wander() {}, moveToHome() {} },
    scheduler: { setTimeout: () => ({ cancel() {} }) },
    capabilities,
  });
  const api = bridge.createApi(record, manifest(["voice:listen"]));
  const unapproved = bridge.createApi(record, manifest([]));

  await assert.rejects(() => unapproved.voice.listen({ timeoutMs: 5_000 }), /voice:listen/);
  capabilities.settings.listenAllowed = () => false;
  await assert.rejects(() => api.voice.listen({ timeoutMs: 5_000 }), /Microphone access for plugins is disabled in settings\./);
  capabilities.settings.listenAllowed = () => true;

  await api.voice.listen({ timeoutMs: 1 });
  for (let index = 1; index < pluginSdkQuotas.voicePerMinute - 1; index += 1) await api.voice.listen({ timeoutMs: 60_000 });
  assert.equal(requests[0]?.timeoutMs, 1_000);
  assert.equal(requests[0]?.pluginId, "plug");
  assert.equal(requests.at(-1)?.timeoutMs, 30_000);
  await assert.rejects(() => api.voice.listen({ timeoutMs: 5_000 }), /Plugin voice quota exceeded\./);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function createCapabilities(requests: Array<{ timeoutMs?: number; pluginId?: string }>): PluginHostCapabilities {
  return {
    bubbles: { show: async () => ({ id: "bubble", update: async () => undefined, dismiss: async () => undefined, pin: async () => undefined, unpin: async () => undefined }) },
    audio: { play: async () => undefined, importUserSound: async () => ({ kind: "user-sound", id: "0".repeat(32) }), forgetUserSound: async () => undefined, stop: async () => undefined },
    events: { subscribe: () => () => undefined },
    pets: {
      list: () => [], spawn: async () => "pet", close: async () => undefined, show: async () => undefined, hide: async () => undefined,
      react: async () => undefined, setAnimation: async () => undefined, setScale: async () => undefined, setStatusReaction: async () => undefined,
      moveBy: async () => undefined, wander: async () => undefined, moveToHome: async () => undefined, moveTo: async () => undefined,
      followCursor: async () => undefined, physics: async () => undefined, getState: async () => ({ position: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 0, height: 0 }, currentAnimation: "idle", visible: true, dragging: false }),
      onTick: () => () => undefined, onChange: () => () => undefined,
    },
    toast: async () => undefined,
    notify: async () => undefined,
    panels: { open: async () => ({ id: "panel", show: async () => undefined, hide: async () => undefined, postMessage: async () => undefined, close: async () => undefined }) },
    delivery: { register: async () => ({ dismiss: () => undefined, onDismiss: () => undefined }), teardown: () => undefined },
    secrets: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, has: async () => false },
    ai: { available: async () => false, complete: async () => ({ text: "" }), stream: async () => ({ text: "" }) },
    voice: { speak: async () => undefined, listen: async (opts) => { requests.push(opts); return { text: "ok" }; } },
    auth: { oauth: async () => ({ accessToken: "" }), refresh: async () => ({ accessToken: "" }), signOut: async () => undefined },
    files: { pick: async () => [], read: async () => "", save: async () => undefined },
    system: { info: async () => ({ platform: "win", locale: "en-US", timezone: "UTC", theme: "light", appVersion: "0.0.0", online: true }), metrics: async () => ({ cpuPercent: 0, memUsedPercent: 0 }), openExternal: async () => undefined, readClipboardText: async () => "", writeClipboardText: async () => undefined },
    settings: { audioAllowed: () => true, dynamicSpeechAllowed: () => false, voiceAllowed: () => true, listenAllowed: () => true, inQuietHours: () => false },
  };
}

function manifest(permissions: OpenPetsJavascriptPluginManifest["permissions"]): OpenPetsJavascriptPluginManifest {
  return {
    manifestVersion: 3,
    id: "plug",
    name: "Plug",
    version: "1.0.0",
    runtime: "javascript",
    sdkVersion: "3.0.0",
    entry: "index.js",
    permissions,
  };
}

console.log("Voice bridge behavior verified.");
