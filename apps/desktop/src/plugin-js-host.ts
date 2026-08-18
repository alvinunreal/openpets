import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, ipcMain, session, type Event, type IpcMainEvent, type IpcMainInvokeEvent, type RenderProcessGoneDetails, type Session, type WebContents } from "electron";

import type { OpenPetsJavascriptPluginManifest } from "./plugin-manifest.js";
import { classifyPluginError, logPluginDiagnostic, truncatePluginConsoleMessage } from "./plugin-diagnostics.js";
import type { PluginRuntimeLogger, PluginSdkApi } from "./plugin-sdk-bridge.js";
import { isPluginSdkRoute, pluginSdkSyncRoutes, type PluginSdkRoute } from "./plugin-sdk-routes.js";
import type { PluginStateRecord } from "./plugin-state.js";

export type PluginJsHostStartOptions = {
  readonly record: PluginStateRecord;
  readonly manifest: OpenPetsJavascriptPluginManifest;
  readonly entryPath: string;
  readonly sdk?: PluginSdkApi;
  readonly startupTimeoutMs?: number;
  readonly onBroken: (reason: string) => void;
};

export interface PluginJsHostInstance { stop(): void }

export interface PluginJsHost { startPlugin(options: PluginJsHostStartOptions): Promise<PluginJsHostInstance> }
const configDisposers = new WeakMap<WebContents, Map<string, () => void>>();
type SdkWithLogger = PluginSdkApi & { __logger?: PluginRuntimeLogger };

export type PluginSdkErrorEnvelope = {
  readonly __openPetsError: {
    readonly message: string;
    readonly code?: string;
  };
};

const pluginSdkErrorCode = /^[a-z][a-z0-9_-]{0,63}$/;

export function serializePluginSdkError(error: unknown): PluginSdkErrorEnvelope {
  const message = error instanceof Error && error.message.trim()
    ? error.message
    : "Plugin SDK call failed.";
  const code = error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string"
    && pluginSdkErrorCode.test((error as Error & { code: string }).code)
    ? (error as Error & { code: string }).code
    : undefined;
  return { __openPetsError: { message, ...(code ? { code } : {}) } };
}

export class ElectronPluginJsHost implements PluginJsHost {
  readonly #startupTimeoutMs: number;

  constructor(options: { readonly startupTimeoutMs?: number } = {}) {
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
  }

  async startPlugin(options: PluginJsHostStartOptions): Promise<PluginJsHostInstance> {
    const partition = `openpets-plugin:${encodeURIComponent(options.record.id)}:${Date.now()}`;
    const logger = (options.sdk as SdkWithLogger | undefined)?.__logger;
    logPluginDiagnostic(logger, "debug", "plugin js host start", { pluginId: options.record.id, runtime: "javascript", phase: "begin" });
    const pluginSession = session.fromPartition(partition, { cache: false });
    logPluginDiagnostic(logger, "debug", "plugin js host session created", { pluginId: options.record.id, runtime: "javascript" });
    const entryUrl = pathToFileURL(options.entryPath).toString();
    logPluginDiagnostic(logger, "debug", "plugin js host entry read", { pluginId: options.record.id, runtime: "javascript", phase: "begin", source: options.entryPath });
    const moduleUrl = buildPluginModuleUrl(await readFile(options.entryPath, "utf8"), entryUrl);
    const htmlUrl = buildPluginHtmlUrl(moduleUrl);
    const token = `${options.record.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sdkChannel = `openpets:plugin-sdk:${token}`;
    hardenSession(pluginSession, { entryUrl: moduleUrl, htmlUrl });

    const window = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        partition,
        preload: getPluginSdkPreloadPath(),
        additionalArguments: [`--openpets-plugin-token=${token}`],
      },
    });

    hardenWebContents(window.webContents, options.onBroken);
    window.webContents.on("console-message", (_event, level, message, line, sourceId) => logPluginDiagnostic(logger, level >= 2 ? "warn" : "debug", "plugin renderer console", { pluginId: options.record.id, runtime: "javascript", level, reason: truncatePluginConsoleMessage(message), line, source: sourceId }));
    window.webContents.on("render-process-gone", (_event, details) => logPluginDiagnostic(logger, "warn", "plugin renderer gone", { pluginId: options.record.id, runtime: "javascript", reason: details.reason }));
    window.webContents.on("unresponsive", () => logPluginDiagnostic(logger, "warn", "plugin renderer unresponsive", { pluginId: options.record.id, runtime: "javascript" }));
    const removeSdkHandler = installSdkHandler(sdkChannel, window.webContents, options.sdk, options.record.id);

    const stopped = { value: false };
    const instance: PluginJsHostInstance = { stop: () => { logPluginDiagnostic(logger, "debug", "plugin js host stop", { pluginId: options.record.id, runtime: "javascript", phase: "begin" }); stopped.value = true; removeSdkHandler(); void stopRegisteredPlugin(window.webContents).catch(() => undefined); cleanupSession(pluginSession); if (!window.isDestroyed()) window.destroy(); logPluginDiagnostic(logger, "debug", "plugin js host stop", { pluginId: options.record.id, runtime: "javascript", phase: "end" }); } };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => fail(new Error("JavaScript plugin startup timed out.")), options.startupTimeoutMs ?? this.#startupTimeoutMs);
      const cleanup = () => { clearTimeout(timeout); window.webContents.removeListener("did-finish-load", loaded); window.webContents.removeListener("render-process-gone", gone); window.webContents.removeListener("unresponsive", unresponsive); };
      const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); instance.stop(); reject(error); };
      const loaded = () => {
        logPluginDiagnostic(logger, "debug", "plugin js host registration", { pluginId: options.record.id, runtime: "javascript", phase: "begin" });
        void runRegistrationHandshake(window.webContents, moduleUrl, options.sdk).then(() => { logPluginDiagnostic(logger, "info", "plugin js host registration", { pluginId: options.record.id, runtime: "javascript", phase: "success" }); if (settled) return; settled = true; cleanup(); resolve(); }, (error: unknown) => { logPluginDiagnostic(logger, "warn", "plugin js host registration", { pluginId: options.record.id, runtime: "javascript", phase: "fail", reason: error instanceof Error ? error.message : String(error), errorCode: classifyPluginError(error) }); fail(error instanceof Error ? error : new Error("JavaScript plugin registration failed.")); });
      };
      const gone = (_event: Event, details: RenderProcessGoneDetails) => fail(new Error(`JavaScript plugin renderer exited: ${details.reason}`));
      const unresponsive = () => fail(new Error("JavaScript plugin renderer became unresponsive."));
      window.webContents.once("did-finish-load", loaded);
      window.webContents.once("render-process-gone", gone);
      window.webContents.once("unresponsive", unresponsive);
      logPluginDiagnostic(logger, "debug", "plugin js host load", { pluginId: options.record.id, runtime: "javascript", phase: "begin" });
      window.loadURL(htmlUrl).then(() => logPluginDiagnostic(logger, "debug", "plugin js host load", { pluginId: options.record.id, runtime: "javascript", phase: "success" })).catch((error: unknown) => { logPluginDiagnostic(logger, "warn", "plugin js host load", { pluginId: options.record.id, runtime: "javascript", phase: "fail", reason: error instanceof Error ? error.message : String(error), errorCode: classifyPluginError(error) }); fail(error instanceof Error ? error : new Error("JavaScript plugin failed to load.")); });
    });

    if (stopped.value) throw new Error("JavaScript plugin stopped during startup.");
    return instance;
  }
}

function getPluginSdkPreloadPath(): string {
  return `${app.getAppPath()}/plugin-sdk-preload.cjs`;
}

function installSdkHandler(channel: string, contents: WebContents, sdk: PluginSdkApi | undefined, pluginId: string): () => void {
  const logger = (sdk as SdkWithLogger | undefined)?.__logger;
  const syncListener = (event: IpcMainEvent, path: unknown, args: unknown[]) => {
    const started = Date.now();
    try {
      if (event.sender !== contents) throw new Error("Invalid plugin SDK sender.");
      if (!sdk || typeof path !== "string" || !isPluginSdkRoute(path) || !Array.isArray(args)) throw new Error("Invalid plugin SDK call.");
      event.returnValue = dispatchSyncSdkCall(sdk, path, args);
    } catch (error) {
      logPluginDiagnostic(logger, "warn", "plugin sdk dispatch failed", { pluginId, route: typeof path === "string" ? path : "invalid", ok: false, reason: error instanceof Error ? error.message : String(error), errorCode: classifyPluginError(error), durationMs: Date.now() - started });
      event.returnValue = serializePluginSdkError(error);
    }
  };
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, path: unknown, args: unknown[]) => {
    const started = Date.now();
    try {
      if (event.sender !== contents) throw new Error("Invalid plugin SDK sender.");
      if (!sdk || typeof path !== "string" || !isPluginSdkRoute(path) || !Array.isArray(args)) throw new Error("Invalid plugin SDK call.");
      return await dispatchSdkCall(contents, sdk, path, args);
    } catch (error) {
      logPluginDiagnostic(logger, "warn", "plugin sdk dispatch failed", { pluginId, route: typeof path === "string" ? path : "invalid", ok: false, reason: error instanceof Error ? error.message : String(error), errorCode: classifyPluginError(error), durationMs: Date.now() - started });
      return serializePluginSdkError(error);
    }
  });
  ipcMain.on(channel, syncListener);
  return () => { ipcMain.removeHandler(channel); ipcMain.off(channel, syncListener); };
}

type RunCallback = (id: unknown) => ((...callbackArgs: unknown[]) => Promise<unknown>) | undefined;
type SdkCallHandler = (sdk: PluginSdkApi, args: unknown[], runCallback: RunCallback, contents: WebContents) => unknown;

const noop = (): void => undefined;
const callbackOf = (runCallback: RunCallback, id: unknown): ((...callbackArgs: unknown[]) => unknown) => runCallback(id) ?? noop;
const requiredCallbackOf = (runCallback: RunCallback, id: unknown): ((...callbackArgs: unknown[]) => unknown) => {
  const callback = runCallback(id);
  if (!callback) throw new Error("Invalid plugin SDK callback.");
  return callback;
};

export const sdkCallHandlers: Record<PluginSdkRoute, SdkCallHandler> = {
  // Pet handles (first arg is the pet handle id; "default" targets the default pet).
  "pet.speak": (sdk, args) => sdk.pets.forPet(args[0]).speak(args[1]),
  "pet.react": (sdk, args) => sdk.pets.forPet(args[0]).react(args[1] as never, args[2]),
  "pet.setAnimation": (sdk, args) => sdk.pets.forPet(args[0]).setAnimation(args[1]),
  "pet.setScale": (sdk, args) => sdk.pets.forPet(args[0]).setScale(args[1]),
  "pet.setStatusReaction": (sdk, args) => sdk.pets.forPet(args[0]).setStatusReaction(args[1]),
  "pet.moveBy": (sdk, args) => sdk.pets.forPet(args[0]).moveBy(args[1]),
  "pet.wander": (sdk, args) => sdk.pets.forPet(args[0]).wander(args[1]),
  "pet.moveToHome": (sdk, args) => sdk.pets.forPet(args[0]).moveToHome(),
  "pet.moveTo": (sdk, args) => sdk.pets.forPet(args[0]).moveTo(args[1], args[2]),
  "pet.followCursor": (sdk, args) => sdk.pets.forPet(args[0]).followCursor(args[1]),
  "pet.physics": (sdk, args) => sdk.pets.forPet(args[0]).physics(args[1]),
  "pet.onTick": (sdk, args, runCallback) => sdk.pets.forPet(args[0]).onTick(callbackOf(runCallback, args[1])),
  "pet.offTick": (sdk, args) => sdk.pets.forPet("default").offTick(args[0]),
  "pet.getState": (sdk, args) => sdk.pets.forPet(args[0]).getState(),
  "pet.show": (sdk, args) => sdk.pets.forPet(args[0]).show(),
  "pet.hide": (sdk, args) => sdk.pets.forPet(args[0]).hide(),
  "pet.close": (sdk, args) => sdk.pets.forPet(args[0]).close(),
  "pets.list": (sdk) => sdk.pets.list(),
  "pets.spawn": (sdk, args) => sdk.pets.spawn(args[0]),
  "pets.onChange": (sdk, args, runCallback) => sdk.pets.onChange(callbackOf(runCallback, args[0])),
  "pets.offChange": (sdk, args) => sdk.pets.offChange(args[0]),
  // UI: bubbles, toasts, panels, menus.
  "ui.bubble": (sdk, args) => sdk.ui.bubble(args[0]),
  "ui.alert": (sdk, args) => sdk.ui.alert(args[0]),
  "ui.bubbleUpdate": (sdk, args) => sdk.ui.bubbleUpdate(args[0], args[1]),
  "ui.bubbleDismiss": (sdk, args) => sdk.ui.bubbleDismiss(args[0]),
  "ui.bubblePin": (sdk, args) => sdk.ui.bubblePin(args[0]),
  "ui.bubbleUnpin": (sdk, args) => sdk.ui.bubbleUnpin(args[0]),
  "ui.bubbleSubscribe": (sdk, args, runCallback) => sdk.ui.bubbleSubscribe(args[0], args[1], callbackOf(runCallback, args[2]) as never),
  "ui.toast": (sdk, args) => sdk.ui.toast(args[0]),
  "ui.panel": (sdk, args) => sdk.ui.panel(args[0]),
  "ui.panelShow": (sdk, args) => sdk.ui.panelShow(args[0]),
  "ui.panelHide": (sdk, args) => sdk.ui.panelHide(args[0]),
  "ui.panelPost": (sdk, args) => sdk.ui.panelPost(args[0], args[1]),
  "ui.panelClose": (sdk, args) => sdk.ui.panelClose(args[0]),
  "ui.panelOnMessage": (sdk, args, runCallback) => sdk.ui.panelOnMessage(args[0], callbackOf(runCallback, args[1])),
  "ui.delivery": (sdk, args) => sdk.ui.delivery(args[0]),
  "ui.deliveryDismiss": (sdk, args) => sdk.ui.deliveryDismiss(args[0]),
  "ui.deliverySubscribe": (sdk, args, runCallback) => sdk.ui.deliverySubscribe(args[0], callbackOf(runCallback, args[1]) as never),
  "ui.menuSetItems": (sdk, args) => sdk.ui.menuSetItems(args[0]),
  "ui.menuOnSelect": (sdk, args, runCallback) => sdk.ui.menuOnSelect(callbackOf(runCallback, args[0])),
  "ui.menuOffSelect": (sdk, args) => sdk.ui.menuOffSelect(args[0]),
  // Audio.
  "audio.play": (sdk, args) => sdk.audio.play(args[0], args[1]),
  "audio.importUserSound": (sdk, args) => sdk.audio.importUserSound(args[0], args[1]),
  "audio.forgetUserSound": (sdk, args) => sdk.audio.forgetUserSound(args[0]),
  "audio.stop": (sdk) => sdk.audio.stop(),
  // Senses bus.
  "events.on": (sdk, args, runCallback) => sdk.events.on(args[0], callbackOf(runCallback, args[1])),
  "events.off": (sdk, args) => sdk.events.off(args[0]),
  // Assets.
  // Preload currently constructs asset refs locally, but keep this route in the
  // canonical table for host-side parity and future explicit asset resolution.
  "assets.resolve": (sdk, args) => sdk.assets.resolve(args[0], args[1]),
  // Inter-plugin bus.
  "bus.publish": (sdk, args) => sdk.bus.publish(args[0], args[1]),
  "bus.subscribe": (sdk, args, runCallback) => sdk.bus.subscribe(args[0], callbackOf(runCallback, args[1])),
  "bus.unsubscribe": (sdk, args) => sdk.bus.unsubscribe(args[0]),
  // Scheduling.
  "schedule.once": (sdk, args, runCallback) => sdk.schedule.once(String(args[0]), Number(args[1]), callbackOf(runCallback, args[2])),
  "schedule.every": (sdk, args, runCallback) => sdk.schedule.every(String(args[0]), Number(args[1]), callbackOf(runCallback, args[2])),
  "schedule.daily": (sdk, args, runCallback) => sdk.schedule.daily(String(args[0]), args[1] as never, callbackOf(runCallback, args[2])),
  "schedule.cron": (sdk, args, runCallback) => sdk.schedule.cron(String(args[0]), args[1], callbackOf(runCallback, args[2])),
  "schedule.at": (sdk, args, runCallback) => sdk.schedule.at(String(args[0]), args[1], callbackOf(runCallback, args[2])),
  "schedule.list": (sdk) => sdk.schedule.list(),
  "schedule.cancel": (sdk, args) => sdk.schedule.cancel(String(args[0])),
  "schedule.cancelAll": (sdk) => sdk.schedule.cancelAll(),
  // Storage.
  "storage.get": (sdk, args) => sdk.storage.get(String(args[0])),
  "storage.set": (sdk, args) => sdk.storage.set(String(args[0]), args[1]),
  "storage.delete": (sdk, args) => sdk.storage.delete(String(args[0])),
  "storage.keys": (sdk) => sdk.storage.keys(),
  "storage.subscribe": (sdk, args, runCallback) => sdk.storage.subscribe(String(args[0]), callbackOf(runCallback, args[1])),
  "storage.unsubscribe": (sdk, args) => sdk.storage.unsubscribe(args[0]),
  // Config (special-cased disposers keyed by callback id).
  "config.get": (sdk) => sdk.config.get(),
  "config.onChange": (sdk, args, _runCallback, contents) => { const id = String(args[0] ?? ""); if (!id) return { ok: false }; const disposer = sdk.config.onChange((config) => { void contents.executeJavaScript(`globalThis.__openPetsRunCallback(${JSON.stringify(id)}, [${JSON.stringify(config)}])`, true); }); let map = configDisposers.get(contents); if (!map) { map = new Map(); configDisposers.set(contents, map); } map.set(id, disposer); return { ok: true }; },
  "config.offChange": (sdk, args, _runCallback, contents) => { const id = String(args[0] ?? ""); const disposer = configDisposers.get(contents)?.get(id); disposer?.(); configDisposers.get(contents)?.delete(id); return { ok: true }; },
  // Network.
  "net.fetch": (sdk, args) => sdk.net.fetch(String(args[0]), args[1]),
  "net.stream": (sdk, args, runCallback) => sdk.net.stream(String(args[0]), args[1], callbackOf(runCallback, args[2]) as (chunk: string) => void),
  // Notifications.
  "notify.notify": (sdk, args) => sdk.notify.notify(args[0]),
  // AI gateway.
  "ai.available": (sdk) => sdk.ai.available(),
  "ai.complete": (sdk, args) => sdk.ai.complete(args[0]),
  "ai.stream": (sdk, args, runCallback) => sdk.ai.stream(args[0], callbackOf(runCallback, args[1]) as (chunk: string) => void),
  // Secrets.
  "secrets.get": (sdk, args) => sdk.secrets.get(args[0]),
  "secrets.set": (sdk, args) => sdk.secrets.set(args[0], args[1]),
  "secrets.delete": (sdk, args) => sdk.secrets.delete(args[0]),
  "secrets.has": (sdk, args) => sdk.secrets.has(args[0]),
  // Voice.
  "voice.speak": (sdk, args) => sdk.voice.speak(args[0], args[1]),
  "voice.listen": (sdk, args) => sdk.voice.listen(args[0]),
  // Auth.
  "auth.oauth": (sdk, args) => sdk.auth.oauth(args[0]),
  "auth.refresh": (sdk, args) => sdk.auth.refresh(args[0]),
  "auth.signOut": (sdk, args) => sdk.auth.signOut(args[0]),
  // Files.
  "files.pick": (sdk, args) => sdk.files.pick(args[0]),
  "files.read": (sdk, args) => sdk.files.read(args[0], args[1]),
  "files.save": (sdk, args) => sdk.files.save(args[0]),
  // System.
  "system.info": (sdk) => sdk.system.info(),
  "system.metrics": (sdk) => sdk.system.metrics(),
  "system.openExternal": (sdk, args) => sdk.system.openExternal(args[0]),
  "system.readClipboardText": (sdk) => sdk.system.readClipboardText(),
  "system.writeClipboardText": (sdk, args) => sdk.system.writeClipboardText(args[0]),
  // Commands & status & legacy http & log.
  "commands.register": (sdk, args, runCallback) => sdk.commands.register(args[0] as never, callbackOf(runCallback, args[1])),
  "commands.unregister": (sdk, args) => sdk.commands.unregister(String(args[0])),
  "status.set": (sdk, args) => sdk.status.set(args[0] as never),
  "status.clear": (sdk) => sdk.status.clear(),
  "assistant.registerCapability": (sdk, args, runCallback) => sdk.assistant.registerCapability(args[0] as never, requiredCallbackOf(runCallback, args[1]) as never),
  "assistant.unregisterCapability": (sdk, args) => sdk.assistant.unregisterCapability(String(args[0])),
  "http.fetch": (sdk, args) => sdk.http.fetch(String(args[0]), args[1]),
  "log.debug": (sdk, args) => sdk.log.debug(...args),
  "log.info": (sdk, args) => sdk.log.info(...args),
  "log.warn": (sdk, args) => sdk.log.warn(...args),
  "log.error": (sdk, args) => sdk.log.error(...args),
  "i18n.t": (sdk, args) => sdk.t(String(args[0] ?? ""), args[1] as never),
  "i18n.locale": (sdk) => sdk.locale,
};

function dispatchSyncSdkCall(sdk: PluginSdkApi, path: PluginSdkRoute, args: unknown[]): unknown {
  if (!(pluginSdkSyncRoutes as readonly PluginSdkRoute[]).includes(path)) throw new Error("Plugin SDK call is not synchronous.");
  const handler = sdkCallHandlers[path];
  if (!handler) throw new Error("Unknown plugin SDK call.");
  return handler(sdk, args, () => undefined, undefined as never);
}

async function dispatchSdkCall(contents: WebContents, sdk: PluginSdkApi, path: PluginSdkRoute, args: unknown[]): Promise<unknown> {
  const runCallback: RunCallback = (id) => typeof id === "string" ? (...callbackArgs: unknown[]) => contents.executeJavaScript(`globalThis.__openPetsRunCallback(${JSON.stringify(id)}, ${JSON.stringify(callbackArgs)})`, true) : undefined;
  const handler = sdkCallHandlers[path];
  if (!handler) throw new Error("Unknown plugin SDK call.");
  return handler(sdk, args, runCallback, contents);
}

export type PluginJsRequestPolicy = { readonly entryUrl: string; readonly htmlUrl: string };

export function isAllowedPluginJsRequest(urlText: string, policy: PluginJsRequestPolicy): boolean {
  if (urlText === policy.entryUrl || urlText === policy.htmlUrl || urlText === "about:blank") return true;
  try {
    const url = new URL(urlText);
    return url.protocol === "data:" && urlText === policy.htmlUrl;
  } catch {
    return false;
  }
}

function hardenSession(pluginSession: Session, policy: PluginJsRequestPolicy): void {
  pluginSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  pluginSession.setPermissionCheckHandler(() => false);
  pluginSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedPluginJsRequest(details.url, policy) });
  });
}

function cleanupSession(pluginSession: Session): void {
  void pluginSession.clearStorageData().catch(() => undefined);
  void pluginSession.clearCache().catch(() => undefined);
}

function hardenWebContents(contents: WebContents, onBroken: (reason: string) => void): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.session.on("will-download", (event) => event.preventDefault());
  contents.on("render-process-gone", (_event, details) => onBroken(`JavaScript plugin renderer exited: ${details.reason}`));
  contents.on("unresponsive", () => onBroken("JavaScript plugin renderer became unresponsive."));
}

export function buildPluginHtmlUrl(entryUrl: string): string {
  void entryUrl;
  const csp = `default-src 'none'; script-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; form-action 'none'; base-uri 'none'`;
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content=${JSON.stringify(csp)}>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function buildPluginModuleUrl(source: string, sourceUrl: string): string {
  const withSourceUrl = `${source}\n//# sourceURL=${sourceUrl.replace(/\s/g, "%20")}`;
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(withSourceUrl)}`;
}

export function buildPluginRegistrationHandshakeCode(entryUrl: string): string {
  return `(() => new Promise((resolve, reject) => {
    let done = false;
    const sdk = globalThis.__openPetsSdk;
    const finish = (value) => { if (done) return; done = true; globalThis.__openPetsRegisteredPlugin = value; Promise.resolve(value && typeof value.start === "function" ? value.start(sdk) : undefined).then(() => resolve(true), reject); };
    Object.defineProperty(globalThis, "OpenPetsPlugin", { configurable: false, enumerable: false, writable: false, value: Object.freeze({ register: finish }) });
    import(${JSON.stringify(entryUrl)}).then((mod) => {
      if (mod && typeof mod.register === "function") Promise.resolve(mod.register(globalThis.OpenPetsPlugin)).then(finish, reject);
      else if (mod && typeof mod.default === "function") Promise.resolve(mod.default(globalThis.OpenPetsPlugin)).then(finish, reject);
      else setTimeout(() => { if (!done) reject(new Error("JavaScript plugin did not register.")); }, 0);
    }, reject);
  }))();`;
}

function runRegistrationHandshake(contents: WebContents, entryUrl: string, sdk: PluginSdkApi | undefined): Promise<unknown> {
  void sdk;
  return contents.executeJavaScript(buildPluginRegistrationHandshakeCode(entryUrl), true);
}

function stopRegisteredPlugin(contents: WebContents): Promise<unknown> {
  const code = `Promise.resolve(globalThis.__openPetsRegisteredPlugin && typeof globalThis.__openPetsRegisteredPlugin.stop === "function" ? globalThis.__openPetsRegisteredPlugin.stop() : undefined).then(() => true)`;
  return contents.executeJavaScript(code, true);
}
