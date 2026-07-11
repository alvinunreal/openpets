import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { OPENPETS_PLUGIN_MANIFEST_FILENAME, type OpenPetsDeclarativePluginManifest } from "../src/plugin-manifest.js";
import { PluginService, executeDefaultPetPluginCommand, getDefaultPetPluginCommands, setPluginServiceForTests, stopPluginService } from "../src/plugin-service.js";
import { PluginStateStore, type PluginStateRecord } from "../src/plugin-state.js";

let lastRoot = "";

class FakeRuntime {
  reloads: string[] = [];
  logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  commandState: Record<string, Array<{ id: string; title: string; description?: string; form?: { submitLabel?: string; fields: Array<{ id: string; type: string; label: string }> } }>> = {};
  executed: Array<{ pluginId: string; commandId: string }> = [];
  commandError: Error | null = null;
  stopped = false;
  async start(): Promise<void> {}
  stop(): void { this.stopped = true; }
  async reloadPlugin(id: string): Promise<void> { this.reloads.push(id); }
  getPluginState(id: string): { commands: Array<{ id: string; title: string; description?: string; form?: { submitLabel?: string; fields: Array<{ id: string; type: string; label: string }> } }> } { return { commands: this.commandState[id] ?? [] }; }
  async executeCommand(pluginId: string, commandId: string): Promise<void> { this.executed.push({ pluginId, commandId }); if (this.commandError) throw this.commandError; }
  log(level: string, message: string, fields?: Record<string, unknown>): void { this.logs.push({ level, message, fields }); }
}

class ThrowingStateStore extends PluginStateStore {
  failNextUpsert = false;
  override upsertRecord(record: PluginStateRecord): PluginStateRecord {
    if (this.failNextUpsert) {
      this.failNextUpsert = false;
      throw new Error("state write failed");
    }
    return super.upsertRecord(record);
  }
}

await scenario("initializes store and roots", async ({ userData }) => {
  const service = new PluginService({ userDataPath: userData, petApi: { speak() {}, react() {}, moveBy() {}, wander() {}, moveToHome() {} } });
  await service.start();
  assert.equal(existsSync(join(userData, "plugins")), true);
  assert.equal(existsSync(join(userData, "plugins-dev")), true);
  assert.deepEqual(await service.getSnapshot(), { plugins: [] });
  service.stop();
});

await scenario("snapshot omits paths and includes manifest config", async ({ service, store }) => {
  addPlugin(store, { config: { interval: 7 } }, manifest({ configSchema: { interval: { type: "number", default: 5 } }, everyMinutes: { config: "interval" } }));
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.plugins[0].name, "Plug");
  assert.deepEqual(snapshot.plugins[0].effectiveConfig, { interval: 7 });
  assert.equal("manifestPath" in snapshot.plugins[0], false);
  assert.equal("installPath" in snapshot.plugins[0], false);
});

await scenario("snapshot exposes declared v3 svg icon data url", async ({ root, service, store }) => {
  const installPath = join(root, "openpets.reminders");
  mkdirSync(join(installPath, "assets"), { recursive: true });
  writeFileSync(join(installPath, "index.js"), "export default {};", "utf8");
  writeFileSync(join(installPath, "assets", "reminders.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"10\"/></svg>", "utf8");
  addPlugin(store, { id: "openpets.reminders", version: "1.0.0", installPath }, { manifestVersion: 3, id: "openpets.reminders", name: "Reminders", version: "1.0.0", runtime: "javascript", sdkVersion: "3.0.0", entry: "index.js", icon: "bell", permissions: [], assets: { icons: { reminders: "assets/reminders.svg" } } });
  const snapshot = await service.getSnapshot();
  assert.match(snapshot.plugins[0].iconDataUrl ?? "", /^data:image\/svg\+xml;base64,/);
  assert.equal(Buffer.from((snapshot.plugins[0].iconDataUrl ?? "").split(",")[1] ?? "", "base64").toString("utf8").includes("<svg"), true);
});

await scenario("invalid manifest appears safe broken", async ({ service, store }) => {
  addPlugin(store, {}, { bad: true });
  const snapshot = await service.getSnapshot();
  assert.match(snapshot.plugins[0].brokenReason ?? "", /Plugin manifest validation failed: .*unknown_field/);
});

await scenario("missing manifest does not leak absolute paths", async ({ service, store, root }) => {
  const missingPath = join(root, "missing", OPENPETS_PLUGIN_MANIFEST_FILENAME);
  store.upsertRecord({ id: "missing", version: "1.0.0", manifestPath: missingPath, installPath: join(root, "missing"), source: "local", enabled: true, approvedPermissions: ["timer"], config: {} });
  const snapshot = await service.getSnapshot();
  const reason = snapshot.plugins[0].brokenReason ?? "";
  assert.match(reason, /ENOENT/);
  assert.match(reason, /\[path\]/);
  assert.equal(reason.includes(root), false);
});

await scenario("stored path-like broken reason is sanitized", async ({ service, store, root }) => {
  addPlugin(store, { brokenReason: `ENOENT: no such file or directory, open '${join(root, "plug", OPENPETS_PLUGIN_MANIFEST_FILENAME)}'` });
  const snapshot = await service.getSnapshot();
  const reason = snapshot.plugins[0].brokenReason ?? "";
  assert.equal(reason, "Plugin needs attention. Check logs for details.");
  assert.equal(reason.includes(root), false);
});

await scenario("config save rejects unknown and non plain", async ({ service, store }) => {
  addPlugin(store, {}, manifest({ configSchema: { interval: { type: "number", default: 5 } }, everyMinutes: { config: "interval" } }));
  assert.equal((await service.saveConfig("plug", { unknown: true })).ok, false);
  assert.equal((await service.saveConfig("plug", new Date())).ok, false);
});

await scenario("config save replaces and reloads", async ({ service, store, runtime }) => {
  addPlugin(store, { config: { text: "old", keep: true } }, manifest({ configSchema: { text: { type: "text" } } }));
  const result = await service.saveConfig("plug", { text: "new" });
  assert.equal(result.ok, true);
  assert.deepEqual(store.getRecord("plug")?.config, { text: "new" });
  assert.deepEqual(runtime.reloads, ["plug"]);
});


await scenario("config save reload preserves plugin user sounds", async ({ root, userData, store, runtime }) => {
  const service = new PluginService({ userDataPath: userData, stateStore: store, runtime: runtime as never, allowedPluginRoots: [root] });
  addPlugin(store, { manifestVersion: 3, runtime: "javascript", sdkVersion: "3.0.0", config: { customSound: { kind: "user-sound", id: "a".repeat(32), name: "Bell" } } }, { manifestVersion: 3, id: "plug", name: "Plug", version: "1.0.0", runtime: "javascript", sdkVersion: "3.0.0", entry: "index.js", permissions: [], configSchema: { customSound: { type: "sound" } } });
  const soundDir = join(userData, "plugin-user-sounds", "plug");
  const soundPath = join(soundDir, `${"a".repeat(32)}.ogg`);
  mkdirSync(soundDir, { recursive: true });
  writeFileSync(soundPath, "sound");
  const result = await service.saveConfig("plug", { customSound: { kind: "user-sound", id: "a".repeat(32), name: "Bell" } });
  assert.equal(result.ok, true);
  assert.deepEqual(runtime.reloads, ["plug"]);
  assert.equal(existsSync(soundPath), true);
});

await scenario("pickConfigSound logs stages and useful unsupported format error", async ({ root, store, runtime }) => {
  const selectedPath = join(root, "tone.flac");
  writeFileSync(selectedPath, "sound");
  const service = new PluginService({
    stateStore: store,
    runtime: runtime as never,
    allowedPluginRoots: [root],
    showSoundOpenDialog: async () => ({ canceled: false, filePaths: [selectedPath] }),
    capabilities: { audio: { importUserSoundFromPath: async () => { throw new Error("Plugin sound format is not supported."); } } } as never,
  });
  addPlugin(store, { manifestVersion: 3, runtime: "javascript", sdkVersion: "3.0.0" }, { manifestVersion: 3, id: "plug", name: "Plug", version: "1.0.0", runtime: "javascript", sdkVersion: "3.0.0", entry: "index.js", permissions: [], configSchema: { customSound: { type: "sound" } } });
  const result = await service.pickConfigSound("plug");
  assert.equal(result.ok, false);
  assert.equal(result.error, "Plugin sound format is not supported.");
  assert.equal(runtime.logs.some((entry) => entry.message === "Plugin config sound pick requested." && entry.fields?.pluginId === "plug"), true);
  assert.equal(runtime.logs.some((entry) => entry.message === "Plugin config sound picker opened."), true);
  const selectedLog = runtime.logs.find((entry) => entry.message === "Plugin config sound file selected.");
  assert.equal(selectedLog?.fields?.basename, basename(selectedPath));
  assert.equal(selectedLog?.fields?.ext, ".flac");
  assert.equal(selectedLog?.fields?.sizeBytes, 5);
  assert.equal(Object.values(selectedLog?.fields ?? {}).some((value) => typeof value === "string" && value.includes(root)), false);
  assert.equal(runtime.logs.some((entry) => entry.message === "Plugin config sound import failed." && entry.fields?.reason === "Plugin sound format is not supported."), true);
});

await scenario("pickConfigSound returns opaque sound and logs success", async ({ root, store, runtime }) => {
  const selectedPath = join(root, "ding.ogg");
  writeFileSync(selectedPath, "sound");
  const service = new PluginService({
    stateStore: store,
    runtime: runtime as never,
    allowedPluginRoots: [root],
    showSoundOpenDialog: async () => ({ canceled: false, filePaths: [selectedPath] }),
    capabilities: { audio: { importUserSoundFromPath: async (pluginId: string, path: string) => ({ kind: "user-sound", id: "abc123", name: basename(path) }) } } as never,
  });
  addPlugin(store, { manifestVersion: 3, runtime: "javascript", sdkVersion: "3.0.0" }, { manifestVersion: 3, id: "plug", name: "Plug", version: "1.0.0", runtime: "javascript", sdkVersion: "3.0.0", entry: "index.js", permissions: [], configSchema: { customSound: { type: "sound" } } });
  const result = await service.pickConfigSound("plug");
  assert.equal(result.ok, true);
  assert.equal("sound" in result, true);
  if (!("sound" in result)) throw new Error("Expected picked sound result.");
  assert.deepEqual(result.sound, { kind: "user-sound", id: "abc123", name: "ding.ogg" });
  assert.equal(runtime.logs.some((entry) => entry.message === "Plugin config sound import succeeded." && entry.fields?.pluginId === "plug" && entry.fields?.soundId === "abc123" && entry.fields?.name === "ding.ogg"), true);
});

await scenario("enable disable persists and reloads", async ({ service, store, runtime }) => {
  addPlugin(store, { enabled: false });
  const result = await service.setEnabled("plug", true);
  assert.equal(result.ok, true);
  assert.equal(store.getRecord("plug")?.enabled, true);
  assert.deepEqual(runtime.reloads, ["plug"]);
});

await scenario("reload unknown is safe error", async ({ service }) => {
  const result = await service.reload("missing");
  assert.equal(result.ok, false);
  assert.match(result.error, /not installed/);
});

await scenario("uninstall clears plugin user sounds", async ({ userData, root, store }) => {
  mkdirSync(join(userData, "plugins"), { recursive: true });
  mkdirSync(join(userData, "plugins-dev"), { recursive: true });
  const runtime = new FakeRuntime();
  const service = new PluginService({ userDataPath: userData, stateStore: store, runtime: runtime as never, allowedPluginRoots: [root] });
  addPlugin(store, { source: "catalog", installPath: join(userData, "plugins", "plug") });
  const soundDir = join(userData, "plugin-user-sounds", "plug");
  mkdirSync(soundDir, { recursive: true });
  writeFileSync(join(soundDir, "a".repeat(32) + ".ogg"), "sound");
  const result = await service.uninstall("plug");
  assert.equal(result.ok, true);
  assert.equal(existsSync(soundDir), false);
});

await scenario("stop cancels runtime", async ({ service, runtime }) => {
  service.stop();
  assert.equal(runtime.stopped, true);
});

await localScenario("loadLocal snapshots manifest enabled", async ({ service, store, runtime, source }) => {
  writeManifest(source, manifest({ id: "local-plug", permissions: ["timer", "pet:speak"] }));
  const result = await service.loadLocal();
  assert.equal(result.ok, true);
  const record = store.getRecord("local-plug");
  assert.equal(record?.enabled, true);
  assert.equal(record?.source, "local");
  assert.deepEqual(record?.approvedPermissions, ["pet:speak", "timer"]);
  assert.deepEqual(runtime.reloads, ["local-plug"]);
  assert.equal(existsSync(join(record?.installPath ?? "", OPENPETS_PLUGIN_MANIFEST_FILENAME)), true);
  assert.equal("installPath" in result.snapshot.plugins[0], false);
});

await localScenario("loadLocal picker cancel does not install", async ({ service, store }) => {
  service["__cancelPicker"] = true;
  const result = await service.loadLocal();
  assert.equal(result.ok, true);
  assert.deepEqual(store.listRecords(), []);
});

await localScenario("loadLocal permission cancel does not install", async ({ service, store, source }) => {
  writeManifest(source, manifest({ id: "cancel-plug" }));
  service["__denyPermissions"] = true;
  const result = await service.loadLocal();
  assert.equal(result.ok, true);
  assert.deepEqual(store.listRecords(), []);
  assert.equal(existsSync(join(service["__userData"] as string, "plugins-dev", "cancel-plug", OPENPETS_PLUGIN_MANIFEST_FILENAME)), false);
});

await localScenario("loadLocal permission cancel preserves previous snapshot", async ({ service, store, source, userData }) => {
  writeManifest(source, manifest({ id: "keep-plug", version: "2.0.0", permissions: ["timer", "pet:speak", "pet:reaction"], triggers: [{ on: "timer", everyMinutes: 5, actions: [{ type: "pet.react", reaction: "celebrating" }] }] }));
  const install = join(userData, "plugins-dev", "keep-plug");
  const oldManifestPath = writeManifest(install, manifest({ id: "keep-plug", version: "1.0.0", permissions: ["timer", "pet:speak"] }));
  store.upsertRecord({ id: "keep-plug", version: "1.0.0", installPath: install, manifestPath: oldManifestPath, source: "local", enabled: true, approvedPermissions: ["timer", "pet:speak"], config: {} });
  service["__denyPermissions"] = true;
  const result = await service.loadLocal();
  assert.equal(result.ok, true);
  assert.equal(store.getRecord("keep-plug")?.version, "1.0.0");
  assert.equal(JSON.parse(readFileSync(oldManifestPath, "utf8")).version, "1.0.0");
});

await localScenario("loadLocal rejects invalid manifest safely", async ({ service, source, root }) => {
  writeManifest(source, { bad: true });
  const result = await service.loadLocal();
  assert.equal(result.ok, false);
  assert.equal(result.error.includes(root), false);
  assert.match(result.error, /Plugin manifest validation failed: .*unknown_field/);
});

await localScenario("loadLocal rejects source symlink", async ({ service, source, root }) => {
  writeManifest(source, manifest({ id: "symlink-folder" }));
  const link = join(root, "source-link");
  symlinkSync(source, link, "dir");
  service["__source"] = link;
  const result = await service.loadLocal();
  assert.equal(result.ok, false);
});

await localScenario("loadLocal rejects manifest symlink", async ({ service, source, root }) => {
  const real = join(root, "real-manifest.json");
  writeFileSync(real, JSON.stringify(manifest({ id: "symlink-manifest" })), "utf8");
  symlinkSync(real, join(source, OPENPETS_PLUGIN_MANIFEST_FILENAME));
  const result = await service.loadLocal();
  assert.equal(result.ok, false);
});

await localScenario("loadLocal reload preserves enabled for subset permissions", async ({ service, store, runtime, source, userData }) => {
  writeManifest(source, manifest({ id: "reload-plug", version: "2.0.0", permissions: ["timer", "pet:speak"] }));
  const existingInstall = join(userData, "plugins-dev", "reload-plug");
  const existingManifest = writeManifest(existingInstall, manifest({ id: "reload-plug", permissions: ["timer", "pet:speak"] }));
  store.upsertRecord({ id: "reload-plug", version: "1.0.0", installPath: existingInstall, manifestPath: existingManifest, source: "local", enabled: true, approvedPermissions: ["timer", "pet:speak"], config: {} });
  const result = await service.loadLocal();
  assert.equal(result.ok, true);
  assert.equal(store.getRecord("reload-plug")?.enabled, true);
  assert.equal(store.getRecord("reload-plug")?.version, "2.0.0");
  assert.deepEqual(runtime.reloads, ["reload-plug"]);
});

await localScenario("loadLocal rejects catalog collision", async ({ service, store, source, userData }) => {
  writeManifest(source, manifest({ id: "catalog-plug" }));
  const install = join(userData, "plugins", "catalog-plug");
  const manifestPath = writeManifest(install, manifest({ id: "catalog-plug" }));
  store.upsertRecord({ id: "catalog-plug", version: "1.0.0", installPath: install, manifestPath, source: "catalog", enabled: false, approvedPermissions: ["timer", "pet:speak"], config: {} });
  const result = await service.loadLocal();
  assert.equal(result.ok, false);
  assert.match(result.error, /catalog plugin/);
  assert.equal(existsSync(join(userData, "plugins-dev", "catalog-plug", OPENPETS_PLUGIN_MANIFEST_FILENAME)), false);
});

await localScenario("loadLocal rejects destination symlink before write", async ({ service, source, userData, root }) => {
  writeManifest(source, manifest({ id: "dest-link" }));
  const outside = join(root, "outside-target");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(userData, "plugins-dev", "dest-link"), "dir");
  const result = await service.loadLocal();
  assert.equal(result.ok, false);
  assert.equal(existsSync(join(outside, OPENPETS_PLUGIN_MANIFEST_FILENAME)), false);
});

await localScenario("loadLocal permission change preserves enabled after approval", async ({ service, store, source, userData }) => {
  writeManifest(source, manifest({ id: "perm-plug", permissions: ["timer", "pet:speak", "pet:reaction"], triggers: [{ on: "timer", everyMinutes: 5, actions: [{ type: "pet.react", reaction: "celebrating" }] }] }));
  const install = join(userData, "plugins-dev", "perm-plug");
  const manifestPath = writeManifest(install, manifest({ id: "perm-plug", permissions: ["timer", "pet:speak"] }));
  store.upsertRecord({ id: "perm-plug", version: "1.0.0", installPath: install, manifestPath, source: "local", enabled: true, approvedPermissions: ["timer", "pet:speak"], config: {} });
  const result = await service.loadLocal();
  assert.equal(result.ok, true);
  assert.equal(store.getRecord("perm-plug")?.enabled, true);
  assert.deepEqual(store.getRecord("perm-plug")?.approvedPermissions, ["pet:speak", "pet:reaction", "timer"]);
  assert.deepEqual(service["__runtimeReloads"], ["perm-plug"]);
});

await localScenario("loadLocal uses real source path", async ({ service, source }) => {
  writeManifest(source, manifest({ id: "realpath-plug" }));
  const result = await service.loadLocal();
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.plugins[0].id, "realpath-plug");
});

await localScenario("loadLocal copies only manifest", async ({ service, source, store, userData }) => {
  writeManifest(source, manifest({ id: "only-manifest" }));
  writeFileSync(join(source, "extra.txt"), "extra", "utf8");
  const result = await service.loadLocal();
  assert.equal(result.ok, true);
  const install = store.getRecord("only-manifest")?.installPath ?? join(userData, "plugins-dev", "only-manifest");
  assert.equal(existsSync(join(install, OPENPETS_PLUGIN_MANIFEST_FILENAME)), true);
  assert.equal(existsSync(join(install, "extra.txt")), false);
});

await localScenario("loadLocal snapshots javascript entry", async ({ service, source, store, userData }) => {
  writeManifest(source, { manifestVersion: 2, id: "js-local", name: "JS Local", version: "1.0.0", runtime: "javascript", sdkVersion: "1.0.0", entry: "index.mjs", permissions: ["pet:speak"] });
  writeFileSync(join(source, "index.mjs"), "export default {};\n", "utf8");
  const result = await service.loadLocal();
  assert.equal(result.ok, true);
  const install = store.getRecord("js-local")?.installPath ?? join(userData, "plugins-dev", "js-local");
  assert.equal(existsSync(join(install, OPENPETS_PLUGIN_MANIFEST_FILENAME)), true);
  assert.equal(readFileSync(join(install, "index.mjs"), "utf8"), "export default {};\n");
});

await localScenario("loadLocal snapshots v3 locale catalogs for translated UI", async ({ service, source, store, userData, runtime }) => {
  writeManifest(source, {
    manifestVersion: 3,
    id: "i18n-local",
    name: "$t:plugin.name",
    description: "$t:plugin.description",
    version: "1.0.0",
    runtime: "javascript",
    sdkVersion: "3.0.0",
    entry: "index.js",
    permissions: ["pet:speak"],
    configSchema: {
      enabled: { type: "boolean", default: true, label: "$t:config.enabled.label", description: "$t:config.enabled.description" },
    },
  });
  writeFileSync(join(source, "index.js"), "OpenPetsPlugin.register({ start() {} });\n", "utf8");
  mkdirSync(join(source, "locales"), { recursive: true });
  writeFileSync(join(source, "locales", "en.json"), JSON.stringify({
    "plugin.name": "Translated Plugin",
    "plugin.description": "Translated description.",
    "config.enabled.label": "Translated toggle",
    "config.enabled.description": "Translated toggle description.",
    "command.run.title": "Translated command",
    "command.run.description": "Translated command description.",
    "command.run.submit": "Translated submit",
    "form.message.label": "Translated message",
  }), "utf8");

  const result = await service.loadLocal();
  assert.equal(result.ok, true);
  const install = store.getRecord("i18n-local")?.installPath ?? join(userData, "plugins-dev", "i18n-local");
  assert.equal(existsSync(join(install, "locales", "en.json")), true);
  const plugin = result.snapshot.plugins[0];
  assert.equal(plugin.name, "Translated Plugin");
  assert.equal(plugin.description, "Translated description.");
  assert.equal(plugin.configSchema?.enabled?.label, "Translated toggle");
  assert.equal(plugin.configSchema?.enabled?.description, "Translated toggle description.");

  runtime.commandState["i18n-local"] = [{ id: "run", title: "$t:command.run.title", description: "$t:command.run.description", form: { submitLabel: "$t:command.run.submit", fields: [{ id: "message", type: "text", label: "$t:form.message.label" }] } } as never];
  const refreshed = (await service.getSnapshot()).plugins[0];
  assert.equal(refreshed.commands?.[0]?.title, "Translated command");
  assert.equal(refreshed.commands?.[0]?.description, "Translated command description.");
  assert.equal(refreshed.commands?.[0]?.form?.submitLabel, "Translated submit");
  assert.equal(refreshed.commands?.[0]?.form?.fields[0]?.label, "Translated message");
});

await localScenario("bundled seeding copies manifest and preserves user choices", async ({ userData, root, store }) => {
  const official = join(root, "official");
  const source = join(official, "openpets.reminders");
  writeManifest(source, { manifestVersion: 2, id: "openpets.reminders", name: "Quick Reminders", version: "1.0.0", runtime: "javascript", sdkVersion: "1.0.0", entry: "index.js", permissions: ["pet:speak"], configSchema: { minutes: { type: "number", default: 30 } } });
  writeFileSync(join(source, "index.js"), "OpenPetsPlugin.register({ start() {} });\n", "utf8");
  const service = new PluginService({ userDataPath: userData, stateStore: store, runtime: new FakeRuntime() as never, bundledPluginSourceDirs: [official] });
  await service.start();
  let record = store.getRecord("openpets.reminders");
  assert.equal(record?.source, "catalog");
  assert.equal(record?.bundled, true);
  assert.equal(record?.enabled, true);
  assert.equal(readFileSync(join(record?.installPath ?? "", "index.js"), "utf8"), "OpenPetsPlugin.register({ start() {} });\n");
  store.replaceConfig("openpets.reminders", { minutes: 45 });
  store.setEnabled("openpets.reminders", false);
  writeManifest(source, { manifestVersion: 2, id: "openpets.reminders", name: "Quick Reminders", version: "2.0.0", runtime: "javascript", sdkVersion: "1.0.0", entry: "index.js", permissions: ["pet:speak", "pet:reaction"] });
  await service.seedBundledPlugins();
  record = store.getRecord("openpets.reminders");
  assert.equal(record?.version, "2.0.0");
  assert.equal(record?.enabled, false);
  assert.deepEqual(record?.config, { minutes: 45 });
  assert.deepEqual(record?.approvedPermissions, ["pet:speak", "pet:reaction"]);
});

await localScenario("bundled defaults enable Focus Buddy and Launch Buddy but not Virtual Pet on a fresh install", async ({ userData, root, store }) => {
  const official = join(root, "official");
  const focusSource = join(official, "openpets.focus-buddy");
  const launchSource = join(official, "openpets.launch-buddy");
  const virtualPetSource = join(official, "openpets.virtual-pet");
  writeManifest(focusSource, { manifestVersion: 2, id: "openpets.focus-buddy", name: "Focus Buddy", version: "1.0.0", runtime: "javascript", sdkVersion: "1.0.0", entry: "index.js", permissions: ["pet:speak"] });
  writeManifest(launchSource, { manifestVersion: 2, id: "openpets.launch-buddy", name: "Launch Buddy", version: "1.0.0", runtime: "javascript", sdkVersion: "1.0.0", entry: "index.js", permissions: ["pet:speak"] });
  writeManifest(virtualPetSource, { manifestVersion: 2, id: "openpets.virtual-pet", name: "Virtual Pet", version: "1.0.0", runtime: "javascript", sdkVersion: "1.0.0", entry: "index.js", permissions: ["pet:speak"] });
  writeFileSync(join(focusSource, "index.js"), "OpenPetsPlugin.register({ start() {} });\n", "utf8");
  writeFileSync(join(launchSource, "index.js"), "OpenPetsPlugin.register({ start() {} });\n", "utf8");
  writeFileSync(join(virtualPetSource, "index.js"), "OpenPetsPlugin.register({ start() {} });\n", "utf8");
  const service = new PluginService({ userDataPath: userData, stateStore: store, runtime: new FakeRuntime() as never, bundledPluginSourceDirs: [official] });

  await service.start();

  assert.equal(store.getRecord("openpets.focus-buddy")?.enabled, true);
  assert.equal(store.getRecord("openpets.launch-buddy")?.enabled, true);
  assert.equal(store.getRecord("openpets.virtual-pet")?.enabled, false);
});

await localScenario("bundled seeding prunes stale ids and blocks uninstall update", async ({ userData, root, store }) => {
  const oldInstall = join(userData, "plugins", "openpets.pomodoro");
  const oldManifest = writeManifest(oldInstall, manifest({ id: "openpets.pomodoro" }));
  store.upsertRecord({ id: "openpets.pomodoro", version: "1.0.0", installPath: oldInstall, manifestPath: oldManifest, source: "catalog", enabled: true, approvedPermissions: ["timer", "pet:speak"], config: {} });
  const official = join(root, "official");
  const source = join(official, "openpets.reminders");
  writeManifest(source, { manifestVersion: 2, id: "openpets.reminders", name: "Quick Reminders", version: "1.0.0", runtime: "javascript", sdkVersion: "1.0.0", entry: "index.js", permissions: ["network"], network: { hosts: ["api.github.com"] } });
  writeFileSync(join(source, "index.js"), "OpenPetsPlugin.register({ start() {} });\n", "utf8");
  const service = new PluginService({ userDataPath: userData, stateStore: store, runtime: new FakeRuntime() as never, bundledPluginSourceDirs: [official] });
  await service.start();
  assert.equal(store.getRecord("openpets.pomodoro"), undefined);
  assert.equal(store.getRecord("openpets.reminders")?.enabled, true);
  assert.deepEqual(store.getRecord("openpets.reminders")?.approvedNetworkHosts, ["api.github.com"]);
  assert.equal((await service.uninstall("openpets.reminders")).ok, false);
  const update = await service.updateCatalog("openpets.reminders");
  assert.equal(update.ok, false);
  assert.match(update.error, /Bundled plugins update/);
});

await localScenario("bundled seeding prunes stale local old ids", async ({ userData, store }) => {
  const oldInstall = join(userData, "plugins-dev", "openpets.daily-reminders");
  const oldManifest = writeManifest(oldInstall, manifest({ id: "openpets.daily-reminders" }));
  store.upsertRecord({ id: "openpets.daily-reminders", version: "1.0.0", installPath: oldInstall, manifestPath: oldManifest, source: "local", enabled: true, approvedPermissions: ["timer", "pet:speak"], config: {} });
  const service = new PluginService({ userDataPath: userData, stateStore: store, runtime: new FakeRuntime() as never, bundledPluginSourceDirs: [] });
  await service.seedBundledPlugins();
  assert.equal(store.getRecord("openpets.daily-reminders"), undefined);
  assert.equal(existsSync(oldInstall), false);
});

await localScenario("bundled stale prune refuses unsafe path", async ({ userData, root, store }) => {
  const outside = join(root, "outside-stale");
  mkdirSync(outside, { recursive: true });
  const link = join(userData, "plugins", "openpets.pomodoro");
  symlinkSync(outside, link, "dir");
  store.upsertRecord({ id: "openpets.pomodoro", version: "1.0.0", installPath: link, manifestPath: join(link, OPENPETS_PLUGIN_MANIFEST_FILENAME), source: "catalog", enabled: true, approvedPermissions: ["timer", "pet:speak"], config: {} });
  const runtime = new FakeRuntime();
  const service = new PluginService({ userDataPath: userData, stateStore: store, runtime: runtime as never, bundledPluginSourceDirs: [] });
  await service.seedBundledPlugins();
  assert.equal(store.getRecord("openpets.pomodoro")?.id, "openpets.pomodoro");
  assert.equal(existsSync(outside), true);
  assert.equal(runtime.logs.some((entry) => entry.message.includes("Refused to prune")), true);
});

await localScenario("bundled seeding rejects plugins root symlink", async ({ userData, root, store }) => {
  rmSync(join(userData, "plugins"), { recursive: true, force: true });
  const outsideRoot = join(root, "outside-plugins");
  mkdirSync(outsideRoot, { recursive: true });
  symlinkSync(outsideRoot, join(userData, "plugins"), "dir");
  const official = join(root, "official");
  const source = join(official, "openpets.reminders");
  writeManifest(source, { manifestVersion: 2, id: "openpets.reminders", name: "Quick Reminders", version: "1.0.0", runtime: "javascript", sdkVersion: "1.0.0", entry: "index.js", permissions: ["pet:speak"] });
  writeFileSync(join(source, "index.js"), "OpenPetsPlugin.register({ start() {} });\n", "utf8");
  const runtime = new FakeRuntime();
  const service = new PluginService({ userDataPath: userData, stateStore: store, runtime: runtime as never, bundledPluginSourceDirs: [official] });
  await service.seedBundledPlugins();
  assert.equal(store.getRecord("openpets.reminders"), undefined);
  assert.equal(existsSync(join(outsideRoot, "openpets.reminders")), false);
  assert.equal(runtime.logs.some((entry) => entry.message.includes("Bundled plugin seed failed")), true);
});

await localScenario("start skips bundled seeding when disabled", async ({ userData, root, store }) => {
  const official = join(root, "official");
  const source = join(official, "openpets.reminders");
  writeManifest(source, { manifestVersion: 2, id: "openpets.reminders", name: "Quick Reminders", version: "1.0.0", runtime: "javascript", sdkVersion: "1.0.0", entry: "index.js", permissions: ["pet:speak"] });
  writeFileSync(join(source, "index.js"), "OpenPetsPlugin.register({ start() {} });\n", "utf8");
  const service = new PluginService({ userDataPath: userData, stateStore: store, runtime: new FakeRuntime() as never, bundledPluginSourceDirs: [official], seedBundledPlugins: false });
  await service.start();
  assert.equal(store.getRecord("openpets.reminders"), undefined);
});

await scenario("catalog metadata ignores bundled records", async ({ userData, store, runtime }) => {
  const install = join(userData, "plugins", "openpets.break-buddy");
  const manifestPath = writeManifest(install, manifest({ id: "openpets.break-buddy" }));
  store.upsertRecord({ id: "openpets.break-buddy", version: "1.0.0", installPath: install, manifestPath, source: "catalog", bundled: true, enabled: true, approvedPermissions: ["timer", "pet:speak"], config: {} });
  const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), plugins: [{ ...catalogEntry("openpets.break-buddy", "1.0.0"), disabled: true, statusReason: "disabled" }] }), { status: 200 });
  const service = new PluginService({ userDataPath: userData, stateStore: store, runtime: runtime as never, fetchImpl });
  await service.getCatalogSnapshot(true);
  assert.equal(store.getRecord("openpets.break-buddy")?.enabled, true);
  assert.equal(store.getRecord("openpets.break-buddy")?.catalogDisabled, undefined);
});

await localScenario("loadLocalPath auto-approves explicit dev path", async ({ service, source, store }) => {
  writeManifest(source, { manifestVersion: 2, id: "dev-js", name: "Dev JS", version: "1.0.0", runtime: "javascript", sdkVersion: "1.0.0", entry: "index.js", permissions: ["network"], network: { hosts: ["api.github.com"] } });
  writeFileSync(join(source, "index.js"), "OpenPetsPlugin.register({ start() {} });\n", "utf8");
  service["__denyPermissions"] = true;
  const result = await service.loadLocalPath(source, { autoApprove: true });
  assert.equal(result.ok, true);
  assert.deepEqual(store.getRecord("dev-js")?.approvedPermissions, ["network"]);
  assert.deepEqual(store.getRecord("dev-js")?.approvedNetworkHosts, ["api.github.com"]);
});

await localScenario("loadLocalRoots loads children and reports bad plugins", async ({ service, root, store }) => {
  const pluginsRoot = join(root, "official");
  const good = join(pluginsRoot, "good");
  const bad = join(pluginsRoot, "bad");
  writeManifest(good, manifest({ id: "root-good" }));
  writeManifest(bad, { bad: true });
  const results = await service.loadLocalRoots([pluginsRoot], { autoApprove: true });
  assert.equal(results.length, 2);
  assert.equal(results.some((result) => result.ok), true);
  assert.equal(results.some((result) => !result.ok), true);
  assert.equal(store.getRecord("root-good")?.source, "local");
});

await localScenario("loadLocalRoots prunes stale plugins-dev records", async ({ service, root, userData, store }) => {
  const pluginsRoot = join(root, "official");
  const good = join(pluginsRoot, "good");
  writeManifest(good, manifest({ id: "root-good" }));
  const staleInstall = join(userData, "plugins-dev", "old-sample");
  const staleManifest = writeManifest(staleInstall, manifest({ id: "old-sample" }));
  store.upsertRecord({ id: "old-sample", version: "1.0.0", installPath: staleInstall, manifestPath: staleManifest, source: "local", enabled: true, approvedPermissions: ["timer", "pet:speak"], config: {} });
  const results = await service.loadLocalRoots([pluginsRoot], { autoApprove: true, pruneStale: true });
  assert.equal(results.some((result) => result.ok && result.id === "root-good"), true);
  assert.equal(store.getRecord("root-good")?.source, "local");
  assert.equal(store.getRecord("old-sample"), undefined);
  assert.equal(existsSync(staleInstall), false);
});

await localScenario("loadLocal rejects javascript nested entry symlink", async ({ service, source, root }) => {
  writeManifest(source, { manifestVersion: 2, id: "js-entry-link", name: "JS Entry Link", version: "1.0.0", runtime: "javascript", sdkVersion: "1.0.0", entry: "nested/index.mjs", permissions: ["pet:speak"] });
  mkdirSync(join(source, "nested"), { recursive: true });
  const real = join(root, "real-entry.mjs");
  writeFileSync(real, "export default {};\n", "utf8");
  symlinkSync(real, join(source, "nested", "index.mjs"));
  const result = await service.loadLocal();
  assert.equal(result.ok, false);
});

await localScenario("loadLocal rejects javascript symlinked entry parent", async ({ service, source, root }) => {
  writeManifest(source, { manifestVersion: 2, id: "js-parent-link", name: "JS Parent Link", version: "1.0.0", runtime: "javascript", sdkVersion: "1.0.0", entry: "nested/index.mjs", permissions: ["pet:speak"] });
  const realNested = join(root, "real-nested");
  mkdirSync(realNested, { recursive: true });
  writeFileSync(join(realNested, "index.mjs"), "export default {};\n", "utf8");
  symlinkSync(realNested, join(source, "nested"), "dir");
  const result = await service.loadLocal();
  assert.equal(result.ok, false);
});

await localScenario("uninstall removes state reloads and rejects symlink deletion", async ({ service, store, runtime, userData, root }) => {
  const install = join(userData, "plugins", "remove-plug");
  const manifestPath = writeManifest(install, manifest({ id: "remove-plug" }));
  store.upsertRecord({ id: "remove-plug", version: "1.0.0", installPath: install, manifestPath, source: "catalog", enabled: true, approvedPermissions: ["timer", "pet:speak"], config: {} });
  const result = await service.uninstall("remove-plug");
  assert.equal(result.ok, true);
  assert.equal(store.getRecord("remove-plug"), undefined);
  assert.deepEqual(runtime.reloads, ["remove-plug"]);

  const outside = join(root, "outside-remove");
  mkdirSync(outside, { recursive: true });
  const link = join(userData, "plugins", "link-plug");
  symlinkSync(outside, link, "dir");
  store.upsertRecord({ id: "link-plug", version: "1.0.0", installPath: link, manifestPath: join(link, OPENPETS_PLUGIN_MANIFEST_FILENAME), source: "catalog", enabled: true, approvedPermissions: ["timer", "pet:speak"], config: {} });
  const rejected = await service.uninstall("link-plug");
  assert.equal(rejected.ok, false);
  assert.equal(store.getRecord("link-plug")?.id, "link-plug");
  assert.equal(existsSync(outside), true);

  const rootOutside = join(root, "outside-root");
  mkdirSync(rootOutside, { recursive: true });
  rmSync(join(userData, "plugins"), { recursive: true, force: true });
  symlinkSync(rootOutside, join(userData, "plugins"), "dir");
  store.upsertRecord({ id: "root-link", version: "1.0.0", installPath: join(userData, "plugins", "root-link"), manifestPath: join(userData, "plugins", "root-link", OPENPETS_PLUGIN_MANIFEST_FILENAME), source: "catalog", enabled: true, approvedPermissions: ["timer", "pet:speak"], config: {} });
  const rootRejected = await service.uninstall("root-link");
  assert.equal(rootRejected.ok, false);
  assert.equal(store.getRecord("root-link")?.id, "root-link");
});

await localScenario("uninstall removes stale local record when dev snapshot is missing", async ({ service, store, runtime, userData }) => {
  const install = join(userData, "plugins-dev", "stale-local");
  store.upsertRecord({ id: "stale-local", version: "1.0.0", installPath: install, manifestPath: join(install, OPENPETS_PLUGIN_MANIFEST_FILENAME), source: "local", enabled: true, brokenReason: "ENOENT: missing manifest", approvedPermissions: ["pet:speak", "schedule"], config: {} });
  const result = await service.uninstall("stale-local");
  assert.equal(result.ok, true);
  assert.equal(store.getRecord("stale-local"), undefined);
  assert.deepEqual(runtime.reloads, ["stale-local"]);

  store.upsertRecord({ id: "outside-missing", version: "1.0.0", installPath: join(userData, "plugins-dev", "..", "outside-missing"), manifestPath: join(userData, "plugins-dev", "..", "outside-missing", OPENPETS_PLUGIN_MANIFEST_FILENAME), source: "local", enabled: true, brokenReason: "missing", approvedPermissions: ["pet:speak"], config: {} });
  const rejected = await service.uninstall("outside-missing");
  assert.equal(rejected.ok, false);
  assert.equal(store.getRecord("outside-missing")?.id, "outside-missing");
});

await catalogRollbackScenario("catalog update rolls back manifest if state write fails", async ({ service, store, runtime, userData }) => {
  const oldManifest = manifest({ id: "rollback-plug", version: "1.0.0" });
  const install = join(userData, "plugins", "rollback-plug");
  const manifestPath = writeManifest(install, oldManifest);
  store.upsertRecord({ id: "rollback-plug", version: "1.0.0", installPath: install, manifestPath, source: "catalog", enabled: true, approvedPermissions: ["timer", "pet:speak"], config: {} });

  store.failNextUpsert = true;
  const result = await service.updateCatalog("rollback-plug");
  assert.equal(result.ok, false);
  assert.equal(store.getRecord("rollback-plug")?.version, "1.0.0");
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).version, "1.0.0");
  assert.deepEqual(runtime.reloads, []);
});

await catalogCompatibilityScenario("catalog filters and blocks incompatible plugins", async ({ service }) => {
  const snapshot = await service.getCatalogSnapshot(true);
  assert.deepEqual(snapshot.plugins.map((plugin) => plugin.id), ["compatible-plug"]);
  const result = await service.installCatalog("future-plug");
  assert.equal(result.ok, false);
  assert.match(result.error, /incompatible with this OpenPets version/);
});

await scenario("disabled catalog returns no discover plugins", async ({ userData, store, runtime }) => {
  const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), plugins: [catalogEntry("hidden-plug", "1.0.0")] }), { status: 200 });
  const service = new PluginService({ userDataPath: userData, stateStore: store, runtime: runtime as never, fetchImpl, disableCatalog: true });
  const snapshot = await service.getCatalogSnapshot(true);
  assert.deepEqual(snapshot.plugins, []);
});

await scenario("right-click command helper groups caps and ignores stale commands", async ({ runtime }) => {
  setPluginServiceForTests({
    getSnapshot: async () => ({ plugins: [
      { id: "zeta", name: "Zeta", version: "1.0.0", source: "catalog", enabled: true, approvedPermissions: [], commands: [{ id: "b", title: "Beta" }, { id: "a", title: "Alpha" }, { id: "c", title: "Gamma" }] },
      { id: "alpha", name: "Alpha", version: "1.0.0", source: "catalog", enabled: true, approvedPermissions: [], commands: [{ id: "run", title: "Run" }] },
      { id: "disabled", name: "Disabled", version: "1.0.0", source: "catalog", enabled: false, approvedPermissions: [], commands: [{ id: "run", title: "Run" }] },
      { id: "broken", name: "Broken", version: "1.0.0", source: "catalog", enabled: true, brokenReason: "broken", approvedPermissions: [], commands: [{ id: "run", title: "Run" }] },
    ] }),
    executeCommand: async (pluginId: string, commandId: string) => { runtime.executed.push({ pluginId, commandId }); },
    stop() {},
  } as unknown as PluginService);
  const commands = await getDefaultPetPluginCommands(2, 2);
  assert.deepEqual(commands.map((command) => `${command.pluginId}:${command.commandId}`), ["alpha:run", "zeta:b", "zeta:a"]);
  setPluginServiceForTests({ getSnapshot: async () => ({ plugins: [{ id: "alpha", name: "Alpha", version: "1.0.0", source: "catalog", enabled: true, approvedPermissions: [], commands: [{ id: "run", title: "Run" }] }, { id: "zeta", name: "Zeta", version: "1.0.0", source: "catalog", enabled: true, approvedPermissions: [], commands: [] }] }), executeCommand: async (pluginId: string, commandId: string) => { runtime.executed.push({ pluginId, commandId }); }, stop() {} } as unknown as PluginService);
  assert.deepEqual((await getDefaultPetPluginCommands()).map((command) => command.pluginId), ["alpha"]);
  await executeDefaultPetPluginCommand("alpha", "run");
  assert.deepEqual(runtime.executed, [{ pluginId: "alpha", commandId: "run" }]);
  stopPluginService();
});

await scenario("executeCommand returns plugin command validation errors", async ({ service, store, runtime }) => {
  addPlugin(store);
  runtime.commandError = new Error("Message is required.");
  const result = await service.executeCommand("plug", "set-reminder");
  assert.equal(result.ok, false);
  assert.equal(result.error, "Message is required.");
});

console.error("Plugin service validation passed.");

async function scenario(name: string, fn: (ctx: { root: string; userData: string; store: PluginStateStore; service: PluginService; runtime: FakeRuntime }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "openpets-plugin-service-root-"));
  lastRoot = root;
  const userData = mkdtempSync(join(tmpdir(), "openpets-plugin-service-user-"));
  const store = new PluginStateStore({ statePath: join(userData, "state.json") });
  store.initialize();
  const runtime = new FakeRuntime();
  const service = new PluginService({ stateStore: store, runtime: runtime as never, allowedPluginRoots: [root] });
  try { await fn({ root, userData, store, service, runtime }); } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function localScenario(name: string, fn: (ctx: { root: string; userData: string; source: string; store: PluginStateStore; service: PluginService & Record<string, unknown>; runtime: FakeRuntime }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "openpets-plugin-local-root-"));
  const userData = mkdtempSync(join(tmpdir(), "openpets-plugin-local-user-"));
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(userData, "plugins"), { recursive: true });
  mkdirSync(join(userData, "plugins-dev"), { recursive: true });
  const store = new PluginStateStore({ statePath: join(userData, "state.json") });
  store.initialize();
  const runtime = new FakeRuntime();
  let service: PluginService & Record<string, unknown>;
  service = new PluginService({ userDataPath: userData, stateStore: store, runtime: runtime as never, showOpenDialog: async () => service["__cancelPicker"] ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [String(service["__source"] ?? source)] }, confirmPermissions: async () => !service["__denyPermissions"] }) as PluginService & Record<string, unknown>;
  service["__userData"] = userData;
  service["__runtimeReloads"] = runtime.reloads;
  try { await fn({ root, userData, source, store, service, runtime }); } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function catalogRollbackScenario(name: string, fn: (ctx: { root: string; userData: string; store: ThrowingStateStore; service: PluginService; runtime: FakeRuntime }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "openpets-plugin-catalog-root-"));
  const userData = mkdtempSync(join(tmpdir(), "openpets-plugin-catalog-user-"));
  mkdirSync(join(userData, "plugins"), { recursive: true });
  mkdirSync(join(userData, "plugins-dev"), { recursive: true });
  const store = new ThrowingStateStore({ statePath: join(userData, "state.json") });
  store.initialize();
  const runtime = new FakeRuntime();
  const nextManifest = manifest({ id: "rollback-plug", version: "2.0.0" });
  const zip = makeZip(OPENPETS_PLUGIN_MANIFEST_FILENAME, Buffer.from(JSON.stringify(nextManifest), "utf8"));
  const downloadUrl = "https://zip.openpets.dev/plugins/rollback-plug.zip";
  const catalog = { version: 1, generatedAt: new Date().toISOString(), plugins: [{ id: nextManifest.id, name: nextManifest.name, version: nextManifest.version, description: "Rollback", runtime: "declarative", permissions: nextManifest.permissions, downloadUrl, sha256: createHash("sha256").update(zip).digest("hex") }] };
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    const value = String(url);
    if (value === downloadUrl) return new Response(new Uint8Array(zip), { status: 200 });
    return new Response(JSON.stringify(catalog), { status: 200 });
  };
  const service = new PluginService({ userDataPath: userData, stateStore: store, runtime: runtime as never, fetchImpl, confirmPermissions: async () => true });
  try { await fn({ root, userData, store, service, runtime }); } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function catalogCompatibilityScenario(name: string, fn: (ctx: { service: PluginService }) => Promise<void>): Promise<void> {
  const userData = mkdtempSync(join(tmpdir(), "openpets-plugin-compat-user-"));
  const store = new PluginStateStore({ statePath: join(userData, "state.json") });
  store.initialize();
  const catalog = { version: 1, generatedAt: new Date().toISOString(), plugins: [catalogEntry("compatible-plug", "1.0.0"), catalogEntry("future-plug", "9.0.0")] };
  const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify(catalog), { status: 200 });
  const service = new PluginService({ userDataPath: userData, stateStore: store, runtime: new FakeRuntime() as never, fetchImpl, currentAppVersion: "2.0.0", confirmPermissions: async () => true });
  try { await fn({ service }); } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

function catalogEntry(id: string, minOpenPetsVersion: string): object {
  return { id, name: id, version: "1.0.0", description: "Test", runtime: "declarative", permissions: ["timer", "pet:speak"], downloadUrl: `https://zip.openpets.dev/plugins/${id}.zip`, sha256: "0".repeat(64), minOpenPetsVersion };
}

function addPlugin(store: PluginStateStore, patch: Partial<PluginStateRecord> = {}, data: unknown = manifest()): void {
  const id = patch.id ?? "plug";
  const installPath = patch.installPath ?? join(currentRootFromStore(store), id);
  const manifestPath = patch.manifestPath ?? writeManifest(installPath, data);
  store.upsertRecord({ id, version: patch.version ?? "1.0.0", manifestPath, installPath, source: patch.source ?? "local", bundled: patch.bundled, enabled: patch.enabled ?? true, approvedPermissions: patch.approvedPermissions ?? ["timer", "pet:speak"], config: patch.config ?? {}, brokenReason: patch.brokenReason });
}

function addCommandPlugin(store: PluginStateStore, userData: string, id: string, name: string, _commands: Array<{ id: string; title: string }>, patch: Partial<PluginStateRecord> = {}): void {
  const data = manifest({ id, permissions: ["timer", "pet:speak"] });
  data.name = name;
  const installPath = join(userData, "plugins", id);
  const manifestPath = writeManifest(installPath, data);
  store.upsertRecord({ id, version: "1.0.0", manifestPath, installPath, source: "catalog", enabled: patch.enabled ?? true, approvedPermissions: ["timer", "pet:speak"], config: {}, brokenReason: patch.brokenReason });
}

function currentRootFromStore(_store: PluginStateStore): string { return lastRoot; }

function manifest(patch: Partial<OpenPetsDeclarativePluginManifest> & { everyMinutes?: OpenPetsDeclarativePluginManifest["triggers"][number]["everyMinutes"] } = {}): OpenPetsDeclarativePluginManifest {
  return { manifestVersion: 1, id: patch.id ?? "plug", name: "Plug", version: patch.version ?? "1.0.0", runtime: "declarative", permissions: patch.permissions ?? ["timer", "pet:speak"], configSchema: patch.configSchema, triggers: patch.triggers ?? [{ on: "timer", everyMinutes: patch.everyMinutes ?? 5, actions: [{ type: "pet.speak", message: "Stretch" }] }] };
}

function writeManifest(dir: string, data: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, OPENPETS_PLUGIN_MANIFEST_FILENAME);
  writeFileSync(path, JSON.stringify(data), "utf8");
  return path;
}

function makeZip(name: string, data: Buffer): Buffer {
  const nameBuffer = Buffer.from(name); const crc = crc32(data); const now = 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt32LE(now, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuffer.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt32LE(now, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  const localPart = Buffer.concat([local, nameBuffer, data]); const centralPart = Buffer.concat([central, nameBuffer]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(centralPart.length, 12); end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

function crc32(buffer: Buffer): number { let crc = -1; for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; }
