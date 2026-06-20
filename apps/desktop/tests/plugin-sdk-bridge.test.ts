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

await scenario("pet.react validates silent reaction options", async ({ api }) => {
  await api.pet.react("waving", { showMessage: false });
  await assert.rejects(() => api.pet.react("waving", { showMessage: "no" }), /Invalid pet reaction showMessage option\./);
  await assert.rejects(() => api.pet.react("waving", { showMessage: false, extra: true }), /Invalid pet reaction option\./);
});

await scenario("hud bubble spec validation is enforced", async ({ store, bridge }) => {
  const record = store.getRecord("plug")!;
  const updatedRecord = {
    ...record,
    approvedPermissions: [...record.approvedPermissions, "pet:pin" as const],
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
    /Plugin bubble HUD cannot be combined with text/,
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

await scenario("oauth loopbackPort validation is enforced", async ({ api, capabilities }) => {
  const mockConfig = {
    authorizationUrl: "https://example.com/auth",
    tokenUrl: "https://example.com/token",
    clientId: "my-client-id",
    scopes: ["read"],
    redirect: "loopback" as const,
    loopbackPort: 48373,
  };

  let receivedConfig: any = null;
  capabilities.auth.oauth = async (pluginId, config) => {
    receivedConfig = config;
    return { accessToken: "test-token" };
  };

  await api.auth.oauth(mockConfig);
  assert.equal(receivedConfig.loopbackPort, 48373);

  await assert.rejects(
    () => api.auth.oauth({
      ...mockConfig,
      redirect: "appProtocol" as any,
    }),
    /loopbackPort is only allowed with redirect: 'loopback'\./,
  );

  await assert.rejects(
    () => api.auth.oauth({
      ...mockConfig,
      loopbackPort: 99999,
    }),
    /loopbackPort must be an integer between 1 and 65535\./,
  );

  await assert.rejects(
    () => api.auth.oauth({
      ...mockConfig,
      loopbackPort: 12.34,
    }),
    /loopbackPort must be an integer between 1 and 65535\./,
  );
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
      approvedPermissions: ["commands", "events", "storage", "pet:reaction", "pet:speak", "auth"],
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

type TestCapabilities = PluginHostCapabilities & { events: PluginHostCapabilities["events"] & { subscribed: string[] } };

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
    permissions: ["commands", "events", "storage", "pet:speak", "pet:reaction", "pet:pin", "auth"],
    assets: { icons: { focus: "assets/focus.svg" } },
  };
}
