import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginSdkBridge, type PluginDeliveryHostHandle, type PluginHostCapabilities } from "../src/plugin-sdk-bridge.js";
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

await scenario("unregistered command diagnostics identify safe command and plugin IDs", async ({ api, bridge }) => {
  await assert.rejects(
    () => bridge.executeCommand("plug", "missing"),
    (error: unknown) => error instanceof Error && error.message === 'Plugin command "missing" is not registered for plugin "plug".',
  );

  api.commands.register({ id: "available", title: "Sensitive command title" }, () => undefined);
  await assert.rejects(
    () => bridge.executeCommand("plug", "missing"),
    (error: unknown) => error instanceof Error && error.message === 'Plugin command "missing" is not registered for plugin "plug". Registered command IDs: available.',
  );
});

await scenario("status validation reports safe actionable errors", ({ bridge, store }) => {
  const record = store.getRecord("plug")!;
  const api = bridge.createApi({ ...record, approvedPermissions: [...record.approvedPermissions, "status"] }, manifest({ permissions: [...record.approvedPermissions, "status"] as OpenPetsJavascriptPluginManifest["permissions"] }));

  assert.throws(() => api.status.set({ text: 42 } as never), /Plugin status text must be a string; received number\./);
  assert.throws(() => api.status.set(" \t "), /Plugin status text must not be empty\./);
  assert.throws(() => api.status.set("private-status".repeat(10)), /Plugin status text exceeds the 120-character maximum \(received 140\)\./);
  assert.throws(() => api.status.set({ text: "Ready", tone: "private-tone" } as never), /Plugin status tone must be one of: info, success, warning, error\./);
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
  
  const approvedApi = bridge.createApi(updatedRecord, manifest({ permissions: updatedRecord.approvedPermissions as OpenPetsJavascriptPluginManifest["permissions"] }));

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
  const approved = bridge.createApi(record, manifest({ permissions: record.approvedPermissions as OpenPetsJavascriptPluginManifest["permissions"] }));
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
  const api = bridge.createApi(record, manifest({ permissions: record.approvedPermissions as OpenPetsJavascriptPluginManifest["permissions"] }));
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

await scenario("late delivery registration is dismissed after generation clear", async ({ bridge, store, capabilities }) => {
  const record = { ...store.getRecord("plug")!, approvedPermissions: [...store.getRecord("plug")!.approvedPermissions, "ui:delivery" as const] };
  store.upsertRecord(record);
  const api = bridge.createApi(record, manifest({ permissions: record.approvedPermissions as OpenPetsJavascriptPluginManifest["permissions"] }));
  let release!: (handle: PluginDeliveryHostHandle) => void;
  let dismissals = 0;
  capabilities.delivery.register = async () => new Promise<PluginDeliveryHostHandle>((resolve) => { release = resolve; });
  const pending = api.ui.delivery({ key: "calendar.1", courier: { kind: "sprite", name: "courier" }, title: "Pending", detail: "Soon", expiresAt: Date.now() + 60_000 });
  await Promise.resolve();
  bridge.clearPlugin("plug");
  release({ dismiss: () => { dismissals += 1; }, onDismiss: () => undefined });
  await pending;
  assert.equal(dismissals, 1);
});

await scenario("net.fetch with network:local reaches exact local HTTP and public HTTPS hosts", async ({ bridge, store }) => {
  const originalFetch = globalThis.fetch;
  const localHost = "127.0.0.1:18765";
  const publicHost = "1.1.1.1";
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | { url?: string }) => {
    const href = String(input);
    seen.push(href);
    return new Response(href.includes("127.0.0.1") ? "local-ok" : "public-ok", { status: 200 });
  }) as typeof fetch;
  try {
    const record = {
      ...store.getRecord("plug")!,
      approvedPermissions: ["network" as const, "network:local" as const],
      approvedNetworkHosts: [localHost, publicHost],
    };
    store.upsertRecord(record);
    const api = bridge.createApi(record, manifest({
      permissions: ["network", "network:local"],
      network: { hosts: [localHost, publicHost] },
    }));
    const local = await api.net.fetch(`http://${localHost}/status`);
    assert.equal(local.status, 200);
    assert.equal(local.text, "local-ok");
    const pub = await api.net.fetch(`https://${publicHost}/`);
    assert.equal(pub.status, 200);
    assert.equal(pub.text, "public-ok");
    assert.equal(seen.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await scenario("stale network:local approval is denied after manifest removal", async ({ bridge, store }) => {
  const localHost = "127.0.0.1:18765";
  const record = {
    ...store.getRecord("plug")!,
    approvedPermissions: ["network" as const, "network:local" as const],
    approvedNetworkHosts: [localHost],
  };
  store.upsertRecord(record);
  // Manifest no longer declares network:local — intersection must drop the stale approval.
  const api = bridge.createApi(record, manifest({ permissions: ["network"], network: { hosts: [localHost] } }));
  await assert.rejects(() => api.net.fetch(`http://${localHost}/status`), /HTTPS|network:local|not public|restricted/);
});

await scenario("bare host approval does not authorize a non-default URL port", async ({ bridge, store }) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
  try {
    const record = {
      ...store.getRecord("plug")!,
      approvedPermissions: ["network" as const],
      approvedNetworkHosts: ["1.1.1.1"],
    };
    store.upsertRecord(record);
    const api = bridge.createApi(record, manifest({ permissions: ["network"], network: { hosts: ["1.1.1.1"] } }));
    await assert.rejects(() => api.net.fetch("https://1.1.1.1:8443/"), /host is not approved/);
    const ok = await api.net.fetch("https://1.1.1.1/");
    assert.equal(ok.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await scenario("legacy http.fetch stays GET-only even when network:write is approved", async ({ bridge, store }) => {
  const record = {
    ...store.getRecord("plug")!,
    approvedPermissions: ["network" as const, "network:write" as const],
    approvedNetworkHosts: ["1.1.1.1"],
  };
  store.upsertRecord(record);
  const api = bridge.createApi(record, manifest({ permissions: ["network", "network:write"], network: { hosts: ["1.1.1.1"] } }));
  await assert.rejects(() => api.http.fetch("https://1.1.1.1/", { method: "POST" }), /only supports GET/);
});

await scenario("approved bare hostname does not approve a newly declared host:port entry", async ({ bridge, store }) => {
  const record = {
    ...store.getRecord("plug")!,
    approvedPermissions: ["network" as const, "network:local" as const],
    approvedNetworkHosts: ["127.0.0.1"],
  };
  store.upsertRecord(record);
  const api = bridge.createApi(record, manifest({
    permissions: ["network", "network:local"],
    network: { hosts: ["127.0.0.1:9876"] },
  }));
  await assert.rejects(() => api.net.fetch("http://127.0.0.1:9876/"), /host is not approved/);
});

await scenario("assistant registration is explicit and does not require a permission", async ({ api, bridge }) => {
  let calls = 0;
  api.assistant.registerCapability({
    id: "focus.start",
    description: "Start a focus session.",
    inputSchema: {
      type: "object",
      properties: { minutes: { type: "integer", minimum: 1, maximum: 120 } },
      required: ["minutes"],
      additionalProperties: false,
    },
  }, async (input: Record<string, unknown>) => { calls += 1; return { started: true, minutes: input.minutes }; });

  const discovered = bridge.getAssistantCapabilities("plug");
  assert.equal(discovered.length, 1);
  assert.deepEqual(discovered[0]?.capability, {
    id: "focus.start",
    description: "Start a focus session.",
    inputSchema: {
      type: "object",
      properties: { minutes: { type: "integer", minimum: 1, maximum: 120 } },
      required: ["minutes"],
      additionalProperties: false,
    },
  });
  assert.deepEqual(await bridge.executeAssistantCapability(discovered[0]!.handle, { minutes: 25 }), { started: true, minutes: 25 });
  assert.equal(calls, 1);
});

await scenario("assistant schema rejects unsupported and oversized descriptors", ({ api }) => {
  assert.throws(() => api.assistant.registerCapability({ id: "bad", description: "Bad", inputSchema: { type: "object", anyOf: [] } }, () => ({})), /Unsupported assistant capability schema keyword/);
  assert.throws(() => api.assistant.registerCapability({ id: "bad", description: "Bad", inputSchema: { type: "array", items: { type: "string" } } }, () => ({})), /inputSchema must have type object/);
  assert.throws(() => api.assistant.registerCapability({ id: "bad id", description: "Bad", inputSchema: { type: "object" } }, () => ({})), /Invalid assistant capability id/);
  assert.throws(() => api.assistant.registerCapability({ id: "bad", description: " ", inputSchema: { type: "object" } }, () => ({})), /Invalid assistant capability description/);
  assert.throws(() => api.assistant.registerCapability({ id: "bad", description: "Bad", inputSchema: { type: "object", properties: { value: { type: "string", maxLength: pluginSdkQuotas.assistantStringChars + 1 } } } }, () => ({})), /Invalid assistant capability schema maxLength/);
  assert.throws(() => api.assistant.registerCapability({ id: "bad", description: "Bad", inputSchema: { type: "object", properties: { value: { type: "string", unsupported: true } } } }, () => ({})), /Unsupported assistant capability schema keyword/);
  assert.throws(() => api.assistant.registerCapability({ id: "bad", description: "Bad", inputSchema: { type: "object", properties: Object.fromEntries(Array.from({ length: pluginSdkQuotas.assistantObjectProperties + 1 }, (_, index) => [`p${index}`, { type: "string" }])) } }, () => ({})), /too many properties/);
  assert.throws(() => api.assistant.registerCapability({ id: "bad", description: "Bad", inputSchema: { type: "object", properties: { value: { type: "string", enum: Array.from({ length: pluginSdkQuotas.assistantEnumValues }, () => "x".repeat(pluginSdkQuotas.assistantStringChars)) } } } }, () => ({})), /inputSchema is too large/);
  let deepSchema: Record<string, unknown> = { type: "string" };
  for (let depth = 0; depth <= pluginSdkQuotas.assistantSchemaDepth; depth += 1) deepSchema = { type: "object", properties: { child: deepSchema } };
  assert.throws(() => api.assistant.registerCapability({ id: "bad", description: "Bad", inputSchema: deepSchema }, () => ({})), /too deeply nested|Invalid assistant capability schema/);
});

await scenario("assistant schema validates input before invoking the handler", async ({ api, bridge }) => {
  let calls = 0;
  api.assistant.registerCapability({
    id: "reminder.create",
    description: "Create a reminder.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 20 },
        minutes: { type: "number", minimum: 1, maximum: 120 },
        tags: { type: "array", items: { type: "string", maxLength: 10 }, minItems: 1, maxItems: 2 },
        mode: { type: "string", enum: ["normal", "urgent"] },
        fixed: { type: "boolean", const: true },
      },
      required: ["title", "minutes"],
      additionalProperties: false,
    },
  }, async () => { calls += 1; return { ok: true }; });

  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "reminder.create"), { minutes: 20 }), /title is required/);
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "reminder.create"), { title: "x", minutes: 0 }), /below minimum/);
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "reminder.create"), { title: "x", minutes: "20" }), /must be a number/);
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "reminder.create"), { title: "x", minutes: 20, extra: true }), /unsupported property/);
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "reminder.create"), { title: "x", minutes: 20, tags: [] }), /invalid item count/);
  const sparseTags: string[] = [];
  sparseTags.length = 1;
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "reminder.create"), { title: "x", minutes: 20, tags: sparseTags }), /sparse arrays/);
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "reminder.create"), { title: "x", minutes: 20, mode: "unknown" }), /enum value/);
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "reminder.create"), { title: "x", minutes: 20, fixed: false }), /const/);
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "reminder.create"), { title: "x", minutes: 20, toString: "inherited" }), /unsupported property/);
  assert.equal(calls, 0);
  assert.deepEqual(await bridge.executeAssistantCapability(assistantHandle(bridge, "reminder.create"), { title: "x", minutes: 20, tags: ["work"] }), { ok: true });
  assert.equal(calls, 1);
});

await scenario("assistant capability quota and unregister/re-register semantics are enforced", async ({ api, bridge }) => {
  for (let index = 0; index < pluginSdkQuotas.assistantCapabilities; index += 1) {
    api.assistant.registerCapability({ id: `cap-${index}`, description: "Capability", inputSchema: { type: "object" } }, async () => ({ version: 1 }));
  }
  assert.throws(() => api.assistant.registerCapability({ id: "one-too-many", description: "Capability", inputSchema: { type: "object" } }, () => ({})), /assistant capability quota exceeded/);
  await api.assistant.unregisterCapability("cap-0");
  api.assistant.registerCapability({ id: "one-too-many", description: "Capability", inputSchema: { type: "object" } }, async () => ({ version: 2 }));
  assert.deepEqual(await bridge.executeAssistantCapability(assistantHandle(bridge, "one-too-many"), {}), { version: 2 });
});

await scenario("assistant results are structured, JSON-safe, bounded, and timeout-limited", async ({ api, bridge }) => {
  api.assistant.registerCapability({ id: "invalid-array", description: "Capability", inputSchema: { type: "object" } }, () => [] as never);
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "invalid-array"), {}), /result must be an object/);

  api.assistant.registerCapability({ id: "invalid-circular", description: "Capability", inputSchema: { type: "object" } }, () => {
    const result: Record<string, unknown> = {};
    result.self = result;
    return result;
  });
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "invalid-circular"), {}), /circular/);

  api.assistant.registerCapability({ id: "invalid-date", description: "Capability", inputSchema: { type: "object" } }, () => ({ date: new Date() } as never));
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "invalid-date"), {}), /JSON-compatible/);

  api.assistant.registerCapability({ id: "invalid-size", description: "Capability", inputSchema: { type: "object" } }, () => ({ text: "x".repeat(pluginSdkQuotas.assistantResultBytes) }));
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "invalid-size"), {}), /result.*too large|result.*too long/);

  api.assistant.registerCapability({ id: "handler-error", description: "Capability", inputSchema: { type: "object" } }, () => { throw new Error("handler failed"); });
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "handler-error"), {}), /handler failed/);

  api.assistant.registerCapability({ id: "timeout", description: "Capability", inputSchema: { type: "object" } }, () => new Promise<Record<string, unknown>>(() => undefined));
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "timeout"), {}), /assistant capability timed out/);
});

await scenario("assistant handlers retain normal plugin permission checks", async ({ bridge, store }) => {
  const restrictedRecord = { ...store.getRecord("plug")!, approvedPermissions: ["events", "pet:reaction", "auth"] as const };
  store.upsertRecord(restrictedRecord);
  const restrictedApi = bridge.createApi(restrictedRecord, manifest({ permissions: restrictedRecord.approvedPermissions as unknown as OpenPetsJavascriptPluginManifest["permissions"] }));
  restrictedApi.assistant.registerCapability({ id: "needs-storage", description: "Capability", inputSchema: { type: "object" } }, async () => {
    restrictedApi.storage.set("key", "value");
    return { ok: true };
  });
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "needs-storage"), {}), /storage/);
  restrictedApi.assistant.registerCapability({ id: "needs-status", description: "Capability", inputSchema: { type: "object" } }, async () => {
    restrictedApi.status.clear();
    return { ok: true };
  });
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "needs-status"), {}), /status/);
  restrictedApi.assistant.registerCapability({ id: "needs-commands", description: "Capability", inputSchema: { type: "object" } }, async () => {
    restrictedApi.commands.unregister("missing");
    return { ok: true };
  });
  await assert.rejects(() => bridge.executeAssistantCapability(assistantHandle(bridge, "needs-commands"), {}), /commands/);

  const approvedRecord = { ...store.getRecord("plug")!, approvedPermissions: ["storage"] as const };
  store.upsertRecord(approvedRecord);
  const approvedApi = bridge.createApi(approvedRecord, manifest({ permissions: ["storage"] }));
  approvedApi.assistant.registerCapability({ id: "needs-storage", description: "Capability", inputSchema: { type: "object" } }, async () => {
    approvedApi.storage.set("key", "value");
    return { ok: true };
  });
  assert.deepEqual(await bridge.executeAssistantCapability(assistantHandle(bridge, "needs-storage"), {}), { ok: true });
});

await scenario("assistant clear and generation replacement revoke stale APIs and results", async ({ api, bridge, store }) => {
  let release!: (result: Record<string, unknown>) => void;
  api.assistant.registerCapability({ id: "slow", description: "Capability", inputSchema: { type: "object" } }, () => new Promise<Record<string, unknown>>((resolve) => { release = resolve; }));
  const pending = bridge.executeAssistantCapability(assistantHandle(bridge, "slow"), {});
  await Promise.resolve();
  bridge.clearPlugin("plug");
  assert.deepEqual(bridge.getAssistantCapabilities("plug"), []);
  assert.throws(() => api.assistant.registerCapability({ id: "stale", description: "Capability", inputSchema: { type: "object" } }, () => ({})), /no longer active/);

  const current = store.getRecord("plug")!;
  const freshApi = bridge.createApi(current, manifest());
  freshApi.assistant.registerCapability({ id: "slow", description: "Capability", inputSchema: { type: "object" } }, async () => ({ fresh: true }));
  await assert.rejects(async () => { release({ stale: true }); await pending; }, /no longer active/);
  assert.deepEqual(await bridge.executeAssistantCapability(assistantHandle(bridge, "slow"), {}), { fresh: true });
  assert.throws(() => api.assistant.unregisterCapability("slow"), /no longer active/);
});

await scenario("assistant handler is not started after generation clear", async ({ api, bridge }) => {
  let calls = 0;
  api.assistant.registerCapability({ id: "not-started", description: "Capability", inputSchema: { type: "object" } }, async () => { calls += 1; return { ok: true }; });
  const pending = bridge.executeAssistantCapability(assistantHandle(bridge, "not-started"), {});
  bridge.clearPlugin("plug");
  await assert.rejects(() => pending, /no longer active/);
  assert.equal(calls, 0);
});

type ScenarioContext = {
  api: ReturnType<PluginSdkBridge["createApi"]>;
  bridge: PluginSdkBridge;
  store: PluginStateStore;
  capabilities: TestCapabilities;
};

function assistantHandle(bridge: PluginSdkBridge, capabilityId: string) {
  const capability = bridge.getAssistantCapabilities("plug").find((entry) => entry.capability.id === capabilityId);
  assert.ok(capability, `Expected assistant capability ${capabilityId}.`);
  return capability.handle;
}

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

function manifest(patch: Partial<OpenPetsJavascriptPluginManifest> = {}): OpenPetsJavascriptPluginManifest {
  return {
    manifestVersion: 3,
    id: "plug",
    name: "Plug",
    version: "1.0.0",
    runtime: "javascript",
    sdkVersion: "3.0.0",
    entry: "index.js",
    permissions: patch.permissions ?? ["commands", "events", "storage", "pet:reaction", "auth"],
    assets: { icons: { focus: "assets/focus.svg" } },
    ...(patch.network === undefined ? {} : { network: patch.network }),
  };
}
