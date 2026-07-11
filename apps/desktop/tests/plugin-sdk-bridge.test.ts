import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginSdkBridge, type PluginHostCapabilities } from "../src/plugin-sdk-bridge.js";
import { pluginSdkQuotas } from "../src/plugin-sdk-quotas.js";
import { PluginStateStore, type PluginStateRecord } from "../src/plugin-state.js";
import type { OpenPetsJavascriptPluginManifest } from "../src/plugin-manifest.js";
import { sanitizePluginDiagnosticsFields } from "../src/plugin-diagnostics.js";

await scenario("storage.subscribe receives set value and delete as undefined", async ({ api }) => {
  const values: unknown[] = [];
  api.storage.subscribe("counter", (value: unknown) => values.push(value));

  api.storage.set("counter", 3);
  api.storage.delete("counter");
  await Promise.resolve();

  assert.equal(values.length, 2);
  assert.equal(values[0], 3);
  assert.equal(values[1], undefined);
});

await scenario("storage subscription quota is enforced", async ({ api }) => {
  for (let i = 0; i < pluginSdkQuotas.storageSubscriptions; i += 1) {
    api.storage.subscribe(`key-${i}`, () => undefined);
  }

  assert.throws(
    () => api.storage.subscribe("one-too-many", () => undefined),
    /Plugin storage subscription quota exceeded\./,
  );
});

await scenario("config.onChange disposer removes listener", async ({ api, bridge, store }) => {
  const seen: unknown[] = [];
  const dispose = api.config.onChange((config: Record<string, unknown>) => seen.push(config.value));

  store.replaceConfig("plug", { value: "first" });
  bridge.notifyConfigChanged("plug");
  await Promise.resolve();
  dispose();
  store.replaceConfig("plug", { value: "second" });
  bridge.notifyConfigChanged("plug");
  await Promise.resolve();

  assert.deepEqual(seen, ["first"]);
});

await scenario("diagnostics sanitizer redacts paths tokens and URL queries", () => {
  const safe = sanitizePluginDiagnosticsFields({ reason: "failed /Users/alvin/secrets/token.txt https://example.com/path?token=abc123 sk-1234567890123456", host: "example.com", ignored: "secret" });
  assert.equal(safe.host, "example.com");
  assert.equal("ignored" in safe, false);
  const reason = String(safe.reason);
  assert.equal(reason.includes("/Users/alvin"), false);
  assert.equal(reason.includes("abc123"), false);
  assert.equal(reason.includes("sk-1234567890123456"), false);
});

await scenario("OAuth only accepts provider-approved scopes and host-owned parameters", async ({ api }) => {
  await assert.rejects(
    () => api.auth.oauth({ provider: "google", clientId: "client", scopes: ["https://www.googleapis.com/auth/calendar.readonly"] }),
    /OAuth scopes are not allowed/,
  );
  await assert.rejects(
    () => api.auth.oauth({ provider: "spotify", clientId: "client", scopes: ["user-read-playback-state"], redirectUri: "http://127.0.0.1" }),
    /host-controlled/,
  );
  await api.auth.oauth({ provider: "google", clientId: "client", scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"] });
});

await scenario("OAuth accepts a valid client secret and rejects invalid values", async ({ api, capabilities }) => {
  let received: unknown;
  capabilities.auth.oauth = async (_pluginId, config) => { received = config; return { accessToken: "" }; };
  await api.auth.oauth({ provider: "google", clientId: "client", clientSecret: "secret-value", scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"] });
  assert.deepEqual(received, { provider: "google", clientId: "client", clientSecret: "secret-value", scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"] });
  await assert.rejects(() => api.auth.oauth({ provider: "google", clientId: "client", clientSecret: "", scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"] }), /Invalid OAuth clientSecret\./);
  await assert.rejects(() => api.auth.oauth({ provider: "google", clientId: "client", clientSecret: 1, scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"] }), /Invalid OAuth clientSecret\./);
  await assert.rejects(() => api.auth.oauth({ provider: "google", clientId: "client", clientSecret: "line\nbreak", scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"] }), /Invalid OAuth clientSecret\./);
});

await scenario("events.on config:changed uses config listener path", async ({ api, bridge, store, capabilities }) => {
  const seen: unknown[] = [];
  const sub = api.events.on("config:changed", (config: Record<string, unknown>) => seen.push(config.value));

  store.replaceConfig("plug", { value: "first" });
  bridge.notifyConfigChanged("plug");
  await Promise.resolve();
  api.events.off(sub.subscriptionId);
  store.replaceConfig("plug", { value: "second" });
  bridge.notifyConfigChanged("plug");
  await Promise.resolve();

  assert.deepEqual(seen, ["first"]);
  assert.deepEqual(capabilities.events.subscribed, []);
});

await scenario("commands accept declared icon asset refs and reject raw svg strings", ({ api, bridge }) => {
  api.commands.register({ id: "focus", title: "Focus", icon: { kind: "icon", name: "focus" } }, () => undefined);
  assert.deepEqual(bridge.getPublicState("plug").commands[0]?.icon, { kind: "icon", name: "focus" });

  assert.throws(
    () => api.commands.register({ id: "raw-svg", title: "Raw SVG", icon: "<svg></svg>" }, () => undefined),
    /Invalid plugin command icon\./,
  );
});

await scenario("commands retain validated timeout overrides and honor them", async ({ api, bridge }) => {
  api.commands.register({ id: "oauth-connect", title: "Connect", timeoutMs: 1_000 }, () => new Promise<void>(() => undefined));
  assert.equal(bridge.getPublicState("plug").commands[0]?.timeoutMs, 1_000);
  const started = Date.now();
  await assert.rejects(() => bridge.executeCommand("plug", "oauth-connect"), /Plugin command timed out\./);
  assert.ok(Date.now() - started < 3_000, "command-specific timeout wins over the five-second default");
  assert.throws(() => api.commands.register({ id: "fraction", title: "Fraction", timeoutMs: 1_000.5 }, () => undefined), /Invalid plugin command timeoutMs\./);
  assert.throws(() => api.commands.register({ id: "too-long", title: "Too long", timeoutMs: 300_001 }, () => undefined), /Invalid plugin command timeoutMs\./);
});

await scenario("pet.react validates silent reaction options", async ({ api }) => {
  await api.pet.react("waving", { showMessage: false });
  await assert.rejects(() => api.pet.react("waving", { showMessage: "no" }), /Invalid pet reaction showMessage option\./);
  await assert.rejects(() => api.pet.react("waving", { showMessage: false, extra: true }), /Invalid pet reaction option\./);
});

await scenario("hud bubble spec validation is enforced", async ({ store, bridge }) => {
  const record = store.getRecord("plug")!;
  const updatedRecord = {
    ...record,
    approvedPermissions: [...record.approvedPermissions, "pet:pin" as const, "pet:speak" as const],
  };
  store.upsertRecord(updatedRecord);
  
  const approvedApi = bridge.createApi(updatedRecord, manifest());

  // Should succeed with valid HUD
  await approvedApi.ui.bubble({
    pin: true,
    hud: {
      items: [
        { icon: "food", value: 80, tone: "amber", label: "Food" },
      ],
    },
  });

  // Should reject if pin: true is missing
  await assert.rejects(
    () => approvedApi.ui.bubble({
      hud: {
        items: [
          { icon: "food", value: 80, tone: "amber", label: "Food" },
        ],
      },
    }),
    /Bubble HUD descriptor is only allowed for pinned bubbles\./,
  );

  // Should reject if combined with text
  await assert.rejects(
    () => approvedApi.ui.bubble({
      pin: true,
      text: "hello",
      hud: {
        items: [
          { icon: "food", value: 80, tone: "amber", label: "Food" },
        ],
      },
    }),
    /Plugin bubble HUD cannot be combined with text or markdown\./,
  );

  // Should reject if items contains more than 4 items
  await assert.rejects(
    () => approvedApi.ui.bubble({
      pin: true,
      hud: {
        items: [
          { icon: "food", value: 80 },
          { icon: "zap", value: 80 },
          { icon: "play", value: 80 },
          { icon: "heart", value: 80 },
          { icon: "star", value: 80 },
        ],
      },
    }),
    /Bubble HUD items must contain between 1 and 4 items\./,
  );
  
  // Should reject if item lacks icon
  await assert.rejects(
    () => approvedApi.ui.bubble({
      pin: true,
      hud: {
        items: [
          { value: 80 },
        ],
      },
    }),
    /Bubble HUD item must have an icon\./,
  );

  // Should reject if item value is outside 0..100
  await assert.rejects(
    () => approvedApi.ui.bubble({
      pin: true,
      hud: {
        items: [
          { icon: "food", value: 150 },
        ],
      },
    }),
    /Bubble HUD item value must be a number between 0 and 100\./,
  );
});

await scenario("delivery requires permission and tears down without callbacks", async ({ api, bridge, store, capabilities }) => {
  await assert.rejects(() => api.ui.delivery({ key: "calendar.1", courier: { kind: "sprite", name: "courier" }, title: "Event", detail: "Soon", expiresAt: Date.now() + 60_000 }), /ui:delivery/);
  const record = { ...store.getRecord("plug")!, approvedPermissions: [...store.getRecord("plug")!.approvedPermissions, "ui:delivery" as const] };
  store.upsertRecord(record);
  const approved = bridge.createApi(record, manifest());
  await assert.rejects(() => approved.ui.delivery({ key: "calendar.1", courier: { kind: "sprite", name: "courier" }, title: "Event", detail: "Soon", expiresAt: Date.now() + 60_000, x: 1 }), /Invalid delivery descriptor field/);
  const handle = await approved.ui.delivery({ key: "calendar.1", courier: { kind: "sprite", name: "courier" }, title: "Event", detail: "Soon", expiresAt: Date.now() + 60_000 });
  let dismissed = false;
  approved.ui.deliverySubscribe(handle.deliveryId, () => { dismissed = true; });
  bridge.clearPlugin("plug");
  assert.equal(capabilities.delivery.teardowns, 1);
  capabilities.delivery.dismiss?.("plugin-stopped");
  assert.equal(dismissed, false);
});

await scenario("delivery re-registration retires obsolete handles and callbacks", async ({ bridge, store, capabilities }) => {
  const record = { ...store.getRecord("plug")!, approvedPermissions: [...store.getRecord("plug")!.approvedPermissions, "ui:delivery" as const] };
  store.upsertRecord(record);
  const api = bridge.createApi(record, manifest());
  const first = await api.ui.delivery({ key: "calendar.1", courier: { kind: "sprite", name: "courier" }, title: "First", detail: "Soon", expiresAt: Date.now() + 60_000 });
  let firstDismissals = 0;
  assert.deepEqual(api.ui.deliverySubscribe(first.deliveryId, () => { firstDismissals += 1; }), { ok: true });
  const second = await api.ui.delivery({ key: "calendar.1", courier: { kind: "sprite", name: "courier" }, title: "Updated", detail: "Later", expiresAt: Date.now() + 60_000 });
  assert.deepEqual(api.ui.deliverySubscribe(first.deliveryId, () => { firstDismissals += 1; }), { ok: false });
  await api.ui.deliveryDismiss(first.deliveryId);
  assert.equal(firstDismissals, 0);
  let secondReason: string | undefined;
  assert.deepEqual(api.ui.deliverySubscribe(second.deliveryId, (reason) => { secondReason = reason; }), { ok: true });
  capabilities.delivery.dismiss?.("click");
  assert.equal(firstDismissals, 0);
  assert.equal(secondReason, "click");
  assert.deepEqual(api.ui.deliverySubscribe(second.deliveryId, () => undefined), { ok: false });
});

type ScenarioContext = {
  api: ReturnType<PluginSdkBridge["createApi"]>;
  bridge: PluginSdkBridge;
  store: PluginStateStore;
  capabilities: TestCapabilities;
};

async function scenario(name: string, run: (context: ScenarioContext) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "openpets-plugin-sdk-"));
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
      approvedPermissions: ["commands", "events", "storage", "pet:reaction", "auth"],
      config: {},
    };
    store.upsertRecord(record);
    const capabilities = createTestCapabilities();
    const bridge = new PluginSdkBridge({
      stateStore: store,
      petApi: { speak() {}, react() {}, moveBy() {}, wander() {}, moveToHome() {} },
      scheduler: { setTimeout: () => ({ cancel() {} }) },
      capabilities,
    });
    const api = bridge.createApi(record, manifest());
    await run({ api, bridge, store, capabilities });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type TestCapabilities = PluginHostCapabilities & { events: PluginHostCapabilities["events"] & { subscribed: string[] }; delivery: PluginHostCapabilities["delivery"] & { teardowns: number; dismiss?: (reason: "click" | "manual" | "expired" | "plugin-stopped") => void } };

function createTestCapabilities(): TestCapabilities {
  return {
    bubbles: { show: async () => ({ id: "bubble", update: async () => undefined, dismiss: async () => undefined, pin: async () => undefined, unpin: async () => undefined }) },
    audio: { play: async () => undefined, importUserSound: async (_pluginId, _fileId, opts) => ({ kind: "user-sound", id: "0".repeat(32), name: opts?.name }), forgetUserSound: async () => undefined, stop: async () => undefined },
    events: { subscribed: [], subscribe(event) { this.subscribed.push(event); return () => undefined; } },
    pets: {
      list: () => [],
      spawn: async () => "pet",
      close: async () => undefined,
      show: async () => undefined,
      hide: async () => undefined,
      react: async () => undefined,
      setAnimation: async () => undefined,
      setScale: async () => undefined,
      setStatusReaction: async () => undefined,
      moveBy: async () => undefined,
      wander: async () => undefined,
      moveToHome: async () => undefined,
      moveTo: async () => undefined,
      followCursor: async () => undefined,
      physics: async () => undefined,
      getState: async () => ({ position: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 0, height: 0 }, currentAnimation: "idle", visible: true, dragging: false }),
      onTick: () => () => undefined,
      onChange: () => () => undefined,
    },
    toast: async () => undefined,
    notify: async () => undefined,
    panels: { open: async () => ({ id: "panel", show: async () => undefined, hide: async () => undefined, postMessage: async () => undefined, close: async () => undefined }) },
    delivery: { teardowns: 0, async register(_pluginId, _descriptor) { let handler: ((reason: "click" | "manual" | "expired" | "plugin-stopped") => void) | undefined; this.dismiss = (reason) => handler?.(reason); return { dismiss: () => this.dismiss?.("manual"), onDismiss: (next) => { handler = next; } }; }, teardown() { this.teardowns += 1; } },
    secrets: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, has: async () => false },
    ai: { available: async () => false, complete: async () => ({ text: "" }), stream: async () => ({ text: "" }) },
    voice: { speak: async () => undefined, listen: async () => ({ text: "" }) },
    auth: { oauth: async () => ({ accessToken: "" }), refresh: async () => ({ accessToken: "" }), signOut: async () => undefined },
    files: { pick: async () => [], read: async () => "", save: async () => undefined },
    system: { info: async () => ({ platform: "mac", locale: "en-US", timezone: "UTC", theme: "light", appVersion: "0.0.0", online: true }), metrics: async () => ({ cpuPercent: 0, memUsedPercent: 0 }), openExternal: async () => undefined, readClipboardText: async () => "", writeClipboardText: async () => undefined },
    settings: { audioAllowed: () => true, dynamicSpeechAllowed: () => false, voiceAllowed: () => true, listenAllowed: () => false, inQuietHours: () => false },
  };
}

function manifest(): OpenPetsJavascriptPluginManifest {
  return {
    manifestVersion: 3,
    id: "plug",
    name: "Plug",
    version: "1.0.0",
    runtime: "javascript",
    sdkVersion: "3.0.0",
    entry: "index.js",
    permissions: ["commands", "events", "storage", "auth"],
    assets: { icons: { focus: "assets/focus.svg" } },
  };
}
