import { promises as fs } from "node:fs";
import * as os from "node:os";
import { basename, extname, join } from "node:path";

import { app, clipboard, dialog, nativeTheme, net, Notification, shell } from "electron";

import { getDefaultPetWindowForPlugins } from "./default-pet-controller.js";
import { getActiveLocaleLang } from "./i18n/index.js";
import { debug, warn } from "./logger.js";
import { playPetWindowAudio, stopPetWindowAudio } from "./pet-window.js";
import { PluginAiGateway } from "./plugin-ai-gateway.js";
import { readDroppedFileText, startPluginEventSources, subscribePluginEvent } from "./plugin-events-source.js";
import { PluginOauthBroker } from "./plugin-oauth.js";
import { openPluginPanel } from "./plugin-panels.js";
import { getPluginPlatformSettings, isInQuietHours } from "./plugin-platform-settings.js";
import {
  setPluginPetStatusReaction, clearPluginPetsForPlugin, closeAllPluginPets, closePluginPet, getPluginPetArbiter, getPluginPetState, hidePluginPet, listPluginPets,
  movePluginPetBy, movePluginPetTo, movePluginPetToHome, onPluginPetTick, onPluginPetsChange, reactPluginPet,
  setPluginPetAnimation, setPluginPetFollowCursor, setPluginPetPhysics, setPluginPetScale, showPluginPet, spawnPluginPet, wanderPluginPet,
} from "./plugin-pet-registry.js";
import { motionStop } from "./pet-motion-engine.js";
import { PluginSecretsStore } from "./plugin-secrets.js";
import { showPluginToast } from "./plugin-toast.js";
import { cancelPluginVoiceListen, pluginVoiceListen, pluginVoiceSpeak, shutdownPluginVoice } from "./plugin-voice.js";
import { registerDelivery, stopDeliverySystem, teardownPluginDeliveries } from "./plugin-delivery.js";
import type { PluginHostCapabilities, PluginPickedFileHost } from "./plugin-sdk-bridge.js";
import { maxUserSoundBytes, UserSoundStore, userSoundMimeByExtension } from "./plugin-user-sound-store.js";
import { classifyPluginError } from "./plugin-diagnostics.js";
import { getAppStateSnapshot } from "./app-state.js";
import { readSafePluginManifest } from "./plugin-manifest-reader.js";
import { resolveTrustedPluginSprite } from "./plugin-assets.js";
import { getPluginService } from "./plugin-service.js";

/**
 * The Electron implementation of every SDK v3 host capability. Built once at
 * startup and injected into the plugin SDK bridge; the bridge owns validation,
 * permissions, and quotas — this layer only does the side effects.
 */

const maxPickedFileBytes = 16 * 1024 * 1024;

type PickedFileEntry = { path: string; name: string; sizeBytes: number };

let cpuSample: { idle: number; total: number } | null = null;

function sampleCpus(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function cpuPercent(): number {
  const current = sampleCpus();
  const previous = cpuSample ?? current;
  cpuSample = current;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return 0;
  return Math.round(Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100)));
}

export type ElectronPluginHostCapabilities = PluginHostCapabilities & {
  readonly secretsStore: PluginSecretsStore;
  readonly aiGateway: PluginAiGateway;
  /** Tear down everything a plugin owns on stop/reload. */
  clearPlugin(pluginId: string): Promise<void>;
  shutdown(): void;
};

let activeCapabilities: ElectronPluginHostCapabilities | null = null;

/** The live capabilities instance (Control Center settings IPC). */
export function getPluginHostCapabilitiesForUi(): ElectronPluginHostCapabilities | null {
  return activeCapabilities;
}

export function createElectronPluginHostCapabilities(userDataPath: string): ElectronPluginHostCapabilities {
  startPluginEventSources();
  const secretsStore = new PluginSecretsStore(userDataPath);
  const aiGateway = new PluginAiGateway(secretsStore);
  const oauthBroker = new PluginOauthBroker(secretsStore);
  const pickedFiles = new Map<string, PickedFileEntry>();
  const userSounds = new UserSoundStore(join(userDataPath, "plugin-user-sounds"));
  let nextPickedFileId = 0;
  let didShutdown = false;
  const shutdown = () => {
    if (didShutdown) return;
    didShutdown = true;
    app.off("before-quit", shutdown);
    stopDeliverySystem();
    closeAllPluginPets();
    if (activeCapabilities === capabilities) activeCapabilities = null;
  };

  const capabilities: ElectronPluginHostCapabilities = {
    secretsStore,
    aiGateway,
    bubbles: {
      async show({ petId, pluginId, bubble, callbacks }) {
        return getPluginPetArbiter(petId).show(pluginId, bubble, callbacks);
      },
    },
    audio: {
      async play(spec, volume) {
        const baseFields = { kind: spec.kind, pluginId: "pluginId" in spec ? spec.pluginId : undefined, soundId: "id" in spec ? spec.id : undefined, name: "name" in spec ? spec.name : undefined };
        debug("plugin", "audio play requested", baseFields);
        const window = getDefaultPetWindowForPlugins();
        if (!window) { debug("plugin", "audio play skipped", { ...baseFields, reason: "no-pet-window" }); return; }
        if (spec.kind === "named") {
          playPetWindowAudio(window, { kind: "named", name: spec.name, volume });
          debug("plugin", "audio play started", baseFields);
          return;
        }
        try {
          const sourcePath = spec.kind === "user-sound" ? await userSounds.resolvePath(spec.pluginId, spec.id) : spec.path;
          const stat = await fs.stat(sourcePath);
          const ext = extname(sourcePath).toLowerCase();
          if (!stat.isFile() || stat.size > maxUserSoundBytes) throw new Error("Plugin sound file is missing or too large.");
          const mime = userSoundMimeByExtension[ext];
          if (!mime) throw new Error("Plugin sound format is not supported.");
          debug("plugin", "audio play file ready", { ...baseFields, ext, sizeBytes: stat.size });
          const bytes = await fs.readFile(sourcePath);
          playPetWindowAudio(window, { kind: "data", dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, volume });
          debug("plugin", "audio play started", { ...baseFields, ext, sizeBytes: stat.size });
        } catch (error) { warn("plugin", "audio play failed", { ...baseFields, reason: error instanceof Error ? error.message : "unknown" }); throw error; }
      },
      async importUserSound(pluginId, fileId, opts) {
        const entry = pickedFiles.get(fileId);
        if (!entry) throw new Error("Plugin file handle is invalid.");
        return userSounds.importFromPath(pluginId, entry.path, { name: opts?.name ?? entry.name });
      },
      async importUserSoundFromPath(pluginId, path, opts) {
        // Trusted Control Center plumbing only: plugins receive opaque refs and
        // cannot pass arbitrary paths through the SDK.
        const fields: Record<string, unknown> = { pluginId, basename: basename(path), ext: extname(path).toLowerCase() };
        try { fields.sizeBytes = (await fs.stat(path)).size; } catch { fields.reason = "stat-unavailable"; }
        debug("plugin", "user sound import requested", fields);
        const sound = await userSounds.importFromPath(pluginId, path, { name: opts?.name ?? basename(path) });
        debug("plugin", "user sound import succeeded", { pluginId, soundId: sound.id, name: sound.name });
        return sound;
      },
      async forgetUserSound(pluginId, ref) {
        await userSounds.forget(pluginId, ref);
      },
      async stop() {
        const window = getDefaultPetWindowForPlugins();
        if (window) stopPetWindowAudio(window);
      },
    },
    events: {
      subscribe(event, handler) {
        return subscribePluginEvent(event, handler);
      },
    },
    pets: {
      list: () => listPluginPets(),
      spawn: (opts) => spawnPluginPet(opts),
      close: (pluginId, petHandleId) => closePluginPet(pluginId, petHandleId),
      show: async (petHandleId) => showPluginPet(petHandleId),
      hide: async (petHandleId) => hidePluginPet(petHandleId),
      react: async (petHandleId, reaction, options) => reactPluginPet(petHandleId, reaction, options),
      setAnimation: async (petHandleId, spec) => setPluginPetAnimation(petHandleId, spec),
      setScale: async (petHandleId, scale) => setPluginPetScale(petHandleId, scale),
      setStatusReaction: async (petHandleId, reaction) => setPluginPetStatusReaction(petHandleId, reaction),
      moveBy: (petHandleId, opts) => movePluginPetBy(petHandleId, opts),
      wander: (petHandleId, opts) => wanderPluginPet(petHandleId, opts),
      moveToHome: (petHandleId) => movePluginPetToHome(petHandleId),
      moveTo: (petHandleId, point, opts) => movePluginPetTo(petHandleId, point, opts),
      followCursor: async (petHandleId, _pluginId, opts) => setPluginPetFollowCursor(petHandleId, opts),
      physics: async (petHandleId, _pluginId, opts) => setPluginPetPhysics(petHandleId, opts),
      getState: async (petHandleId) => getPluginPetState(petHandleId),
      onTick: (petHandleId, handler) => onPluginPetTick(petHandleId, handler),
      onChange: (handler) => onPluginPetsChange(handler),
    },
    toast: (spec) => showPluginToast(spec),
    async notify(spec) {
      if (!Notification.isSupported()) { warn("plugin", "notify failed", { reason: "unsupported" }); throw new Error("OS notifications are not supported on this system."); }
      try { new Notification({ title: spec.title, body: spec.body, silent: spec.sound !== true }).show(); }
      catch (error) { warn("plugin", "notify failed", { reason: error instanceof Error ? error.message : "unknown", errorCode: classifyPluginError(error) }); throw error; }
    },
    panels: {
      open: (opts) => openPluginPanel(opts),
    },
    delivery: {
      async register(pluginId, descriptor) {
        const record = getPluginService().stateStore.getRecord(pluginId);
        if (!record || !record.enabled) throw new Error("Plugin is unavailable for delivery.");
        const manifest = await readSafePluginManifest({ installPath: record.installPath, manifestPath: record.manifestPath, allowedPluginRoots: getPluginService().allowedPluginRoots, expectedId: pluginId, expectedVersion: record.version });
        if (manifest.runtime !== "javascript") throw new Error("Plugin is unavailable for delivery.");
        return registerDelivery(resolveTrustedPluginSprite(manifest, pluginId, descriptor.courier.name), descriptor);
      },
      teardown: (pluginId) => teardownPluginDeliveries(pluginId),
    },
    secrets: {
      get: (pluginId, key) => secretsStore.get(pluginId, key),
      set: (pluginId, key, value) => secretsStore.set(pluginId, key, value),
      delete: (pluginId, key) => secretsStore.delete(pluginId, key),
      has: (pluginId, key) => secretsStore.has(pluginId, key),
    },
    ai: {
      available: () => aiGateway.available(),
      complete: async (req) => { const started = Date.now(); try { return await aiGateway.complete(req); } catch (error) { warn("plugin", "ai complete failed", { durationMs: Date.now() - started, reason: error instanceof Error ? error.message : "unknown", errorCode: classifyPluginError(error) }); throw error; } },
      stream: async (req, onToken) => { const started = Date.now(); try { return await aiGateway.stream(req, onToken); } catch (error) { warn("plugin", "ai stream failed", { durationMs: Date.now() - started, reason: error instanceof Error ? error.message : "unknown", errorCode: classifyPluginError(error) }); throw error; } },
    },
    voice: {
      speak: async (text, opts) => { try { await pluginVoiceSpeak(text, opts); } catch (error) { warn("plugin", "voice speak failed", { reason: error instanceof Error ? error.message : "unknown", errorCode: classifyPluginError(error) }); throw error; } },
      listen: async (opts) => { try { return await pluginVoiceListen(aiGateway, { timeoutMs: opts.timeoutMs ?? 10_000, pluginId: opts.pluginId }); } catch (error) { warn("plugin", "voice listen failed", { reason: error instanceof Error ? error.message : "unknown", errorCode: classifyPluginError(error) }); throw error; } },
    },
    auth: {
      oauth: async (pluginId, config) => { try { return await oauthBroker.oauth(pluginId, config); } catch (error) { warn("plugin", "oauth failed", { pluginId, provider: config.provider, reason: error instanceof Error ? error.message : "unknown", errorCode: classifyPluginError(error) }); throw error; } },
      refresh: async (pluginId, provider) => { try { return await oauthBroker.refresh(pluginId, provider); } catch (error) { warn("plugin", "oauth refresh failed", { pluginId, provider, reason: error instanceof Error ? error.message : "unknown", errorCode: classifyPluginError(error) }); throw error; } },
      signOut: async (pluginId, provider) => { try { await oauthBroker.signOut(pluginId, provider); } catch (error) { warn("plugin", "oauth signout failed", { pluginId, provider, reason: error instanceof Error ? error.message : "unknown", errorCode: classifyPluginError(error) }); throw error; } },
    },
    files: {
      async pick(opts) {
        const filters = opts.accept && opts.accept.length > 0
          ? [{ name: "Allowed files", extensions: opts.accept.map((ext) => ext.replace(/^[.]/, "")) }]
          : undefined;
        const result = await dialog.showOpenDialog({ properties: opts.multiple ? ["openFile", "multiSelections"] : ["openFile"], filters });
        if (result.canceled) return [];
        const out: PluginPickedFileHost[] = [];
        let skipped = 0;
        for (const path of result.filePaths.slice(0, 16)) {
          try {
            const stat = await fs.stat(path);
            if (!stat.isFile()) { skipped++; continue; }
            const fileId = `pick-${++nextPickedFileId}`;
            pickedFiles.set(fileId, { path, name: basename(path), sizeBytes: stat.size });
            out.push({ fileId, name: basename(path), sizeBytes: stat.size });
          } catch { skipped++; }
        }
        debug("plugin", "files picked", { count: out.length, skipped });
        return out;
      },
      async read(fileId, encoding) {
        const dropped = readDroppedFileText(fileId);
        if (dropped !== undefined) return encoding === "text" ? dropped : new TextEncoder().encode(dropped);
        const entry = pickedFiles.get(fileId);
        if (!entry) throw new Error("Plugin file handle is invalid.");
        const stat = await fs.stat(entry.path);
        if (stat.size > maxPickedFileBytes) throw new Error("Picked file is too large to read.");
        debug("plugin", "file read", { basename: entry.name, ext: extname(entry.name).toLowerCase(), sizeBytes: stat.size });
        const bytes = await fs.readFile(entry.path);
        return encoding === "text" ? bytes.toString("utf8") : new Uint8Array(bytes);
      },
      async save(opts) {
        const result = await dialog.showSaveDialog({ defaultPath: opts.suggestedName });
        if (result.canceled || !result.filePath) return;
        debug("plugin", "file saved", { basename: basename(result.filePath), ext: extname(result.filePath).toLowerCase(), sizeBytes: typeof opts.data === "string" ? Buffer.byteLength(opts.data) : opts.data.byteLength });
        await fs.writeFile(result.filePath, typeof opts.data === "string" ? opts.data : Buffer.from(opts.data));
      },
    },
    system: {
      async info() {
        return {
          platform: process.platform === "darwin" ? "mac" as const : process.platform === "win32" ? "win" as const : "linux" as const,
          locale: getActiveLocaleLang(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
          theme: nativeTheme.shouldUseDarkColors ? "dark" as const : "light" as const,
          appVersion: app.getVersion(),
          online: net.online,
        };
      },
      async metrics() {
        const memory = process.getSystemMemoryInfo();
        const memUsedPercent = memory.total > 0 ? Math.round(Math.min(100, Math.max(0, (1 - memory.free / memory.total) * 100))) : 0;
        return { cpuPercent: cpuPercent(), memUsedPercent };
      },
      async openExternal(url) {
        let host: string | undefined;
        try { host = new URL(url).hostname; } catch { host = undefined; }
        debug("plugin", "system openExternal", { host });
        await shell.openExternal(url);
      },
      async readClipboardText() {
        return clipboard.readText().slice(0, 64 * 1024);
      },
      async writeClipboardText(text) {
        clipboard.writeText(text);
      },
    },
    settings: {
      audioAllowed: () => getPluginPlatformSettings().allowPluginAudio,
      dynamicSpeechAllowed: () => getPluginPlatformSettings().allowDynamicSpeech,
      voiceAllowed: () => getPluginPlatformSettings().allowPluginVoice,
      listenAllowed: () => getPluginPlatformSettings().allowMicrophone,
      inQuietHours: () => isInQuietHours(),
    },
    async clearPlugin(pluginId: string) {
      await cancelPluginVoiceListen(pluginId, "The plugin was stopped.").catch(() => undefined);
      try {
        teardownPluginDeliveries(pluginId);
        clearPluginPetsForPlugin(pluginId);
      } catch (error) {
        warn("plugin", "plugin pet teardown failed", { pluginId, error: error instanceof Error ? error.message : String(error) });
      }
      // Runtime teardown must not delete persistent plugin data. User-imported
      // sounds are cleared only by PluginService uninstall/prune paths.
      motionStop("default");
    },
    shutdown() {
      void shutdownPluginVoice().catch(() => undefined);
      shutdown();
    },
  };
  // Prime the CPU sampler so the first metrics() call has a delta to use.
  cpuSample = sampleCpus();
  activeCapabilities = capabilities;
  app.once("before-quit", shutdown);
  return capabilities;
}
