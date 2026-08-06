import { promises as fs } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { validateReaction, validateSayMessage, type OpenPetsReaction } from "./local-ipc-protocol.js";
import { resolvePluginNumericConfig, resolvePluginStringConfig } from "./plugin-config.js";
import type { PluginJsHost, PluginJsHostInstance } from "./plugin-js-host.js";
import { loadPluginLocales, registerPluginLocales, unregisterPluginLocales } from "./plugin-i18n.js";
import { defaultMaxPluginManifestBytes, readSafePluginManifest } from "./plugin-manifest-reader.js";
import { type OpenPetsJavascriptPluginManifest, type OpenPetsPluginManifest, type PluginAction } from "./plugin-manifest.js";
import type { PluginPetApi } from "./plugin-pet-api.js";
import { PluginSdkBridge, type PluginHostCapabilities, type PluginLogLevel, type PluginRuntimePublicState, type PluginStorageStore } from "./plugin-sdk-bridge.js";
import type { PluginInspectorState } from "./plugin-sdk-state.js";
import type { PluginStateRecord, PluginStateStore } from "./plugin-state.js";
import { classifyPluginError, logPluginDiagnostic } from "./plugin-diagnostics.js";

export interface PluginTimerHandle { cancel(): void }
export interface PluginRuntimeScheduler { setTimeout(callback: () => void, delayMs: number): PluginTimerHandle }

export const realPluginRuntimeScheduler: PluginRuntimeScheduler = {
  setTimeout(callback, delayMs) {
    const timeout = setTimeout(callback, delayMs);
    timeout.unref?.();
    return { cancel: () => clearTimeout(timeout) };
  },
};

export type PluginRuntimeOptions = {
  readonly stateStore: PluginStateStore;
  readonly petApi: PluginPetApi;
  readonly scheduler?: PluginRuntimeScheduler;
  readonly allowedPluginRoots: readonly string[];
  readonly maxManifestBytes?: number;
  readonly jsHost?: PluginJsHost;
  readonly storageStore?: PluginStorageStore;
  readonly logger?: (level: PluginLogLevel, message: string, fields?: Record<string, unknown>) => void;
  readonly capabilities?: PluginHostCapabilities;
  readonly onPluginRuntimeError?: (properties: { readonly plugin_source?: string; readonly plugin_runtime?: string; readonly permission_count?: number; readonly error_code: string }) => void;
};

type CompiledTimer = { readonly intervalMs: number; readonly actions: readonly CompiledAction[] };
type CompiledAction = { readonly type: "pet.speak"; readonly message: string } | { readonly type: "pet.react"; readonly reaction: OpenPetsReaction };
type PluginRuntimeSlot = { generation: number; active: boolean; timers: PluginTimerHandle[]; jsHost?: PluginJsHostInstance };

export class PluginRuntime {
  readonly #stateStore: PluginStateStore;
  readonly #petApi: PluginPetApi;
  readonly #scheduler: PluginRuntimeScheduler;
  readonly #allowedPluginRoots: readonly string[];
  readonly #maxManifestBytes: number;
  readonly #jsHost?: PluginJsHost;
  readonly #capabilities?: PluginHostCapabilities;
  readonly #sdkBridge: PluginSdkBridge;
  readonly #logger: (level: PluginLogLevel, message: string, fields?: Record<string, unknown>) => void;
  readonly #onPluginRuntimeError?: PluginRuntimeOptions["onPluginRuntimeError"];
  readonly #slots = new Map<string, PluginRuntimeSlot>();
  readonly #reloads = new Map<string, Promise<void>>();
  #active = false;

  constructor(options: PluginRuntimeOptions) {
    this.#stateStore = options.stateStore;
    this.#petApi = options.petApi;
    this.#scheduler = options.scheduler ?? realPluginRuntimeScheduler;
    this.#allowedPluginRoots = options.allowedPluginRoots;
    this.#maxManifestBytes = options.maxManifestBytes ?? defaultMaxPluginManifestBytes;
    this.#jsHost = options.jsHost;
    this.#capabilities = options.capabilities;
    this.#logger = options.logger ?? (() => undefined);
    this.#onPluginRuntimeError = options.onPluginRuntimeError;
    this.#sdkBridge = new PluginSdkBridge({ stateStore: this.#stateStore, petApi: this.#petApi, scheduler: this.#scheduler, storage: options.storageStore, onError: (id, reason) => this.#markBroken(id, reason), logger: this.#logger, capabilities: options.capabilities });
  }

  async start(): Promise<void> {
    logPluginDiagnostic(this.#logger, "debug", "plugin runtime start", { phase: "begin" });
    this.#active = true;
    await this.reloadAll();
    logPluginDiagnostic(this.#logger, "debug", "plugin runtime start", { phase: "success" });
  }

  async stop(): Promise<void> {
    logPluginDiagnostic(this.#logger, "debug", "plugin runtime stop", { phase: "begin" });
    this.#active = false;
    const pendingReloads = [...this.#reloads.values()];
    await Promise.all([...this.#slots.keys()].map((id) => this.#cancelPlugin(id)));
    await Promise.all(pendingReloads);
    logPluginDiagnostic(this.#logger, "debug", "plugin runtime stop", { phase: "end" });
  }

  getPluginState(id: string): PluginRuntimePublicState { return this.#sdkBridge.getPublicState(id); }
  getInspectorState(id: string): PluginInspectorState { return this.#sdkBridge.getInspectorState(id); }
  executeCommand(id: string, commandId: string, args?: Record<string, unknown>): Promise<void> { return this.#sdkBridge.executeCommand(id, commandId, args); }
  executeMenuSelect(id: string, itemId: string): Promise<void> { return this.#sdkBridge.executeMenuSelect(id, itemId); }
  notifyConfigChanged(id: string): void { this.#sdkBridge.notifyConfigChanged(id); }
  resyncSchedules(): void { this.#sdkBridge.resyncSchedules(); }

  async reloadAll(): Promise<void> {
    await Promise.all([...this.#slots.keys()].map((id) => this.#cancelPlugin(id)));
    const records = this.#stateStore.listRecords();
    const jsIds: string[] = [];
    for (const record of records) {
      if (record.runtime === "javascript" || record.manifestVersion === 2 || record.manifestVersion === 3) jsIds.push(record.id);
      else await this.reloadPlugin(record.id);
    }
    await Promise.all(jsIds.map((id) => this.reloadPlugin(id)));
  }

  async reloadPlugin(id: string): Promise<void> {
    const previous = this.#reloads.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.#reloadPlugin(id));
    this.#reloads.set(id, current);
    try {
      await current;
    } finally {
      if (this.#reloads.get(id) === current) this.#reloads.delete(id);
    }
  }

  async #reloadPlugin(id: string): Promise<void> {
    const started = Date.now();
    logPluginDiagnostic(this.#logger, "debug", "plugin reload", { pluginId: id, phase: "begin" });
    await this.#cancelPlugin(id);
    if (!this.#active) { logPluginDiagnostic(this.#logger, "debug", "plugin reload", { pluginId: id, phase: "skip", reason: "runtime-inactive" }); return; }
    const record = this.#stateStore.getRecord(id);
    if (!record || !record.enabled || record.catalogDisabled) { logPluginDiagnostic(this.#logger, "debug", "plugin reload", { pluginId: id, phase: "skip", reason: !record ? "not-installed" : !record.enabled ? "disabled" : "catalog-disabled" }); return; }
    const slot = this.#slotFor(id);
    const generation = slot.generation;

    try {
      const manifest = await readSafePluginManifest({ installPath: record.installPath, manifestPath: record.manifestPath, allowedPluginRoots: this.#allowedPluginRoots, maxManifestBytes: this.#maxManifestBytes, expectedId: record.id, expectedVersion: record.version });
      if (!this.#canCommitReload(record, generation)) return;
      this.#stateStore.clearBrokenReason(id);
      if (manifest.runtime === "javascript") {
        logPluginDiagnostic(this.#logger, "debug", "plugin start", { pluginId: id, runtime: "javascript", phase: "begin" });
        await this.#startJavascriptPlugin(record, manifest, slot, generation);
      } else {
        logPluginDiagnostic(this.#logger, "debug", "plugin start", { pluginId: id, runtime: "declarative", phase: "begin" });
        const timers = this.#compileDeclarativePlugin(record, manifest);
        if (!this.#canCommitReload(record, generation)) return;
        slot.active = true;
        for (const timer of timers) this.#scheduleTimer(id, slot, generation, timer);
        logPluginDiagnostic(this.#logger, "info", "plugin reload", { pluginId: id, runtime: "declarative", phase: "success", durationMs: Date.now() - started, count: timers.length });
      }
    } catch (error) {
      logPluginDiagnostic(this.#logger, "warn", "plugin reload", { pluginId: id, phase: "fail", reason: error instanceof Error ? error.message : String(error), errorCode: classifyPluginError(error), durationMs: Date.now() - started });
      if (this.#canCommitReload(record, generation)) this.#markBroken(id, error instanceof Error ? error.message : "Plugin runtime validation failed.");
    }
  }

  #canCommitReload(record: PluginStateRecord, generation: number): boolean {
    if (!this.#active) return false;
    const slot = this.#slots.get(record.id);
    if (!slot || slot.generation !== generation) return false;
    const current = this.#stateStore.getRecord(record.id);
    return current?.enabled === true && current.catalogDisabled !== true && current.version === record.version && current.manifestPath === record.manifestPath && current.installPath === record.installPath;
  }

  #compileDeclarativePlugin(record: PluginStateRecord, manifest: OpenPetsPluginManifest): CompiledTimer[] {
    if (manifest.runtime !== "declarative") throw new Error("Plugin runtime is not declarative.");
    const approved = new Set(record.approvedPermissions);
    for (const permission of manifest.permissions) if (!approved.has(permission)) throw new Error(`Plugin permission is not approved: ${permission}`);
    return manifest.triggers.map((trigger, index) => {
      if (!approved.has("timer")) throw new Error("Plugin timer permission is not approved.");
      const interval = resolveTimerInterval(record, manifest, trigger.everyMinutes, index);
      const actions = trigger.actions.map((action) => compileAction(record, manifest, action, approved));
      return { intervalMs: interval * 60_000, actions };
    });
  }

  async #startJavascriptPlugin(record: PluginStateRecord, manifest: OpenPetsJavascriptPluginManifest, slot: PluginRuntimeSlot, generation: number): Promise<void> {
    if (!this.#jsHost) throw new Error("JavaScript plugin host is unavailable.");
    const approved = new Set(record.approvedPermissions);
    for (const permission of manifest.permissions) if (!approved.has(permission)) throw new Error(`Plugin permission is not approved: ${permission}`);
    const entryPath = await resolveJavascriptEntry(record.installPath, manifest.entry);
    const catalogs = await loadPluginLocales(record.installPath);
    registerPluginLocales(record.id, catalogs);
    const sdk = this.#sdkBridge.createApi(record, manifest);
    const host = await this.#jsHost.startPlugin({ record, manifest, entryPath, sdk, onBroken: (reason) => {
      if (this.#canCommitReload(record, generation)) this.#markBroken(record.id, reason);
    } });
    if (!this.#canCommitReload(record, generation)) {
      host.stop();
      unregisterPluginLocales(record.id);
      await this.#clearPlugin(record.id);
      return;
    }
    slot.jsHost = host;
    slot.active = true;
    logPluginDiagnostic(this.#logger, "info", "plugin started", { pluginId: record.id, runtime: manifest.runtime, source: record.source, phase: "success" });
  }

  #scheduleTimer(id: string, slot: PluginRuntimeSlot, generation: number, timer: CompiledTimer): void {
    let handle: PluginTimerHandle | undefined;
    handle = this.#scheduler.setTimeout(() => {
      if (handle) slot.timers = slot.timers.filter((timerHandle) => timerHandle !== handle);
      if (!this.#active || !slot.active || slot.generation !== generation) return;
      void this.#runTimer(id, slot, generation, timer);
    }, timer.intervalMs);
    slot.timers.push(handle);
    logPluginDiagnostic(this.#logger, "debug", "plugin declarative schedule created", { pluginId: id, runtime: "declarative", scheduleId: String(generation), durationMs: timer.intervalMs });
  }

  async #runTimer(id: string, slot: PluginRuntimeSlot, generation: number, timer: CompiledTimer): Promise<void> {
    try {
      logPluginDiagnostic(this.#logger, "debug", "plugin declarative schedule fired", { pluginId: id, runtime: "declarative", scheduleId: String(generation) });
      for (const action of timer.actions) {
        if (!this.#active || !slot.active || slot.generation !== generation) return;
        if (action.type === "pet.speak") await this.#petApi.speak(action.message);
        else await this.#petApi.react(action.reaction);
      }
      if (this.#active && slot.active && slot.generation === generation) this.#scheduleTimer(id, slot, generation, timer);
    } catch (error) {
      logPluginDiagnostic(this.#logger, "warn", "plugin declarative callback failed", { pluginId: id, runtime: "declarative", scheduleId: String(generation), reason: error instanceof Error ? error.message : String(error), errorCode: classifyPluginError(error) });
      if (this.#active && slot.active && slot.generation === generation) this.#markBroken(id, error instanceof Error ? error.message : "Plugin action failed.");
    }
  }

  #markBroken(id: string, reason: string): void {
    logPluginDiagnostic(this.#logger, "error", "plugin marked broken", { pluginId: id, reason });
    const record = this.#stateStore.getRecord(id);
    this.#onPluginRuntimeError?.({ plugin_source: record?.bundled ? "bundled" : record?.source, plugin_runtime: record?.runtime, permission_count: record?.approvedPermissions.length, error_code: classifyPluginError(reason) });
    void this.#cancelPlugin(id);
    this.#stateStore.setBrokenReason(id, reason);
  }

  async #cancelPlugin(id: string): Promise<void> {
    const slot = this.#slotFor(id);
    if (slot.active || slot.timers.length > 0 || slot.jsHost) logPluginDiagnostic(this.#logger, "debug", "plugin cancel", { pluginId: id, phase: "begin", count: slot.timers.length });
    slot.active = false;
    slot.generation += 1;
    for (const timer of slot.timers) timer.cancel();
    slot.timers = [];
    slot.jsHost?.stop();
    slot.jsHost = undefined;
    unregisterPluginLocales(id);
    await this.#clearPlugin(id);
    logPluginDiagnostic(this.#logger, "debug", "plugin cancel", { pluginId: id, phase: "end" });
  }

  async #clearPlugin(id: string): Promise<void> {
    this.#sdkBridge.clearPlugin(id);
    const teardown = (this.#capabilities as { clearPlugin?: (pluginId: string) => void | Promise<void> } | undefined)?.clearPlugin;
    if (teardown) {
      try { await teardown(id); } catch { /* host teardown is best effort */ }
    }
  }

  #slotFor(id: string): PluginRuntimeSlot {
    let slot = this.#slots.get(id);
    if (!slot) {
      slot = { generation: 0, active: false, timers: [] };
      this.#slots.set(id, slot);
    }
    return slot;
  }
}

function compileAction(record: PluginStateRecord, manifest: OpenPetsPluginManifest, action: PluginAction, approved: Set<string>): CompiledAction {
  if (action.type === "pet.speak") {
    if (!approved.has("pet:speak")) throw new Error("Plugin speak permission is not approved.");
    const message = typeof action.message === "string" ? action.message : resolvePluginStringConfig(manifest, record.config, action.message.config, "text");
    return { type: "pet.speak", message: validateSayMessage(message) };
  }
  if (!approved.has("pet:reaction")) throw new Error("Plugin reaction permission is not approved.");
  const reaction = typeof action.reaction === "string" ? action.reaction : resolvePluginStringConfig(manifest, record.config, action.reaction.config, "select");
  return { type: "pet.react", reaction: validateReaction(reaction) };
}

function resolveTimerInterval(record: PluginStateRecord, manifest: OpenPetsPluginManifest, value: number | { config: string }, triggerIndex: number): number {
  const interval = typeof value === "number" ? value : resolvePluginNumericConfig(manifest, record.config, value.config, { min: 5 });
  if (!Number.isInteger(interval) || interval < 5) throw new Error(`Plugin timer interval for trigger ${triggerIndex} must be an integer of at least 5 minutes.`);
  return interval;
}

async function resolveJavascriptEntry(installPath: string, entry: string): Promise<string> {
  const installRoot = resolve(installPath);
  const entryPath = resolve(installRoot, entry);
  const rel = relative(installRoot, entryPath);
  if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) throw new Error("JavaScript plugin entry is outside install path.");
  const stat = await fs.lstat(entryPath);
  if (stat.isSymbolicLink()) throw new Error("JavaScript plugin entry must not be a symlink.");
  if (!stat.isFile()) throw new Error("JavaScript plugin entry must be a file.");
  const [realInstallRoot, realEntryPath] = await Promise.all([fs.realpath(installRoot), fs.realpath(entryPath)]);
  const realRel = relative(realInstallRoot, realEntryPath);
  if (realRel === "" || realRel.startsWith("..") || realRel.includes(`..${sep}`)) throw new Error("JavaScript plugin entry is outside install path.");
  return realEntryPath;
}
