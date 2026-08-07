import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OPENPETS_PLUGIN_MANIFEST_FILENAME, type OpenPetsDeclarativePluginManifest, type OpenPetsJavascriptPluginManifest } from "../src/plugin-manifest.js";
import { type PluginPetApi } from "../src/plugin-pet-api.js";
import { PluginRuntime, type PluginRuntimeScheduler, type PluginTimerHandle } from "../src/plugin-runtime.js";
import { createDefaultPluginHostCapabilities } from "../src/plugin-sdk-bridge.js";
import type { PluginJsHost, PluginJsHostInstance, PluginJsHostStartOptions } from "../src/plugin-js-host.js";
import { initializePluginState, type PluginStateStore, type PluginStateRecord } from "../src/plugin-state.js";

let currentRoot = "";

class FakeScheduler implements PluginRuntimeScheduler {
  timers: Array<{ delayMs: number; active: boolean; callback: () => void }> = [];
  setTimeout(callback: () => void, delayMs: number): PluginTimerHandle {
    const timer = { delayMs, active: true, callback };
    this.timers.push(timer);
    return { cancel: () => { timer.active = false; } };
  }
  fire(index = 0): void {
    const timer = this.timers[index];
    if (timer?.active) {
      timer.active = false;
      timer.callback();
    }
  }
  activeCount(): number {
    return this.timers.filter((timer) => timer.active).length;
  }
}

class FakePetApi implements PluginPetApi {
  events: string[] = [];
  fail = false;
  deferredFailure: { reject: (error: Error) => void } | undefined;
  speak(message: string): void {
    if (this.fail) throw new Error("pet api failed");
    this.events.push(`speak:${message}`);
  }
  react(reaction: string): void | Promise<void> {
    if (this.deferredFailure) return new Promise((_resolve, reject) => { this.deferredFailure = { reject }; });
    if (this.fail) throw new Error("pet api failed");
    this.events.push(`react:${reaction}`);
  }
  moveBy(options: { x: number; y: number; durationMs?: number }): void { this.events.push(`moveBy:${options.x},${options.y},${options.durationMs ?? ""}`); }
  wander(options: { distance?: number; durationMs?: number }): void { this.events.push(`wander:${options.distance ?? ""},${options.durationMs ?? ""}`); }
  moveToHome(): void { this.events.push("moveToHome"); }
}

class FakeJsHost implements PluginJsHost {
  starts: PluginJsHostStartOptions[] = [];
  instances: Array<{ stopped: boolean; id: string }> = [];
  fail = false;
  breakBeforeReturn = false;
  async startPlugin(options: PluginJsHostStartOptions): Promise<PluginJsHostInstance> {
    this.starts.push(options);
    if (this.fail) throw new Error("host failed");
    const instance = { stopped: false, id: options.record.id };
    this.instances.push(instance);
    if (options.record.approvedPermissions.includes("commands")) options.sdk?.commands.register({ id: "run", title: "Run" }, () => options.sdk?.status.set("ran"));
    if (this.breakBeforeReturn) options.onBroken("early crash");
    return { stop: () => { instance.stopped = true; } };
  }
}

await scenario("disabled no timers", async ({ store, scheduler }) => {
  addPlugin(store, { enabled: false });
  await runtime(store, scheduler).start();
  assert.equal(scheduler.activeCount(), 0);
});

await scenario("javascript sdk command status storage schedule and permissions", async ({ store, scheduler, petApi }) => {
  const jsHost = new FakeJsHost();
  addPlugin(store, { manifestVersion: 2, runtime: "javascript", approvedPermissions: ["commands", "status", "storage", "schedule", "pet:speak"] }, jsManifest({ permissions: ["commands", "status", "storage", "schedule", "pet:speak"] }));
  const rt = runtime(store, scheduler, petApi, undefined, jsHost);
  await rt.start();
  assert.deepEqual(rt.getPluginState("plug").commands.map((c) => c.id), ["run"]);
  await rt.executeCommand("plug", "run");
  assert.equal(rt.getPluginState("plug").status?.text, "ran");
  jsHost.starts[0].sdk?.storage.set("a", "b");
  assert.equal(jsHost.starts[0].sdk?.storage.get("a"), "b");
  assert.equal(store.getRecord("plug")?.config["storage:a"], undefined);
  jsHost.starts[0].sdk?.schedule.once("s", 1, () => jsHost.starts[0].sdk?.pet.speak("hi"));
  scheduler.fire(0);
  await Promise.resolve();
  assert.deepEqual(petApi.events, ["speak:hi"]);
});

await scenario("javascript sdk permission rejection", async ({ store }) => {
  const jsHost = new FakeJsHost();
  addPlugin(store, { manifestVersion: 2, runtime: "javascript", approvedPermissions: ["commands"] }, jsManifest({ permissions: ["commands"] }));
  await runtime(store, new FakeScheduler(), new FakePetApi(), undefined, jsHost).start();
  assert.throws(() => jsHost.starts[0].sdk?.storage.set("a", "b"), /not approved/);
});

await scenario("javascript sdk pet movement requires pet move permission", async ({ store, scheduler, petApi }) => {
  const jsHost = new FakeJsHost();
  addPlugin(store, { manifestVersion: 2, runtime: "javascript", approvedPermissions: ["pet:move"] }, jsManifest({ permissions: ["pet:move"] }));
  await runtime(store, scheduler, petApi, undefined, jsHost).start();
  await jsHost.starts[0].sdk?.pet.moveBy({ x: 20, y: -10, durationMs: 500 });
  await jsHost.starts[0].sdk?.pet.wander({ distance: 40, durationMs: 700 });
  await jsHost.starts[0].sdk?.pet.moveToHome();
  assert.deepEqual(petApi.events, ["moveBy:20,-10,500", "wander:40,700", "moveToHome"]);
});

await scenario("javascript http fetch allows approved github host", async ({ store }) => {
  const originalFetch = globalThis.fetch;
  const jsHost = new FakeJsHost();
  addPlugin(store, { manifestVersion: 2, runtime: "javascript", approvedPermissions: ["network"], approvedNetworkHosts: ["api.github.com"] }, jsManifest({ permissions: ["network"], network: { hosts: ["api.github.com"] } }));
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", etag: "abc" } })) as typeof fetch;
  try {
    await runtime(store, new FakeScheduler(), new FakePetApi(), undefined, jsHost).start();
    const result = await jsHost.starts[0].sdk?.http.fetch("https://api.github.com/repos/open-pets/openpets/releases");
    assert.equal(result?.status, 200);
    assert.deepEqual(result?.json, { ok: true });
    assert.equal(result?.headers.etag, "abc");
  } finally { globalThis.fetch = originalFetch; }
});

await scenario("javascript http fetch denies unapproved host and non-get", async ({ store }) => {
  const jsHost = new FakeJsHost();
  addPlugin(store, { manifestVersion: 2, runtime: "javascript", approvedPermissions: ["network"], approvedNetworkHosts: ["api.github.com"] }, jsManifest({ permissions: ["network"], network: { hosts: ["api.github.com"] } }));
  await runtime(store, new FakeScheduler(), new FakePetApi(), undefined, jsHost).start();
  await assert.rejects(() => jsHost.starts[0].sdk!.http.fetch("https://example.com/"), /host is not approved/);
  await assert.rejects(() => jsHost.starts[0].sdk!.http.fetch("https://api.github.com/", { method: "POST" }), /only supports GET/);
});

await scenario("javascript http fetch stays GET-only when network:write is approved", async ({ store }) => {
  const jsHost = new FakeJsHost();
  addPlugin(store, {
    manifestVersion: 3,
    runtime: "javascript",
    sdkVersion: "3.0.0",
    approvedPermissions: ["network", "network:write"],
    approvedNetworkHosts: ["1.1.1.1"],
  }, jsManifest({
    manifestVersion: 3,
    sdkVersion: "3.0.0",
    permissions: ["network", "network:write"],
    network: { hosts: ["1.1.1.1"] },
  }));
  await runtime(store, new FakeScheduler(), new FakePetApi(), undefined, jsHost).start();
  await assert.rejects(() => jsHost.starts[0].sdk!.http.fetch("https://1.1.1.1/", { method: "POST" }), /only supports GET/);
});

await scenario("javascript net.fetch with network:local reaches local and public hosts", async ({ store }) => {
  const originalFetch = globalThis.fetch;
  const jsHost = new FakeJsHost();
  const localHost = "127.0.0.1:18766";
  const publicHost = "1.1.1.1";
  globalThis.fetch = (async (input: string | URL) => new Response(String(input).includes("127.0.0.1") ? "local-ok" : "public-ok", { status: 200 })) as typeof fetch;
  try {
    addPlugin(store, {
      manifestVersion: 3,
      runtime: "javascript",
      sdkVersion: "3.0.0",
      approvedPermissions: ["network", "network:local"],
      approvedNetworkHosts: [localHost, publicHost],
    }, jsManifest({
      manifestVersion: 3,
      sdkVersion: "3.0.0",
      permissions: ["network", "network:local"],
      network: { hosts: [localHost, publicHost] },
    }));
    await runtime(store, new FakeScheduler(), new FakePetApi(), undefined, jsHost).start();
    const local = await jsHost.starts[0].sdk!.net.fetch(`http://${localHost}/`);
    assert.equal(local.status, 200);
    assert.equal(local.text, "local-ok");
    const pub = await jsHost.starts[0].sdk!.net.fetch(`https://${publicHost}/`);
    assert.equal(pub.status, 200);
    assert.equal(pub.text, "public-ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await scenario("javascript net.fetch denies stale network:write after manifest removal", async ({ store }) => {
  const jsHost = new FakeJsHost();
  addPlugin(store, {
    manifestVersion: 3,
    runtime: "javascript",
    sdkVersion: "3.0.0",
    approvedPermissions: ["network", "network:write"],
    approvedNetworkHosts: ["1.1.1.1"],
  }, jsManifest({
    manifestVersion: 3,
    sdkVersion: "3.0.0",
    permissions: ["network"],
    network: { hosts: ["1.1.1.1"] },
  }));
  await runtime(store, new FakeScheduler(), new FakePetApi(), undefined, jsHost).start();
  await assert.rejects(() => jsHost.starts[0].sdk!.net.fetch("https://1.1.1.1/", { method: "POST", body: "{}" }), /network:write/);
});

await scenario("javascript net.fetch bare host approval denies non-default port", async ({ store }) => {
  const originalFetch = globalThis.fetch;
  const jsHost = new FakeJsHost();
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
  try {
    addPlugin(store, {
      manifestVersion: 3,
      runtime: "javascript",
      sdkVersion: "3.0.0",
      approvedPermissions: ["network"],
      approvedNetworkHosts: ["1.1.1.1"],
    }, jsManifest({
      manifestVersion: 3,
      sdkVersion: "3.0.0",
      permissions: ["network"],
      network: { hosts: ["1.1.1.1"] },
    }));
    await runtime(store, new FakeScheduler(), new FakePetApi(), undefined, jsHost).start();
    await assert.rejects(() => jsHost.starts[0].sdk!.net.fetch("https://1.1.1.1:8443/"), /host is not approved/);
    const ok = await jsHost.starts[0].sdk!.net.fetch("https://1.1.1.1/");
    assert.equal(ok.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await scenario("javascript net.fetch requires exact approved host:port", async ({ store }) => {
  const jsHost = new FakeJsHost();
  addPlugin(store, {
    manifestVersion: 3,
    runtime: "javascript",
    sdkVersion: "3.0.0",
    approvedPermissions: ["network", "network:local"],
    approvedNetworkHosts: ["127.0.0.1"],
  }, jsManifest({
    manifestVersion: 3,
    sdkVersion: "3.0.0",
    permissions: ["network", "network:local"],
    network: { hosts: ["127.0.0.1:9876"] },
  }));
  await runtime(store, new FakeScheduler(), new FakePetApi(), undefined, jsHost).start();
  await assert.rejects(() => jsHost.starts[0].sdk!.net.fetch("http://127.0.0.1:9876/"), /host is not approved/);
});

await scenario("javascript http fetch rejects oversized response", async ({ store }) => {
  const originalFetch = globalThis.fetch;
  const jsHost = new FakeJsHost();
  addPlugin(store, { manifestVersion: 2, runtime: "javascript", approvedPermissions: ["network"], approvedNetworkHosts: ["api.github.com"] }, jsManifest({ permissions: ["network"], network: { hosts: ["api.github.com"] } }));
  globalThis.fetch = (async () => new Response("x".repeat(4 * 1024 * 1024 + 1), { status: 200 })) as typeof fetch;
  try {
    await runtime(store, new FakeScheduler(), new FakePetApi(), undefined, jsHost).start();
    await assert.rejects(() => jsHost.starts[0].sdk!.http.fetch("https://api.github.com/"), /too large/);
  } finally { globalThis.fetch = originalFetch; }
});

await scenario("javascript plugin starts through host", async ({ store }) => {
  const jsHost = new FakeJsHost();
  addPlugin(store, { manifestVersion: 2, runtime: "javascript", approvedPermissions: [] }, jsManifest());
  await runtime(store, new FakeScheduler(), new FakePetApi(), undefined, jsHost).start();
  assert.equal(jsHost.starts.length, 1);
  assert.equal(store.getRecord("plug")?.brokenReason, undefined);
});

await scenario("javascript stop cancels host", async ({ store }) => {
  const jsHost = new FakeJsHost();
  addPlugin(store, { manifestVersion: 2, runtime: "javascript", approvedPermissions: [] }, jsManifest());
  const rt = runtime(store, new FakeScheduler(), new FakePetApi(), undefined, jsHost);
  await rt.start();
  rt.stop();
  assert.equal(jsHost.instances[0].stopped, true);
});

await scenario("stop drains in-flight javascript startup", async ({ store }) => {
  addPlugin(store, { manifestVersion: 3, runtime: "javascript", sdkVersion: "3.0.0", approvedPermissions: ["voice:listen"] }, jsManifest({ manifestVersion: 3, sdkVersion: "3.0.0", permissions: ["voice:listen"] }));
  let releaseStart!: () => void;
  let startupStarted!: () => void;
  let hostStopped = false;
  let voiceCalls = 0;
  let staleVoiceError = "";
  const startup = new Promise<void>((resolve) => { startupStarted = resolve; });
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  const capabilities = createDefaultPluginHostCapabilities(new FakePetApi());
  capabilities.settings = { ...capabilities.settings, listenAllowed: () => true };
  capabilities.voice = { ...capabilities.voice, listen: async () => { voiceCalls += 1; return { text: "late" }; } };
  const jsHost: PluginJsHost = {
    async startPlugin(options) {
      startupStarted();
      await startGate;
      await options.sdk?.voice.listen({ timeoutMs: 1_000 }).catch((error: unknown) => { staleVoiceError = error instanceof Error ? error.message : String(error); });
      return { stop: () => { hostStopped = true; } };
    },
  };
  const rt = new PluginRuntime({ stateStore: store, petApi: new FakePetApi(), scheduler: new FakeScheduler(), allowedPluginRoots: [currentRoot], jsHost, capabilities });
  const start = rt.start();
  await startup;
  let stopSettled = false;
  const stop = rt.stop().then(() => { stopSettled = true; });
  assert.equal(stopSettled, false);
  releaseStart();
  await Promise.all([start, stop]);
  assert.equal(voiceCalls, 0);
  assert.equal(staleVoiceError, "Plugin is no longer active.");
  assert.equal(hostStopped, true);
});

await scenario("javascript startup failure marks broken", async ({ store }) => {
  const jsHost = new FakeJsHost();
  jsHost.fail = true;
  addPlugin(store, { manifestVersion: 2, runtime: "javascript", approvedPermissions: [] }, jsManifest());
  await runtime(store, new FakeScheduler(), new FakePetApi(), undefined, jsHost).start();
  assert.match(store.getRecord("plug")?.brokenReason ?? "", /host failed/);
});

await scenario("javascript early crash marks broken", async ({ store }) => {
  const jsHost = new FakeJsHost();
  jsHost.breakBeforeReturn = true;
  addPlugin(store, { manifestVersion: 2, runtime: "javascript", approvedPermissions: [] }, jsManifest());
  await runtime(store, new FakeScheduler(), new FakePetApi(), undefined, jsHost).start();
  assert.match(store.getRecord("plug")?.brokenReason ?? "", /early crash/);
});

await scenario("disabled and killed javascript plugins do not start", async ({ store }) => {
  const jsHost = new FakeJsHost();
  addPlugin(store, { manifestVersion: 2, runtime: "javascript", enabled: false, approvedPermissions: [] }, jsManifest());
  addPlugin(store, { id: "killed", manifestVersion: 2, runtime: "javascript", catalogDisabled: true, approvedPermissions: [] }, jsManifest({ id: "killed" }));
  await runtime(store, new FakeScheduler(), new FakePetApi(), undefined, jsHost).start();
  assert.equal(jsHost.starts.length, 0);
});

await scenario("javascript reload replaces host", async ({ store }) => {
  const jsHost = new FakeJsHost();
  addPlugin(store, { manifestVersion: 2, runtime: "javascript", approvedPermissions: [] }, jsManifest());
  const rt = runtime(store, new FakeScheduler(), new FakePetApi(), undefined, jsHost);
  await rt.start();
  await rt.reloadPlugin("plug");
  assert.equal(jsHost.instances[0].stopped, true);
  assert.equal(jsHost.instances[1].stopped, false);
});

await scenario("valid timer schedules and fires", async ({ store, scheduler, petApi }) => {
  addPlugin(store, {}, manifest({ permissions: ["timer", "pet:speak", "pet:reaction"], actions: [{ type: "pet.speak", message: "Stretch" }, { type: "pet.react", reaction: "celebrating" }] }));
  await runtime(store, scheduler, petApi).start();
  assert.equal(scheduler.timers[0].delayMs, 5 * 60_000);
  assert.deepEqual(petApi.events, []);
  scheduler.fire(0);
  await Promise.resolve();
  assert.deepEqual(petApi.events, ["speak:Stretch", "react:celebrating"]);
});

await scenario("config speak and reaction refs execute", async ({ store, scheduler, petApi }) => {
  addPlugin(store, { config: { message: "Hello", reaction: "celebrating" } }, manifest({ permissions: ["timer", "pet:speak", "pet:reaction"], configSchema: { message: { type: "text", default: "Stretch" }, reaction: { type: "select", default: "idle", options: [{ label: "Idle", value: "idle" }, { label: "Celebrate", value: "celebrating" }] } }, actions: [{ type: "pet.speak", message: { config: "message" } }, { type: "pet.react", reaction: { config: "reaction" } }] }));
  await runtime(store, scheduler, petApi).start();
  scheduler.fire(0);
  await Promise.resolve();
  assert.deepEqual(petApi.events, ["speak:Hello", "react:celebrating"]);
});

await scenario("invalid persisted config refs mark broken without api call", async ({ store, scheduler, petApi }) => {
  addPlugin(store, { config: { message: 42 } }, manifest({ configSchema: { message: { type: "text", default: "Stretch" } }, actions: [{ type: "pet.speak", message: { config: "message" } }] }));
  await runtime(store, scheduler, petApi).start();
  assert.match(store.getRecord("plug")?.brokenReason ?? "", /invalid/);
  assert.equal(scheduler.activeCount(), 0);
  assert.deepEqual(petApi.events, []);
});

await scenario("final config message and reaction validation applies", async ({ store }) => {
  addPlugin(store, { config: { message: "https://example.test" } }, manifest({ configSchema: { message: { type: "text", default: "Stretch" } }, actions: [{ type: "pet.speak", message: { config: "message" } }] }));
  await runtime(store, new FakeScheduler()).start();
  assert.match(store.getRecord("plug")?.brokenReason ?? "", /URL/);
});

await scenario("unapproved permission broken", async ({ store, scheduler }) => {
  addPlugin(store, { approvedPermissions: ["timer"] }, manifest({ permissions: ["timer", "pet:speak"] }));
  await runtime(store, scheduler).start();
  assert.match(store.getRecord("plug")?.brokenReason ?? "", /not approved/);
  assert.equal(scheduler.activeCount(), 0);
  assert.equal(store.getRecord("plug")?.enabled, true);
});

await scenario("invalid manifest and id-version mismatch broken", async ({ root, store }) => {
  const first = addPlugin(store, {}, { bad: true });
  await runtime(store, new FakeScheduler()).start();
  assert.match(store.getRecord("plug")?.brokenReason ?? "", /validation failed/);
  addPlugin(store, { id: "other" }, manifest({ id: "plug" }));
  await runtime(store, new FakeScheduler()).start();
  assert.match(store.getRecord("other")?.brokenReason ?? "", /id\/version/);
});

await scenario("invalid reaction and message broken", async ({ store }) => {
  addPlugin(store, {}, manifest({ permissions: ["timer", "pet:reaction"], actions: [{ type: "pet.react", reaction: "celebrate" }] }));
  addPlugin(store, { id: "bad-message" }, manifest({ id: "bad-message", actions: [{ type: "pet.speak", message: "https://example.test" }] }));
  await runtime(store, new FakeScheduler()).start();
  assert.match(store.getRecord("plug")?.brokenReason ?? "", /Invalid pet reaction/);
  assert.match(store.getRecord("bad-message")?.brokenReason ?? "", /URL/);
});

await scenario("config interval below five broken", async ({ store }) => {
  addPlugin(store, { config: { intervalMinutes: 4 } }, manifest({ everyMinutes: { config: "intervalMinutes" }, configSchema: { intervalMinutes: { type: "number", default: 6 } } }));
  await runtime(store, new FakeScheduler()).start();
  assert.match(store.getRecord("plug")?.brokenReason ?? "", /at least 5/);
});

await scenario("stop cancels and stale timers do not fire", async ({ store, scheduler, petApi }) => {
  addPlugin(store);
  const rt = runtime(store, scheduler, petApi);
  await rt.start();
  const stale = scheduler.timers[0];
  rt.stop();
  assert.equal(stale.active, false);
  stale.callback();
  assert.deepEqual(petApi.events, []);
});

await scenario("reload cancels stale timer", async ({ store, scheduler, petApi }) => {
  addPlugin(store);
  const rt = runtime(store, scheduler, petApi);
  await rt.start();
  const stale = scheduler.timers[0];
  await rt.reloadPlugin("plug");
  stale.callback();
  assert.deepEqual(petApi.events, []);
  scheduler.fire(1);
  await Promise.resolve();
  assert.deepEqual(petApi.events, ["speak:Stretch"]);
});

await scenario("reload waits for host teardown", async ({ store, scheduler }) => {
  addPlugin(store);
  let blockTeardown = false;
  let releaseTeardown!: () => void;
  let teardownStartedResolve!: () => void;
  const teardownStarted = new Promise<void>((resolve) => { teardownStartedResolve = resolve; });
  const capabilities = createDefaultPluginHostCapabilities(new FakePetApi());
  (capabilities as { clearPlugin?: () => Promise<void> }).clearPlugin = () => blockTeardown ? new Promise<void>((resolve) => { teardownStartedResolve(); releaseTeardown = resolve; }) : Promise.resolve();
  const rt = new PluginRuntime({ stateStore: store, petApi: new FakePetApi(), scheduler, allowedPluginRoots: [currentRoot], capabilities });
  await rt.start();
  blockTeardown = true;

  const reload = rt.reloadPlugin("plug");
  await teardownStarted;
  assert.equal(scheduler.activeCount(), 0);
  releaseTeardown();
  await reload;
  assert.equal(scheduler.activeCount(), 1);
});

await scenario("concurrent reloads are serialized", async ({ store, scheduler }) => {
  addPlugin(store);
  let blockTeardown = false;
  let releaseTeardown!: () => void;
  let teardownStartedResolve!: () => void;
  const teardownStarted = new Promise<void>((resolve) => { teardownStartedResolve = resolve; });
  const capabilities = createDefaultPluginHostCapabilities(new FakePetApi());
  (capabilities as { clearPlugin?: () => Promise<void> }).clearPlugin = () => blockTeardown ? new Promise<void>((resolve) => { teardownStartedResolve(); releaseTeardown = resolve; }) : Promise.resolve();
  const rt = new PluginRuntime({ stateStore: store, petApi: new FakePetApi(), scheduler, allowedPluginRoots: [currentRoot], capabilities });
  await rt.start();
  blockTeardown = true;

  const first = rt.reloadPlugin("plug");
  const second = rt.reloadPlugin("plug");
  await teardownStarted;
  assert.equal(scheduler.activeCount(), 0);
  releaseTeardown();
  blockTeardown = false;
  await Promise.all([first, second]);
  assert.equal(scheduler.activeCount(), 1);
});

await scenario("path outside install/root and oversized rejected", async ({ root, store }) => {
  const outsideRoot = tempDir();
  addPlugin(store, { installPath: outsideRoot, manifestPath: writeManifest(outsideRoot, manifest()) });
  await runtime(store, new FakeScheduler()).start();
  assert.match(store.getRecord("plug")?.brokenReason ?? "", /outside allowed/);
  const install = join(root, "oversized");
  mkdirSync(install, { recursive: true });
  const path = join(install, OPENPETS_PLUGIN_MANIFEST_FILENAME);
  writeFileSync(path, JSON.stringify(manifest()) + " ".repeat(200), "utf8");
  store.upsertRecord(record({ id: "oversized", installPath: install, manifestPath: path }));
  await new PluginRuntime({ stateStore: store, petApi: new FakePetApi(), scheduler: new FakeScheduler(), allowedPluginRoots: [root], maxManifestBytes: 100 }).start();
  assert.match(store.getRecord("oversized")?.brokenReason ?? "", /too large/);
});

await scenario("manifest outside install rejected", async ({ root, store }) => {
  const goodInstall = join(root, "good");
  const otherInstall = join(root, "other");
  mkdirSync(goodInstall, { recursive: true });
  const manifestPath = writeManifest(otherInstall, manifest());
  store.upsertRecord(record({ installPath: goodInstall, manifestPath }));
  await runtime(store, new FakeScheduler()).start();
  assert.match(store.getRecord("plug")?.brokenReason ?? "", /outside install/);
});

await scenario("root-level evil manifest filename rejected", async ({ root, store }) => {
  const install = join(root, "evil-name");
  mkdirSync(install, { recursive: true });
  const manifestPath = join(install, `evil-${OPENPETS_PLUGIN_MANIFEST_FILENAME}`);
  writeFileSync(manifestPath, JSON.stringify(manifest()), "utf8");
  store.upsertRecord(record({ installPath: install, manifestPath }));
  await runtime(store, new FakeScheduler()).start();
  assert.match(store.getRecord("plug")?.brokenReason ?? "", /manifest path is invalid/);
});

await scenario("reloadAll cancels removed plugin timers", async ({ store, scheduler, petApi }) => {
  addPlugin(store);
  const rt = runtime(store, scheduler, petApi);
  await rt.start();
  const stale = scheduler.timers[0];
  store.removeRecord("plug");
  await rt.reloadAll();
  assert.equal(stale.active, false);
  stale.callback();
  assert.deepEqual(petApi.events, []);
  assert.equal(scheduler.activeCount(), 0);
});

await scenario("invalid configured timer does not fall back to default", async ({ store }) => {
  addPlugin(store, { config: { intervalMinutes: "10" } }, manifest({ everyMinutes: { config: "intervalMinutes" }, configSchema: { intervalMinutes: { type: "number", default: 6 } } }));
  await runtime(store, new FakeScheduler()).start();
  assert.match(store.getRecord("plug")?.brokenReason ?? "", /invalid|must resolve to an integer/);
});

await scenario("timer handles do not accumulate after repeated fires", async ({ store, scheduler, petApi }) => {
  addPlugin(store);
  await runtime(store, scheduler, petApi).start();
  assert.equal(scheduler.activeCount(), 1);
  scheduler.fire(0);
  await Promise.resolve();
  assert.equal(scheduler.activeCount(), 1);
  scheduler.fire(1);
  await Promise.resolve();
  assert.equal(scheduler.activeCount(), 1);
});

await scenario("brokenReason clears and bad plugin not blocking good", async ({ store, scheduler }) => {
  addPlugin(store, { brokenReason: "old" });
  addPlugin(store, { id: "bad" }, manifest({ id: "bad", permissions: ["timer", "pet:reaction"], actions: [{ type: "pet.react", reaction: "celebrate" }] }));
  await runtime(store, scheduler).start();
  assert.equal(store.getRecord("plug")?.brokenReason, undefined);
  assert.match(store.getRecord("bad")?.brokenReason ?? "", /Invalid pet reaction/);
  assert.equal(scheduler.activeCount(), 1);
});

await scenario("pet api failure marks broken", async ({ store, scheduler, petApi }) => {
  addPlugin(store);
  petApi.fail = true;
  await runtime(store, scheduler, petApi).start();
  scheduler.fire(0);
  await Promise.resolve();
  assert.match(store.getRecord("plug")?.brokenReason ?? "", /pet api failed/);
  assert.equal(store.getRecord("plug")?.enabled, true);
});

await scenario("stale reload cannot resurrect disabled plugin", async ({ store, scheduler }) => {
  addPlugin(store);
  const rt = runtime(store, scheduler);
  await rt.start();
  scheduler.timers = [];
  const reload = rt.reloadPlugin("plug");
  const current = store.getRecord("plug");
  assert.ok(current);
  store.upsertRecord({ ...current, enabled: false });
  await rt.reloadPlugin("plug");
  await reload;
  assert.equal(scheduler.activeCount(), 0);
});

await scenario("stale reload cannot resurrect stopped runtime", async ({ store, scheduler }) => {
  addPlugin(store);
  const rt = runtime(store, scheduler);
  await rt.start();
  scheduler.timers = [];
  const reload = rt.reloadPlugin("plug");
  rt.stop();
  await reload;
  assert.equal(scheduler.activeCount(), 0);
});

await scenario("stale async action failure does not break new generation", async ({ store, scheduler, petApi }) => {
  addPlugin(store, {}, manifest({ permissions: ["timer", "pet:reaction"], actions: [{ type: "pet.react", reaction: "celebrating" }] }));
  petApi.deferredFailure = { reject() {} };
  const rt = runtime(store, scheduler, petApi);
  await rt.start();
  scheduler.fire(0);
  const pending = petApi.deferredFailure;
  assert.ok(pending);
  await rt.reloadPlugin("plug");
  pending.reject(new Error("stale failure"));
  await Promise.resolve();
  assert.equal(store.getRecord("plug")?.brokenReason, undefined);
  assert.equal(scheduler.activeCount(), 1);
});

console.error("Plugin runtime validation passed.");

async function scenario(name: string, fn: (ctx: { root: string; store: PluginStateStore; scheduler: FakeScheduler; petApi: FakePetApi }) => Promise<void>): Promise<void> {
  const root = tempDir();
  currentRoot = root;
  const store = initializePluginState({ statePath: join(tempDir(), "state.json") });
  const scheduler = new FakeScheduler();
  const petApi = new FakePetApi();
  try { await fn({ root, store, scheduler, petApi }); } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

function runtime(store: PluginStateStore, scheduler: FakeScheduler, petApi = new FakePetApi(), roots?: string[], jsHost?: PluginJsHost): PluginRuntime {
  return new PluginRuntime({ stateStore: store, petApi, scheduler, allowedPluginRoots: roots ?? [currentRoot], jsHost });
}

function addPlugin(store: PluginStateStore, patch: Partial<PluginStateRecord> = {}, data: unknown = manifest()): PluginStateRecord {
  const root = patch.installPath ? join(patch.installPath, "..") : currentRoot;
  const id = patch.id ?? "plug";
  const installPath = patch.installPath ?? join(root, id);
  const manifestPath = patch.manifestPath ?? writeManifest(installPath, data);
  if (isJsManifest(data)) writeFileSync(join(installPath, data.entry), "OpenPetsPlugin.register();", "utf8");
  const rec = record({ ...patch, id, installPath, manifestPath });
  store.upsertRecord(rec);
  return rec;
}

function record(patch: Partial<PluginStateRecord> = {}): PluginStateRecord {
  return { id: patch.id ?? "plug", version: patch.version ?? "1.0.0", manifestPath: patch.manifestPath ?? "", installPath: patch.installPath ?? "", source: patch.source ?? "local", manifestVersion: patch.manifestVersion, runtime: patch.runtime, sdkVersion: patch.sdkVersion, enabled: patch.enabled ?? true, approvedPermissions: patch.approvedPermissions ?? ["timer", "pet:speak", "pet:reaction"], approvedNetworkHosts: patch.approvedNetworkHosts, config: patch.config ?? {}, brokenReason: patch.brokenReason, catalogDisabled: patch.catalogDisabled };
}

function manifest(patch: Partial<OpenPetsDeclarativePluginManifest> & { everyMinutes?: OpenPetsDeclarativePluginManifest["triggers"][number]["everyMinutes"]; actions?: OpenPetsDeclarativePluginManifest["triggers"][number]["actions"] } = {}): OpenPetsDeclarativePluginManifest {
  return { manifestVersion: 1, id: patch.id ?? "plug", name: "Plug", version: patch.version ?? "1.0.0", runtime: "declarative", permissions: patch.permissions ?? ["timer", "pet:speak"], configSchema: patch.configSchema, triggers: [{ on: "timer", everyMinutes: patch.everyMinutes ?? 5, actions: patch.actions ?? [{ type: "pet.speak", message: "Stretch" }] }] };
}

function jsManifest(patch: Partial<OpenPetsJavascriptPluginManifest> = {}): OpenPetsJavascriptPluginManifest {
  return { manifestVersion: patch.manifestVersion ?? 2, id: patch.id ?? "plug", name: "Plug", version: patch.version ?? "1.0.0", runtime: "javascript", sdkVersion: patch.sdkVersion ?? "1.0.0", entry: patch.entry ?? "index.js", permissions: patch.permissions ?? [], network: patch.network };
}

function isJsManifest(data: unknown): data is OpenPetsJavascriptPluginManifest {
  return typeof data === "object" && data !== null && "runtime" in data && data.runtime === "javascript" && "entry" in data && typeof data.entry === "string";
}

function writeManifest(dir: string, data: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, OPENPETS_PLUGIN_MANIFEST_FILENAME);
  writeFileSync(path, JSON.stringify(data), "utf8");
  return path;
}

function tempDir(): string { return mkdtempSync(join(tmpdir(), "openpets-plugin-runtime-")); }
