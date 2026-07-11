import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import * as net from "node:net";
import { join } from "node:path";

import { getActiveLocaleLang } from "./i18n/index.js";
import type { OpenPetsReaction } from "./local-ipc-protocol.js";
import { validateReaction, validateSayMessage } from "./local-ipc-protocol.js";
import { makePluginT } from "./plugin-i18n.js";
import { resolveDeclaredAssetPath, resolveDeclaredPanelPath } from "./plugin-assets.js";
import type { PluginConfig } from "./plugin-config.js";
import type { OpenPetsJavascriptPluginManifest, PluginAssetKind, PluginPermission } from "./plugin-manifest.js";
import type { PluginPetApi } from "./plugin-pet-api.js";
import type { PluginRuntimeScheduler } from "./plugin-runtime.js";
import { createPluginAudioApi } from "./plugin-sdk-audio.js";
import { createPluginBusApi, type PluginBusTopicEntry } from "./plugin-sdk-bus.js";
import { createPluginConfigApi } from "./plugin-sdk-config.js";
import { createPluginEventsApi } from "./plugin-sdk-events.js";
import { pluginSdkQuotas } from "./plugin-sdk-quotas.js";
import type { ScheduleSpec, PluginInspectorState } from "./plugin-sdk-state.js";
import { WindowCounter, type PluginRuntimeState } from "./plugin-sdk-state.js";
import { createPluginStorageApi } from "./plugin-sdk-storage.js";
import { createPluginUiApi } from "./plugin-sdk-ui.js";
import type { PluginStateRecord, PluginStateStore } from "./plugin-state.js";
import { classifyPluginError, logPluginDiagnostic } from "./plugin-diagnostics.js";

// ---------------------------------------------------------------------------
// Public bridge types
// ---------------------------------------------------------------------------

export type PluginCommandFormField = {
  id: string;
  type: "text" | "textarea" | "number" | "boolean" | "select" | "multiSelect" | "time" | "date" | "list";
  label: string;
  default?: string | number | boolean | string[];
  options?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
  maxLength?: number;
  required?: boolean;
};
export type PluginCommandForm = { fields: readonly PluginCommandFormField[]; submitLabel?: string };
export type PluginIconAssetRef = { kind: "icon"; name: string };
export type PluginCommandIcon = string | PluginIconAssetRef;
export type PluginCommand = { id: string; title: string; description?: string; form?: PluginCommandForm; placement?: "top" | "submenu"; priority?: number; featured?: boolean; icon?: PluginCommandIcon; timeoutMs?: number };
export type PluginMenuItem = { id: string; title: string; enabled?: boolean; checked?: boolean };
export type PluginStatus = { text: string; tone?: "info" | "success" | "warning" | "error" };
export type PluginRuntimePublicState = { commands: readonly PluginCommand[]; status?: PluginStatus; menuItems?: readonly PluginMenuItem[] };
export type PluginLogLevel = "debug" | "info" | "warn" | "error";
export type PluginRuntimeLogger = (level: PluginLogLevel, message: string, fields?: Record<string, unknown>) => void;
export type PluginSdkApi = Omit<ReturnType<PluginSdkBridge["createApi"]>, "__logger">;
export interface PluginStorageStore { get(pluginId: string, key: string): unknown; set(pluginId: string, key: string, value: unknown): void; delete(pluginId: string, key: string): void; keys?(pluginId: string): string[] }

// ---------------------------------------------------------------------------
// Validated bubble descriptors (the host renders these; plugins only describe)
// ---------------------------------------------------------------------------

export type PluginBubbleAction = { id: string; label: string; style: "default" | "primary" | "danger"; iconName?: string; dismissesBubble: boolean };
export type PluginBubbleInput = { id: string; type: "text" | "number" | "select"; placeholder?: string; default?: string | number; options?: Array<{ value: string; label: string }>; submitLabel?: string };
export type PluginBubbleIndicator = {
  label?: string;
  tone?: "info" | "success" | "warning" | "error";
  iconName?: string;
  iconSvgPath?: string;
  imagePath?: string;
  color?: string;
  background?: string;
  borderColor?: string;
};
export type PluginBubbleHudItem = {
  iconName?: string;
  svgPath?: string;
  value: number;
  label?: string;
  tone?: "amber" | "blue" | "green" | "pink" | "slate" | "red";
};
export type PluginBubbleHud = {
  items: PluginBubbleHudItem[];
};
export type PluginBubbleDescriptor = {
  hud?: PluginBubbleHud;
  text?: string;
  /** Pre-sanitized HTML rendered from limited markdown (everything escaped first). */
  markdownHtml?: string;
  iconName?: string;
  /** Absolute path to an install-time sanitized bundled SVG. */
  svgPath?: string;
  /** Absolute path to a bundled raster image. */
  imagePath?: string;
  tone?: "info" | "success" | "warning" | "error";
  accent?: string;
  dynamic?: boolean;
  durationMs?: number;
  sticky?: boolean;
  pin?: boolean;
  dismissOn?: Array<"timeout" | "click" | "petClick" | "action" | "outsideClick">;
  priority: "low" | "normal" | "high" | "urgent";
  indicator?: PluginBubbleIndicator;
  actions?: PluginBubbleAction[];
  input?: PluginBubbleInput;
};
export type PluginBubbleDismissReason = "timeout" | "click" | "replaced" | "manual" | "unpinned";
export type PluginBubbleCallbacks = {
  onAction(actionId: string): void;
  onSubmit(values: Record<string, string | number>): void;
  onDismiss(reason: PluginBubbleDismissReason): void;
};
export interface PluginBubbleHostHandle {
  readonly id: string;
  update(patch: PluginBubbleDescriptor): Promise<void>;
  dismiss(): Promise<void>;
  pin(): Promise<void>;
  unpin(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Host capabilities — injected by the Electron layer, defaulted for tests
// ---------------------------------------------------------------------------

export type PluginPetInfo = { id: string; name: string; kind: "default" | "agent" | "plugin"; visible: boolean };
export type PluginPetState = { position: { x: number; y: number }; bounds: { x: number; y: number; width: number; height: number }; currentAnimation: string; visible: boolean; dragging: boolean };
export type PluginAnimationSpec = { kind: "reaction"; reaction: OpenPetsReaction } | { kind: "sprite"; spritePath: string; loop: boolean; fps: number };
export type PluginReactOptions = { showMessage?: boolean };
export type PluginPickedFileHost = { fileId: string; name: string; sizeBytes: number };
export type PluginAiRequest = { system?: string; messages: Array<{ role: "user" | "assistant"; content: string }>; maxTokens?: number; temperature?: number; tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> };
export type PluginAiResult = { text: string; toolCalls?: Array<{ name: string; input: Record<string, unknown> }> };
export type PluginOauthTokens = { accessToken: string; refreshToken?: string; expiresAt?: number };
export interface PluginPanelHostHandle { readonly id: string; show(): Promise<void>; hide(): Promise<void>; postMessage(msg: unknown): Promise<void>; close(): Promise<void> }
export type PluginDeliveryDescriptor = { key: string; courier: { kind: "sprite"; name: string }; title: string; detail: string; expiresAt: number };
export type PluginDeliveryDismissReason = "click" | "manual" | "expired" | "plugin-stopped";
export interface PluginDeliveryHostHandle { dismiss(): void; onDismiss(handler: (reason: PluginDeliveryDismissReason) => void): void }

export interface PluginHostCapabilities {
  bubbles: {
    show(opts: { petId: string; pluginId: string; bubble: PluginBubbleDescriptor; callbacks: PluginBubbleCallbacks }): Promise<PluginBubbleHostHandle>;
  };
  audio: {
    play(spec: { kind: "named"; name: string } | { kind: "file"; path: string } | { kind: "user-sound"; pluginId: string; id: string }, volume: number): Promise<void>;
    importUserSound(pluginId: string, fileId: string, opts?: { name?: string }): Promise<{ kind: "user-sound"; id: string; name?: string }>;
    importUserSoundFromPath?(pluginId: string, path: string, opts?: { name?: string }): Promise<{ kind: "user-sound"; id: string; name?: string }>;
    forgetUserSound(pluginId: string, ref: { kind: "user-sound"; id: string }): Promise<void>;
    stop(): Promise<void>;
  };
  events: {
    subscribe(event: string, handler: (payload: Record<string, unknown>) => void): () => void;
  };
  pets: {
    list(): PluginPetInfo[];
    spawn(opts: { pluginId: string; petId: string; name?: string; position?: { x: number; y: number } }): Promise<string>;
    close(pluginId: string, petHandleId: string): Promise<void>;
    show(petHandleId: string): Promise<void>;
    hide(petHandleId: string): Promise<void>;
    react(petHandleId: string, reaction: OpenPetsReaction, options?: PluginReactOptions): Promise<void>;
    setAnimation(petHandleId: string, spec: PluginAnimationSpec): Promise<void>;
    setScale(petHandleId: string, scale: number): Promise<void>;
    setStatusReaction(petHandleId: string, reaction: OpenPetsReaction | null): Promise<void>;
    moveBy(petHandleId: string, opts: { x: number; y: number; durationMs?: number }): Promise<void>;
    wander(petHandleId: string, opts: { distance?: number; durationMs?: number }): Promise<void>;
    moveToHome(petHandleId: string): Promise<void>;
    moveTo(petHandleId: string, point: { x: number; y: number }, opts?: { durationMs?: number; easing?: string }): Promise<void>;
    followCursor(petHandleId: string, pluginId: string, opts: { enabled: boolean; lag?: number }): Promise<void>;
    physics(petHandleId: string, pluginId: string, opts: { gravity?: boolean; bounce?: number; climbEdges?: boolean }): Promise<void>;
    getState(petHandleId: string): Promise<PluginPetState>;
    onTick(petHandleId: string, handler: (dtMs: number) => void): () => void;
    onChange(handler: (pets: PluginPetInfo[]) => void): () => void;
  };
  toast(spec: { text: string; tone?: "info" | "success" | "warning" | "error"; durationMs?: number }): Promise<void>;
  notify(spec: { title: string; body?: string; sound?: boolean }): Promise<void>;
  panels: {
    open(opts: { pluginId: string; installPath: string; panelPath: string; title?: string; width?: number; height?: number; onMessage: (msg: unknown) => void; onClosed: () => void }): Promise<PluginPanelHostHandle>;
  };
  delivery: {
    register(pluginId: string, descriptor: PluginDeliveryDescriptor): Promise<PluginDeliveryHostHandle>;
    teardown(pluginId: string): void;
  };
  secrets: {
    get(pluginId: string, key: string): Promise<string | undefined>;
    set(pluginId: string, key: string, value: string): Promise<void>;
    delete(pluginId: string, key: string): Promise<void>;
    has(pluginId: string, key: string): Promise<boolean>;
  };
  ai: {
    available(): Promise<boolean>;
    complete(req: PluginAiRequest): Promise<PluginAiResult>;
    stream(req: PluginAiRequest, onToken: (chunk: string) => void): Promise<{ text: string }>;
  };
  voice: {
    speak(text: string, opts: { voice?: string; rate?: number }): Promise<void>;
    listen(opts: { timeoutMs?: number }): Promise<{ text: string }>;
  };
  auth: {
    oauth(pluginId: string, config: { provider: "google" | "spotify"; clientId: string; clientSecret?: string; scopes: string[] }): Promise<PluginOauthTokens>;
    refresh(pluginId: string, provider: string): Promise<{ accessToken: string; expiresAt?: number }>;
    signOut(pluginId: string, provider: string): Promise<void>;
  };
  files: {
    pick(opts: { accept?: string[]; multiple?: boolean }): Promise<PluginPickedFileHost[]>;
    read(fileId: string, encoding: "text" | "bytes"): Promise<string | Uint8Array>;
    save(opts: { suggestedName: string; data: string | Uint8Array }): Promise<void>;
  };
  system: {
    info(): Promise<{ platform: "mac" | "win" | "linux"; locale: string; timezone: string; theme: "light" | "dark"; appVersion: string; online: boolean }>;
    metrics(): Promise<{ cpuPercent: number; memUsedPercent: number; battery?: { percent: number; charging: boolean } }>;
    openExternal(url: string): Promise<void>;
    readClipboardText(): Promise<string>;
    writeClipboardText(text: string): Promise<void>;
  };
  settings: {
    audioAllowed(): boolean;
    dynamicSpeechAllowed(): boolean;
    voiceAllowed(): boolean;
    listenAllowed(): boolean;
    inQuietHours(): boolean;
  };
  /** Trusted host lifecycle hook; not exposed through the plugin SDK. */
  clearPlugin?(pluginId: string): void;
}

/**
 * Capability defaults used when the Electron layer is not wired (contract
 * tests, headless runs). Pet speech/reactions fall back to the v2 pet API;
 * everything host-bound reports a clear, structured unavailability error.
 */
export function createDefaultPluginHostCapabilities(petApi: PluginPetApi): PluginHostCapabilities {
  const unavailable = (feature: string) => async (): Promise<never> => { throw new Error(`Plugin host capability is unavailable: ${feature}`); };
  return {
    bubbles: {
      async show({ bubble, callbacks }) {
        if (bubble.text) await petApi.speak(bubble.text);
        let dismissed = false;
        return {
          id: `bubble-${Math.random().toString(36).slice(2)}`,
          update: async () => undefined,
          dismiss: async () => { if (!dismissed) { dismissed = true; callbacks.onDismiss("manual"); } },
          pin: async () => undefined,
          unpin: async () => { if (!dismissed) { dismissed = true; callbacks.onDismiss("unpinned"); } },
        };
      },
    },
    audio: { play: async () => undefined, importUserSound: async (_pluginId, _fileId, opts) => ({ kind: "user-sound", id: "0".repeat(32), name: opts?.name }), importUserSoundFromPath: async (_pluginId, _path, opts) => ({ kind: "user-sound", id: "0".repeat(32), name: opts?.name }), forgetUserSound: async () => undefined, stop: async () => undefined },
    events: { subscribe: () => () => undefined },
    pets: {
      list: () => [{ id: "default", name: "Default pet", kind: "default", visible: true }],
      spawn: unavailable("pets.spawn"),
      close: unavailable("pets.close"),
      show: async () => undefined,
      hide: async () => undefined,
      react: async (_petId, reaction, options) => { await petApi.react(reaction, options); },
      setAnimation: async (_petId, spec) => { if (spec.kind === "reaction") await petApi.react(spec.reaction); },
      setScale: async () => undefined,
      setStatusReaction: async () => undefined,
      moveBy: async (_petId, opts) => { await petApi.moveBy(opts); },
      wander: async (_petId, opts) => { await petApi.wander(opts); },
      moveToHome: async () => { await petApi.moveToHome(); },
      moveTo: unavailable("pets.moveTo"),
      followCursor: async () => undefined,
      physics: async () => undefined,
      getState: async () => ({ position: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 0, height: 0 }, currentAnimation: "idle", visible: true, dragging: false }),
      onTick: () => () => undefined,
      onChange: () => () => undefined,
    },
    toast: async () => undefined,
    notify: async () => undefined,
    panels: { open: unavailable("panels.open") },
    delivery: { register: unavailable("delivery.register"), teardown: () => undefined },
    secrets: (() => {
      const store = new Map<string, string>();
      return {
        get: async (pluginId: string, key: string) => store.get(`${pluginId}\0${key}`),
        set: async (pluginId: string, key: string, value: string) => void store.set(`${pluginId}\0${key}`, value),
        delete: async (pluginId: string, key: string) => void store.delete(`${pluginId}\0${key}`),
        has: async (pluginId: string, key: string) => store.has(`${pluginId}\0${key}`),
      };
    })(),
    ai: { available: async () => false, complete: unavailable("ai.complete"), stream: unavailable("ai.stream") },
    voice: { speak: unavailable("voice.speak"), listen: unavailable("voice.listen") },
    auth: { oauth: unavailable("auth.oauth"), refresh: unavailable("auth.refresh"), signOut: async () => undefined },
    files: { pick: async () => [], read: unavailable("files.read"), save: unavailable("files.save") },
    system: {
      info: async () => ({ platform: process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux", locale: "en-US", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC", theme: "light", appVersion: "0.0.0", online: true }),
      metrics: async () => ({ cpuPercent: 0, memUsedPercent: 0 }),
      openExternal: unavailable("system.openExternal"),
      readClipboardText: unavailable("system.readClipboardText"),
      writeClipboardText: unavailable("system.writeClipboardText"),
    },
    settings: { audioAllowed: () => true, dynamicSpeechAllowed: () => false, voiceAllowed: () => true, listenAllowed: () => false, inQuietHours: () => false },
  };
}

// ---------------------------------------------------------------------------
// Quotas
// ---------------------------------------------------------------------------

const quotas = pluginSdkQuotas;

const commandIdPattern = /^[A-Za-z0-9._:-]{1,64}$/;
const scheduleIdPattern = /^[A-Za-z0-9._:-]{1,64}$/;
const allowedEventNames = new Set([
  "pet:clicked", "pet:doubleClicked", "pet:dragStart", "pet:dragEnd", "pet:hover", "pet:drop",
  "idle:enter", "idle:exit", "agent:activity", "config:changed",
  "screen:locked", "screen:unlocked", "power:battery-low", "power:charging",
  "display:changed", "online", "offline", "day:partChanged",
]);
export const pluginEventNames = allowedEventNames;
const allowedAccents = new Set(["blue", "purple", "green", "amber", "red", "pink", "slate"]);
const namedHostIcons = new Set(["info", "check", "alert", "heart", "star", "bell", "coffee", "timer", "droplet", "sparkles", "zap", "moon", "sun", "food", "play", "pause"]);
const safeCssColorPattern = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)|hsla?\(\s*\d{1,3}(?:deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/;

// ---------------------------------------------------------------------------
// Storage stores
// ---------------------------------------------------------------------------

export class JsonPluginStorageStore implements PluginStorageStore {
  readonly #root: string;
  constructor(root: string) { this.#root = root; }
  get(pluginId: string, key: string): unknown { return this.#read(pluginId)[key]; }
  set(pluginId: string, key: string, value: unknown): void { const data = { ...this.#read(pluginId), [key]: value }; const text = JSON.stringify(data); if (Buffer.byteLength(text) > quotas.storageBytes) throw new Error("Plugin storage quota exceeded."); this.#write(pluginId, data); }
  delete(pluginId: string, key: string): void { const data = { ...this.#read(pluginId) }; delete data[key]; this.#write(pluginId, data); }
  keys(pluginId: string): string[] { return Object.keys(this.#read(pluginId)); }
  #path(pluginId: string): string { return join(this.#root, `${pluginId}.json`); }
  #read(pluginId: string): Record<string, unknown> { try { const path = this.#path(pluginId); if (!existsSync(path)) return {}; const value = JSON.parse(readFileSync(path, "utf8")); return isRecord(value) ? value : {}; } catch { return {}; } }
  #write(pluginId: string, data: Record<string, unknown>): void { mkdirSync(this.#root, { recursive: true }); const path = this.#path(pluginId); const tmp = `${path}.${process.pid}.${Date.now()}.tmp`; writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8"); renameSync(tmp, path); }
}

export class MemoryPluginStorageStore implements PluginStorageStore {
  readonly #data = new Map<string, Record<string, unknown>>();
  get(pluginId: string, key: string): unknown { return this.#data.get(pluginId)?.[key]; }
  set(pluginId: string, key: string, value: unknown): void { const next = { ...(this.#data.get(pluginId) ?? {}), [key]: value }; if (Buffer.byteLength(JSON.stringify(next)) > quotas.storageBytes) throw new Error("Plugin storage quota exceeded."); this.#data.set(pluginId, next); }
  delete(pluginId: string, key: string): void { const next = { ...(this.#data.get(pluginId) ?? {}) }; delete next[key]; this.#data.set(pluginId, next); }
  keys(pluginId: string): string[] { return Object.keys(this.#data.get(pluginId) ?? {}); }
}

// ---------------------------------------------------------------------------
// Per-plugin runtime state
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

let nextOpaqueId = 0;
function opaqueId(prefix: string): string { return `${prefix}-${++nextOpaqueId}-${Math.random().toString(36).slice(2, 8)}`; }

export class PluginSdkBridge {
  readonly #stateStore: PluginStateStore;
  readonly #petApi: PluginPetApi;
  readonly #scheduler: PluginRuntimeScheduler;
  readonly #storage: PluginStorageStore;
  readonly #onError: (id: string, reason: string) => void;
  readonly #logger: PluginRuntimeLogger;
  readonly #capabilities: PluginHostCapabilities;
  readonly #states = new Map<string, PluginRuntimeState>();
  readonly #busTopics = new Map<string, Set<PluginBusTopicEntry>>();

  constructor(options: { stateStore: PluginStateStore; petApi: PluginPetApi; scheduler: PluginRuntimeScheduler; storage?: PluginStorageStore; onError?: (id: string, reason: string) => void; logger?: PluginRuntimeLogger; capabilities?: PluginHostCapabilities }) {
    this.#stateStore = options.stateStore;
    this.#petApi = options.petApi;
    this.#scheduler = options.scheduler;
    this.#storage = options.storage ?? new MemoryPluginStorageStore();
    this.#onError = (id, reason) => { const state = this.#pluginState(id); state.lastError = reason; (options.onError ?? (() => undefined))(id, reason); };
    this.#logger = options.logger ?? (() => undefined);
    this.#capabilities = options.capabilities ?? createDefaultPluginHostCapabilities(options.petApi);
  }

  createApi(record: PluginStateRecord, manifest: OpenPetsJavascriptPluginManifest) {
    const approved = new Set(record.approvedPermissions);
    const state = this.#pluginState(record.id);
    const caps = this.#capabilities;
    const pluginId = record.id;
    const requirePermission = (permission: PluginPermission) => { if (!approved.has(permission)) throw new Error(`Plugin permission is not approved: ${permission}`); };
    const runScheduled = async (callback: () => unknown) => { try { await callback(); } catch (error) { this.#onError(pluginId, safeError(error)); } };
    const getConfig = () => ({ ...(this.#stateStore.getRecord(pluginId)?.config ?? {}) }) as PluginConfig;
    const guardCallback = <A extends unknown[]>(fn: (...args: A) => unknown): ((...args: A) => void) => (...args) => { void Promise.resolve().then(() => fn(...args)).catch((error: unknown) => this.#onError(pluginId, safeError(error))); };

    const setSchedule = (id: string, spec: ScheduleSpec, callback: () => unknown) => {
      requirePermission("schedule");
      const scheduleId = String(id);
      if (!scheduleIdPattern.test(scheduleId)) throw new Error("Invalid plugin schedule id.");
      check(state.schedules.size < quotas.schedules || state.schedules.has(scheduleId), "Plugin schedule quota exceeded.");
      state.schedules.get(scheduleId)?.handle.cancel();
      const arm = () => {
        const delay = nextScheduleDelayMs(spec);
        if (delay === null) { state.schedules.delete(scheduleId); return; }
        const handle = this.#scheduler.setTimeout(() => {
          const current = state.schedules.get(scheduleId);
          if (!current || current.handle !== handle) return;
          void runScheduled(callback).finally(() => {
            const live = state.schedules.get(scheduleId);
            if (!live || live.handle !== handle) return;
            if (spec.type === "once" || spec.type === "at") state.schedules.delete(scheduleId);
            else arm();
          });
        }, delay);
        state.schedules.set(scheduleId, { spec, callback, handle, nextRunMs: Date.now() + delay });
      };
      arm();
    };

    const resolveAssetRef = (ref: unknown, kinds: readonly PluginAssetKind[]): { kind: PluginAssetKind; name: string; path: string } => {
      if (!isRecord(ref) || typeof ref.name !== "string") throw new Error("Invalid plugin asset reference.");
      const kindMap: Record<string, PluginAssetKind> = { icon: "icons", image: "images", svg: "svgs", sprite: "sprites", sound: "sounds" };
      const kind = kindMap[String(ref.kind)];
      if (!kind || !kinds.includes(kind)) throw new Error("Invalid plugin asset reference kind.");
      return { kind, name: ref.name, path: resolveDeclaredAssetPath(manifest, record.installPath, kind, ref.name) };
    };

    const validateBubbleSpec = (spec: unknown, forUpdate = false): PluginBubbleDescriptor => {
      const raw = typeof spec === "string" ? { text: spec } : spec;
      if (!isRecord(raw)) throw new Error("Invalid plugin bubble descriptor.");
      const out: PluginBubbleDescriptor = { priority: "normal" };
      const dynamic = raw.dynamic === true;
      if (dynamic) {
        requirePermission("pet:speak:dynamic");
        check(caps.settings.dynamicSpeechAllowed(), "AI-generated pet speech is disabled in settings.");
        out.dynamic = true;
      }
      const pinned = raw.pin === true;
      if (raw.text !== undefined) out.text = dynamic ? validateDynamicText(String(raw.text)) : pinned ? validatePinnedBubbleText(String(raw.text)) : validateSayMessage(String(raw.text));
      if (raw.markdown !== undefined) {
        const markdown = String(raw.markdown);
        check(markdown.length <= (dynamic ? quotas.dynamicTextChars : quotas.markdownChars), "Plugin bubble markdown is too long.");
        if (!dynamic) screenStaticBubbleText(markdown);
        else validateDynamicText(markdown);
        out.markdownHtml = renderLimitedMarkdown(markdown);
      }
      if (raw.icon !== undefined) {
        if (typeof raw.icon === "string") { check(namedHostIcons.has(raw.icon), "Unknown host icon name."); out.iconName = raw.icon; }
        else out.svgPath = resolveAssetRef(raw.icon, ["icons"]).path;
      }
      if (raw.svg !== undefined) out.svgPath = resolveAssetRef(raw.svg, ["svgs", "icons"]).path;
      if (raw.image !== undefined) out.imagePath = resolveAssetRef(raw.image, ["images"]).path;
      if (raw.tone !== undefined) { check(["info", "success", "warning", "error"].includes(String(raw.tone)), "Invalid bubble tone."); out.tone = raw.tone as PluginBubbleDescriptor["tone"]; }
      if (raw.accent !== undefined) { check(allowedAccents.has(String(raw.accent)), "Invalid bubble accent token."); out.accent = String(raw.accent); }
      if (raw.durationMs !== undefined) { const duration = Number(raw.durationMs); check(Number.isFinite(duration) && duration >= 500 && duration <= 10 * 60_000, "Invalid bubble durationMs."); out.durationMs = duration; }
      if (raw.sticky !== undefined) out.sticky = raw.sticky === true;
      if (raw.pin !== undefined) { if (raw.pin === true) { requirePermission("pet:pin"); out.pin = true; if (out.sticky === undefined && out.durationMs === undefined) out.sticky = true; } }
      if (raw.hud !== undefined) {
        if (!forUpdate) {
          check(raw.pin === true, "Bubble HUD descriptor is only allowed for pinned bubbles.");
        }
        out.hud = validateBubbleHud(raw.hud);
      }
      if (raw.dismissOn !== undefined) {
        check(Array.isArray(raw.dismissOn) && raw.dismissOn.length <= 5, "Invalid bubble dismissOn.");
        const allowed = new Set(["timeout", "click", "petClick", "action", "outsideClick"]);
        out.dismissOn = (raw.dismissOn as unknown[]).map((entry) => { check(allowed.has(String(entry)), "Invalid bubble dismissOn entry."); return String(entry) as NonNullable<PluginBubbleDescriptor["dismissOn"]>[number]; });
      }
      if (raw.priority !== undefined) { check(["low", "normal", "high", "urgent"].includes(String(raw.priority)), "Invalid bubble priority."); out.priority = raw.priority as PluginBubbleDescriptor["priority"]; }
      if (raw.indicator !== undefined && raw.indicator !== false) out.indicator = validateBubbleIndicator(raw.indicator);
      if (raw.actions !== undefined) { requirePermission("pet:interact"); out.actions = validateBubbleActions(raw.actions); }
      if (raw.input !== undefined) { requirePermission("pet:interact"); out.input = validateBubbleInput(raw.input); }
      if (out.text !== undefined || out.markdownHtml !== undefined) {
        check(out.iconName === undefined && out.svgPath === undefined && out.imagePath === undefined, "Plugin bubble body media cannot be combined with text or markdown. Use indicator for icon + message alerts.");
        check(out.hud === undefined, "Plugin bubble HUD cannot be combined with text or markdown.");
      }
      if (out.hud !== undefined) {
        check(out.text === undefined && out.markdownHtml === undefined && out.svgPath === undefined && out.imagePath === undefined && out.iconName === undefined && out.indicator === undefined, "Plugin bubble HUD cannot be combined with text, markdown, body media, or indicator.");
      }
      if (!forUpdate && out.text === undefined && out.markdownHtml === undefined && out.svgPath === undefined && out.imagePath === undefined && out.iconName === undefined && out.hud === undefined) throw new Error("Plugin bubble needs content (text, markdown, icon, svg, image, or hud).");
      return out;
    };

    const validateBubbleIndicator = (value: unknown): PluginBubbleIndicator => {
      if (!isRecord(value)) throw new Error("Invalid bubble indicator.");
      const indicator: PluginBubbleIndicator = {};
      if (value.label !== undefined) indicator.label = validateSayMessage(String(value.label));
      if (value.tone !== undefined) { check(["info", "success", "warning", "error"].includes(String(value.tone)), "Invalid bubble indicator tone."); indicator.tone = value.tone as PluginBubbleIndicator["tone"]; }
      if (value.icon !== undefined) {
        if (typeof value.icon === "string") { check(namedHostIcons.has(value.icon), "Unknown host icon name."); indicator.iconName = value.icon; }
        else assignIndicatorAssetPath(indicator, resolveAssetRef(value.icon, ["icons"]).path);
      }
      if (value.svg !== undefined) indicator.iconSvgPath = resolveAssetRef(value.svg, ["svgs", "icons"]).path;
      if (value.image !== undefined) indicator.imagePath = resolveAssetRef(value.image, ["images", "icons"]).path;
      if (value.color !== undefined) indicator.color = validateCssColor(value.color, "Invalid bubble indicator color.");
      if (value.background !== undefined) indicator.background = validateCssColor(value.background, "Invalid bubble indicator background.");
      if (value.backgroundColor !== undefined) indicator.background = validateCssColor(value.backgroundColor, "Invalid bubble indicator background color.");
      if (value.borderColor !== undefined) indicator.borderColor = validateCssColor(value.borderColor, "Invalid bubble indicator border color.");
      check(indicator.label !== undefined || indicator.iconName !== undefined || indicator.iconSvgPath !== undefined || indicator.imagePath !== undefined, "Bubble indicator needs a label or icon.");
      return indicator;
    };

    const assignIndicatorAssetPath = (indicator: PluginBubbleIndicator, path: string): void => {
      if (path.toLowerCase().endsWith(".svg")) indicator.iconSvgPath = path;
      else indicator.imagePath = path;
    };

    const validateBubbleHud = (value: unknown): PluginBubbleHud => {
      if (!isRecord(value)) throw new Error("Invalid bubble HUD descriptor.");
      const rawItems = value.items;
      check(Array.isArray(rawItems), "Bubble HUD items must be an array.");
      const itemsList = rawItems as unknown[];
      check(itemsList.length >= 1 && itemsList.length <= 4, "Bubble HUD items must contain between 1 and 4 items.");
      const items: PluginBubbleHudItem[] = [];
      for (const item of itemsList) {
        if (!isRecord(item)) throw new Error("Invalid bubble HUD item.");
        check(item.value !== undefined, "Bubble HUD item must have a value.");
        const val = Number(item.value);
        check(Number.isFinite(val) && val >= 0 && val <= 100, "Bubble HUD item value must be a number between 0 and 100.");

        const hudItem: PluginBubbleHudItem = { value: Math.round(val) };

        if (item.icon !== undefined) {
          if (typeof item.icon === "string") {
            check(namedHostIcons.has(item.icon), "Unknown host icon name in HUD item.");
            hudItem.iconName = item.icon;
          } else {
            hudItem.svgPath = resolveAssetRef(item.icon, ["icons"]).path;
          }
        } else {
          throw new Error("Bubble HUD item must have an icon.");
        }

        if (item.label !== undefined) {
          hudItem.label = validateSayMessage(String(item.label));
        }

        if (item.tone !== undefined) {
          check(["amber", "blue", "green", "pink", "slate", "red"].includes(String(item.tone)), "Invalid HUD item tone.");
          hudItem.tone = item.tone as PluginBubbleHudItem["tone"];
        }
        items.push(hudItem);
      }
      return { items };
    };

    const audio = createPluginAudioApi({ pluginId, state, capabilities: caps, requirePermission, audioPerMinute: quotas.audioPerMinute, resolveAssetRef });
    const ui = createPluginUiApi({ pluginId, manifest, installPath: record.installPath, state, capabilities: caps, audio, requirePermission, guardCallback, validateBubbleSpec, validatePetHandleId, resolvePanelPath: (name) => resolveDeclaredPanelPath(manifest, record.installPath, name), normalizeJson, validateMenuItems, validateSayMessage, safeError, logger: this.#logger, onError: (reason) => this.#onError(pluginId, reason), quotas });
    const storage = createPluginStorageApi({ pluginId, state, storage: this.#storage, requirePermission, guardCallback, validateStorageKey, onError: (reason) => this.#onError(pluginId, reason), safeError, storageSubscriptionsQuota: quotas.storageSubscriptions });
    const config = createPluginConfigApi({ state, getConfig });
    const events = createPluginEventsApi({ state, capabilities: caps, requirePermission, guardCallback, allowedEventNames, eventSubscriptionsQuota: quotas.eventSubscriptions });
    const bus = createPluginBusApi({ pluginId, state, topics: this.#busTopics, requirePermission, guardCallback, normalizeJson, busPerMinute: quotas.busPerMinute, busPayloadBytes: quotas.busPayloadBytes, busSubscriptionsQuota: quotas.busSubscriptions });

    const petNamespace = (petHandleId: string) => ({
      speak: (spec: unknown) => ui.showBubble(petHandleId, spec),
      react: async (reaction: OpenPetsReaction, options?: unknown) => {
        requirePermission("pet:reaction");
        state.petWindow.tick(quotas.petActionsPerMinute, "pet action");
        const opts = validateReactOptions(options);
        if (petHandleId === "default") await this.#petApi.react(validateReaction(reaction), opts);
        else await caps.pets.react(validatePetHandleId(petHandleId), validateReaction(reaction), opts);
      },
      setAnimation: async (animation: unknown) => {
        state.petWindow.tick(quotas.petActionsPerMinute, "pet action");
        if (typeof animation === "string") { requirePermission("pet:reaction"); await caps.pets.setAnimation(validatePetHandleId(petHandleId), { kind: "reaction", reaction: validateReaction(animation) }); return; }
        requirePermission("pet:animate");
        if (!isRecord(animation) || animation.sprite === undefined) throw new Error("Invalid pet animation state.");
        const sprite = resolveAssetRef(animation.sprite, ["sprites"]);
        const fps = animation.fps === undefined ? 8 : Number(animation.fps);
        check(Number.isFinite(fps) && fps >= 1 && fps <= 30, "Invalid sprite animation fps.");
        await caps.pets.setAnimation(validatePetHandleId(petHandleId), { kind: "sprite", spritePath: sprite.path, loop: animation.loop !== false, fps });
      },
      setScale: async (scale: unknown) => { requirePermission("pet:animate"); const value = Number(scale); check(Number.isFinite(value) && value >= 0.5 && value <= 2, "Pet scale must be between 0.5 and 2."); await caps.pets.setScale(validatePetHandleId(petHandleId), value); },
      setStatusReaction: async (reaction: unknown) => { requirePermission("pet:reaction"); state.petWindow.tick(quotas.petActionsPerMinute, "pet action"); await caps.pets.setStatusReaction(validatePetHandleId(petHandleId), reaction === null || reaction === "idle" ? null : validateReaction(reaction)); },
      moveBy: async (options: unknown) => { requirePermission("pet:move"); state.petWindow.tick(quotas.petActionsPerMinute, "pet action"); const opts = validateMoveBy(options); if (petHandleId === "default") await this.#petApi.moveBy(opts); else await caps.pets.moveBy(validatePetHandleId(petHandleId), opts); },
      wander: async (options: unknown) => { requirePermission("pet:move"); state.petWindow.tick(quotas.petActionsPerMinute, "pet action"); const opts = validateWander(options); if (petHandleId === "default") await this.#petApi.wander(opts); else await caps.pets.wander(validatePetHandleId(petHandleId), opts); },
      moveToHome: async () => { requirePermission("pet:move"); state.petWindow.tick(quotas.petActionsPerMinute, "pet action"); if (petHandleId === "default") await this.#petApi.moveToHome(); else await caps.pets.moveToHome(validatePetHandleId(petHandleId)); },
      moveTo: async (point: unknown, opts: unknown) => { requirePermission("pet:move"); state.petWindow.tick(quotas.petActionsPerMinute, "pet action"); await caps.pets.moveTo(validatePetHandleId(petHandleId), validatePoint(point), validateMoveToOptions(opts)); },
      followCursor: async (opts: unknown) => { requirePermission("pet:move"); const options = isRecord(opts) ? opts : { enabled: true }; const lag = options.lag === undefined ? undefined : Number(options.lag); if (lag !== undefined) check(Number.isFinite(lag) && lag >= 0 && lag <= 1, "followCursor lag must be 0..1."); await caps.pets.followCursor(validatePetHandleId(petHandleId), pluginId, { enabled: options.enabled !== false, lag }); },
      physics: async (opts: unknown) => { requirePermission("pet:move"); const options = isRecord(opts) ? opts : {}; const bounce = options.bounce === undefined ? undefined : Number(options.bounce); if (bounce !== undefined) check(Number.isFinite(bounce) && bounce >= 0 && bounce <= 1, "physics bounce must be 0..1."); await caps.pets.physics(validatePetHandleId(petHandleId), pluginId, { gravity: options.gravity === true, bounce, climbEdges: options.climbEdges === true }); },
      onTick: (handler: (dtMs: number) => void) => {
        requirePermission("events");
        check(state.tickSubscriptions.size < quotas.eventSubscriptions, "Plugin tick subscription quota exceeded.");
        const subId = opaqueId("tick");
        const dispose = caps.pets.onTick(validatePetHandleId(petHandleId), guardCallback(handler));
        state.tickSubscriptions.set(subId, dispose);
        return { subscriptionId: subId };
      },
      offTick: (subscriptionId: unknown) => { const dispose = state.tickSubscriptions.get(String(subscriptionId)); dispose?.(); state.tickSubscriptions.delete(String(subscriptionId)); },
      getState: async () => { requirePermission("pets:read"); return caps.pets.getState(validatePetHandleId(petHandleId)); },
      show: async () => { requirePermission("pets:manage"); await caps.pets.show(validatePetHandleId(petHandleId)); },
      hide: async () => { requirePermission("pets:manage"); await caps.pets.hide(validatePetHandleId(petHandleId)); },
      close: async () => {
        requirePermission("pets:manage");
        check(state.spawnedPets.has(petHandleId), "Plugins may only close pets they spawned.");
        await caps.pets.close(pluginId, petHandleId);
        state.spawnedPets.delete(petHandleId);
      },
    });

    return {
      __logger: this.#logger,
      pet: petNamespace("default"),
      pets: {
        list: async () => { requirePermission("pets:read"); return caps.pets.list(); },
        forPet: (petHandleId: unknown) => petNamespace(validatePetHandleId(petHandleId)),
        spawn: async (spec: unknown) => {
          requirePermission("pets:manage");
          check(state.spawnedPets.size < quotas.spawnedPets, "Plugin spawned pet quota exceeded.");
          if (!isRecord(spec) || typeof spec.petId !== "string") throw new Error("Invalid pet spawn spec.");
          const name = spec.name === undefined ? undefined : String(spec.name).slice(0, 60);
          const position = spec.position === undefined ? undefined : validatePoint(spec.position);
          const handleId = await caps.pets.spawn({ pluginId, petId: spec.petId, name, position });
          state.spawnedPets.add(handleId);
          return { petHandleId: handleId };
        },
        onChange: (handler: (pets: PluginPetInfo[]) => void) => {
          requirePermission("pets:read");
          check(state.eventSubscriptions.size < quotas.eventSubscriptions, "Plugin event subscription quota exceeded.");
          const subId = opaqueId("petschange");
          state.eventSubscriptions.set(subId, caps.pets.onChange(guardCallback(handler)));
          return { subscriptionId: subId };
        },
        offChange: (subscriptionId: unknown) => { state.eventSubscriptions.get(String(subscriptionId))?.(); state.eventSubscriptions.delete(String(subscriptionId)); },
      },
      ui: ui.api,
      audio,
      events,
      assets: {
        resolve: (kind: unknown, name: unknown) => {
          const kindMap: Record<string, PluginAssetKind> = { icon: "icons", image: "images", svg: "svgs", sprite: "sprites", sound: "sounds" };
          const mapped = kindMap[String(kind)];
          if (!mapped) throw new Error("Invalid plugin asset kind.");
          resolveDeclaredAssetPath(manifest, record.installPath, mapped, String(name));
          return { kind: String(kind), name: String(name) };
        },
      },
      bus,
      schedule: {
        once: (id: string, delayMs: number, callback: () => unknown) => { const delay = Number(delayMs); check(Number.isFinite(delay) && delay >= 1, "Invalid plugin schedule delay."); setSchedule(id, { type: "once", delayMs: delay }, callback); },
        every: (id: string, intervalMs: number, callback: () => unknown) => { const interval = Number(intervalMs); check(Number.isFinite(interval) && interval >= 10 * 60_000, "Invalid plugin schedule delay."); setSchedule(id, { type: "every", intervalMs: interval }, callback); },
        daily: (id: string, spec: string | { time: string; days?: number[] }, callback: () => unknown) => { setSchedule(id, { type: "daily", daily: parseDaily(spec) }, callback); },
        cron: (id: string, expr: unknown, callback: () => unknown) => { const expression = String(expr); parseCronExpression(expression); setSchedule(id, { type: "cron", expr: expression }, callback); },
        at: (id: string, isoTimestamp: unknown, callback: () => unknown) => { const timestamp = Date.parse(String(isoTimestamp)); check(Number.isFinite(timestamp), "Invalid schedule timestamp."); setSchedule(id, { type: "at", timestamp }, callback); },
        list: () => [...state.schedules.entries()].map(([id, slot]) => ({ id, nextRunMs: slot.nextRunMs })),
        cancel: (id: string) => { state.schedules.get(String(id))?.handle.cancel(); state.schedules.delete(String(id)); },
        cancelAll: () => { for (const slot of state.schedules.values()) slot.handle.cancel(); state.schedules.clear(); },
      },
      storage,
      config,
      net: {
        fetch: async (url: string, options?: unknown) => {
          requirePermission("network");
          state.httpWindow.tick(quotas.httpPerMinute, "HTTP");
          const opts = validateNetOptions(options, approved);
          return safeHttpFetch(String(url), opts, allowedNetworkHosts(record, manifest), { logger: this.#logger, pluginId, route: "net.fetch" });
        },
        stream: async (url: string, options: unknown, onChunk: (chunk: string) => void) => {
          requirePermission("network");
          state.httpWindow.tick(quotas.httpPerMinute, "HTTP");
          const opts = validateNetOptions(options, approved);
          return safeHttpStream(String(url), opts, allowedNetworkHosts(record, manifest), guardCallback(onChunk), { logger: this.#logger, pluginId, route: "net.stream" });
        },
      },
      notify: {
        notify: async (spec: unknown) => {
          requirePermission("notify");
          state.notifyWindow.tick(quotas.notifyPerMinute, "notification");
          if (!isRecord(spec)) throw new Error("Invalid notification spec.");
          const title = validateSayMessage(String(spec.title ?? ""));
          const body = spec.body === undefined ? undefined : validateSayMessage(String(spec.body));
          await caps.notify({ title, body, sound: spec.sound === true && caps.settings.audioAllowed() && !caps.settings.inQuietHours() });
        },
      },
      ai: {
        available: async () => { requirePermission("ai"); return caps.ai.available(); },
        complete: async (req: unknown) => { requirePermission("ai"); state.aiWindow.tick(quotas.aiPerMinute, "AI"); return caps.ai.complete(validateAiRequest(req)); },
        stream: async (req: unknown, onToken: (chunk: string) => void) => { requirePermission("ai"); state.aiWindow.tick(quotas.aiPerMinute, "AI"); return caps.ai.stream(validateAiRequest(req), guardCallback(onToken)); },
      },
      secrets: {
        get: async (key: unknown) => { requirePermission("secrets"); return caps.secrets.get(pluginId, validateStorageKey(String(key))); },
        set: async (key: unknown, value: unknown) => {
          requirePermission("secrets");
          const text = String(value);
          check(Buffer.byteLength(text) <= quotas.secretBytes, "Plugin secret is too large.");
          await caps.secrets.set(pluginId, validateStorageKey(String(key)), text);
        },
        delete: async (key: unknown) => { requirePermission("secrets"); await caps.secrets.delete(pluginId, validateStorageKey(String(key))); },
        has: async (key: unknown) => { requirePermission("secrets"); return caps.secrets.has(pluginId, validateStorageKey(String(key))); },
      },
      voice: {
        speak: async (text: unknown, opts?: unknown) => {
          requirePermission("voice:speak");
          state.voiceWindow.tick(quotas.voicePerMinute, "voice");
          check(caps.settings.voiceAllowed(), "Plugin voice is disabled in settings.");
          check(!caps.settings.inQuietHours(), "Quiet hours are active.");
          const speech = String(text).trim();
          check(speech.length >= 1 && speech.length <= 500 && !/[\0-\x08\x0B\x0C\x0E-\x1F]/.test(speech), "Invalid voice text.");
          const options = isRecord(opts) ? opts : {};
          const rate = options.rate === undefined ? undefined : clampNumber(Number(options.rate), 0.5, 2);
          const voice = options.voice === undefined ? undefined : String(options.voice).slice(0, 80);
          await caps.voice.speak(speech, { voice, rate });
        },
        listen: async (opts?: unknown) => {
          requirePermission("voice:listen");
          state.voiceWindow.tick(quotas.voicePerMinute, "voice");
          check(caps.settings.listenAllowed(), "Microphone access for plugins is disabled in settings.");
          const options = isRecord(opts) ? opts : {};
          const timeoutMs = options.timeoutMs === undefined ? 10_000 : clampNumber(Number(options.timeoutMs), 1_000, 30_000);
          return caps.voice.listen({ timeoutMs });
        },
      },
      auth: {
        oauth: async (config: unknown) => { requirePermission("auth"); return caps.auth.oauth(pluginId, validateOauthConfig(config)); },
        refresh: async (provider: unknown) => { requirePermission("auth"); return caps.auth.refresh(pluginId, validateProviderName(provider)); },
        signOut: async (provider: unknown) => { requirePermission("auth"); await caps.auth.signOut(pluginId, validateProviderName(provider)); },
      },
      files: {
        pick: async (opts?: unknown) => {
          requirePermission("files");
          const options = isRecord(opts) ? opts : {};
          const accept = options.accept === undefined ? undefined : (Array.isArray(options.accept) ? options.accept.slice(0, 16).map((ext) => String(ext).slice(0, 16)) : undefined);
          const picked = await caps.files.pick({ accept, multiple: options.multiple === true });
          for (const file of picked) state.pickedFiles.add(file.fileId);
          return picked;
        },
        read: async (fileId: unknown, encoding: unknown) => {
          // Picked files need `files`; user-dropped files are readable with `pet:drop` alone.
          if (!approved.has("files") && !approved.has("pet:drop")) throw new Error("Plugin permission is not approved: files");
          check(state.pickedFiles.has(String(fileId)), "Plugin file handle is invalid.");
          check(encoding === "text" || encoding === "bytes", "Invalid file read encoding.");
          return caps.files.read(String(fileId), encoding as "text" | "bytes");
        },
        save: async (opts: unknown) => {
          requirePermission("files");
          if (!isRecord(opts) || typeof opts.suggestedName !== "string") throw new Error("Invalid file save spec.");
          const suggestedName = opts.suggestedName.replace(/[/\\\0]/g, "").slice(0, 120);
          check(suggestedName.length > 0, "Invalid suggested file name.");
          const data = typeof opts.data === "string" ? opts.data : opts.data instanceof Uint8Array ? opts.data : undefined;
          if (data === undefined) throw new Error("File save data must be a string or bytes.");
          check((typeof data === "string" ? Buffer.byteLength(data) : data.byteLength) <= 16 * 1024 * 1024, "File save data is too large.");
          await caps.files.save({ suggestedName, data });
        },
      },
      system: {
        info: async () => caps.system.info(),
        metrics: async () => { requirePermission("system:metrics"); return caps.system.metrics(); },
        openExternal: async (url: unknown) => {
          requirePermission("system:openExternal");
          const parsed = new URL(String(url));
          check(parsed.protocol === "https:", "openExternal requires an HTTPS URL.");
          check(!parsed.username && !parsed.password, "openExternal URLs must not carry credentials.");
          await caps.system.openExternal(parsed.toString());
        },
        readClipboardText: async () => {
          requirePermission("clipboard");
          check(state.userCommandDepth > 0, "Clipboard reads are only allowed inside a user-invoked command.");
          return caps.system.readClipboardText();
        },
        writeClipboardText: async (text: unknown) => { requirePermission("clipboard"); await caps.system.writeClipboardText(String(text).slice(0, 64 * 1024)); },
      },
      commands: {
        register: (command: PluginCommand, handler: (values?: Record<string, unknown>) => unknown) => { requirePermission("commands"); const meta = validateCommand(command, (ref) => resolveAssetRef(ref, ["icons"])); check(state.commands.size < quotas.commands || state.commands.has(meta.id), "Plugin command quota exceeded."); state.commands.set(meta.id, { meta, handler }); },
        unregister: (id: string) => { state.commands.delete(String(id)); },
      },
      status: { set: (status: PluginStatus | string) => { requirePermission("status"); state.status = validateStatus(status); }, clear: () => { state.status = undefined; } },
      http: { fetch: async (url: string, options?: unknown) => { requirePermission("network"); state.httpWindow.tick(quotas.httpPerMinute, "HTTP"); const opts = isRecord(options) ? options : {}; check(opts.method === undefined || String(opts.method).toUpperCase() === "GET", "Plugin HTTP fetch only supports GET."); return safeHttpFetch(String(url), { method: "GET", headers: isRecord(opts.headers) ? opts.headers as Record<string, string> : undefined, timeoutMs: opts.timeoutMs === undefined ? undefined : Number(opts.timeoutMs) }, allowedNetworkHosts(record, manifest), { logger: this.#logger, pluginId, route: "http.fetch" }); } },
      log: Object.fromEntries((["debug", "info", "warn", "error"] as PluginLogLevel[]).map((level) => [level, (...args: unknown[]) => { state.logWindow.tick(quotas.logsPerMinute, "log"); this.#logger(level, "plugin log", { id: manifest.id, args }); }])) as Record<PluginLogLevel, (...args: unknown[]) => void>,
      t: makePluginT(manifest.id),
      get locale(): string { return getActiveLocaleLang(); },
    };
  }

  getPublicState(id: string): PluginRuntimePublicState {
    const state = this.#pluginState(id);
    return { commands: [...state.commands.values()].map((entry) => entry.meta), status: state.status, menuItems: state.menuItems.length > 0 ? [...state.menuItems] : undefined };
  }

  getInspectorState(id: string): PluginInspectorState {
    const state = this.#pluginState(id);
    return {
      schedules: [...state.schedules.entries()].map(([scheduleId, slot]) => ({ id: scheduleId, type: slot.spec.type, nextRunMs: slot.nextRunMs })),
      commands: [...state.commands.values()].map((entry) => entry.meta),
      menuItems: [...state.menuItems],
      status: state.status,
      activeBubbles: countActiveBubbles(state),
      activePanels: state.panels.size,
      eventSubscriptions: state.eventSubscriptions.size + state.busSubscriptions.size + state.tickSubscriptions.size,
      lastError: state.lastError,
      quotaCounters: { petActions: state.petWindow.count, logs: state.logWindow.count, http: state.httpWindow.count, bus: state.busWindow.count, audio: state.audioWindow.count, notify: state.notifyWindow.count, toast: state.toastWindow.count, ai: state.aiWindow.count, voice: state.voiceWindow.count },
    };
  }

  async executeCommand(id: string, commandId: string, args?: Record<string, unknown>, timeoutMs = 5_000): Promise<void> {
    const state = this.#pluginState(id);
    const command = state.commands.get(commandId);
    if (!command) throw new Error("Plugin command is not registered.");
    const values = command.meta.form ? validateCommandFormValues(command.meta.form, args) : undefined;
    state.userCommandDepth += 1;
    const release = () => { setTimeout(() => { state.userCommandDepth = Math.max(0, state.userCommandDepth - 1); }, 2_000).unref?.(); };
    try { await withTimeout(Promise.resolve().then(() => command.handler(values)), command.meta.timeoutMs ?? timeoutMs); } catch (error) { this.#logger("warn", "plugin callback failed", { pluginId: id, commandId, reason: safeError(error), errorCode: classifyPluginError(error) }); throw error; } finally { release(); }
  }

  async executeMenuSelect(id: string, itemId: string): Promise<void> {
    const state = this.#pluginState(id);
    if (!state.menuItems.some((item) => item.id === itemId)) throw new Error("Plugin menu item is not registered.");
    state.userCommandDepth += 1;
    try { for (const handler of state.menuHandlers) await Promise.resolve(handler(itemId)); } catch (error) { this.#logger("warn", "plugin callback failed", { pluginId: id, menuItemId: itemId, reason: safeError(error), errorCode: classifyPluginError(error) }); throw error; } finally { setTimeout(() => { state.userCommandDepth = Math.max(0, state.userCommandDepth - 1); }, 2_000).unref?.(); }
  }

  notifyConfigChanged(id: string): void {
    const state = this.#pluginState(id);
    const config = { ...(this.#stateStore.getRecord(id)?.config ?? {}) } as PluginConfig;
    for (const listener of state.configListeners) { try { listener(config); } catch (error) { this.#onError(id, safeError(error)); } }
  }

  /** Re-arm wall-clock schedules (daily/cron/at) after sleep/wake or clock changes. */
  resyncSchedules(): void {
    for (const state of this.#states.values()) {
      for (const [scheduleId, slot] of [...state.schedules.entries()]) {
        if (slot.spec.type !== "daily" && slot.spec.type !== "cron" && slot.spec.type !== "at") continue;
        slot.handle.cancel();
        const delay = nextScheduleDelayMs(slot.spec);
        if (delay === null) { state.schedules.delete(scheduleId); continue; }
        const rearm = () => {
          const nextDelay = nextScheduleDelayMs(slot.spec);
          if (nextDelay === null) { state.schedules.delete(scheduleId); return; }
          const handle = this.#scheduler.setTimeout(() => {
            const current = state.schedules.get(scheduleId);
            if (!current || current.handle !== handle) return;
            void Promise.resolve().then(() => current.callback()).catch(() => undefined).finally(() => {
              const live = state.schedules.get(scheduleId);
              if (!live || live.handle !== handle) return;
              if (slot.spec.type === "at") state.schedules.delete(scheduleId);
              else rearm();
            });
          }, nextDelay);
          state.schedules.set(scheduleId, { ...slot, handle, nextRunMs: Date.now() + nextDelay });
        };
        rearm();
      }
    }
  }

  clearPlugin(id: string): void {
    const state = this.#pluginState(id);
    for (const slot of state.schedules.values()) slot.handle.cancel();
    state.schedules.clear();
    state.commands.clear();
    state.menuItems = [];
    state.menuHandlers.clear();
    state.status = undefined;
    state.configListeners.clear();
    for (const dispose of state.eventSubscriptions.values()) { try { dispose(); } catch { /* best effort */ } }
    state.eventSubscriptions.clear();
    state.busSubscriptions.clear();
    for (const dispose of state.tickSubscriptions.values()) { try { dispose(); } catch { /* best effort */ } }
    state.tickSubscriptions.clear();
    state.storageSubscriptions.clear();
    for (const slot of state.bubbles.values()) { void slot.host.dismiss().catch(() => undefined); }
    state.bubbles.clear();
    state.deliveries.clear();
    this.#capabilities.delivery.teardown(id);
    for (const panel of state.panels.values()) { void panel.close().catch(() => undefined); }
    state.panels.clear();
    for (const petHandleId of state.spawnedPets) { void this.#capabilities.pets.close(id, petHandleId).catch(() => undefined); }
    state.spawnedPets.clear();
    state.pickedFiles.clear();
    state.userCommandDepth = 0;
    state.lastError = undefined;
    state.petWindow.reset(); state.logWindow.reset(); state.httpWindow.reset(); state.busWindow.reset(); state.audioWindow.reset(); state.notifyWindow.reset(); state.toastWindow.reset(); state.deliveryWindow.reset(); state.aiWindow.reset(); state.voiceWindow.reset();
  }

  #pluginState(id: string): PluginRuntimeState {
    let state = this.#states.get(id);
    if (!state) {
      state = {
        commands: new Map(), menuItems: [], menuHandlers: new Set(), schedules: new Map(), configListeners: new Set(),
        storageSubscriptions: new Map(), busSubscriptions: new Map(), eventSubscriptions: new Map(), tickSubscriptions: new Map(),
        bubbles: new Map(), deliveries: new Map(), panels: new Map(), spawnedPets: new Set(), pickedFiles: new Set(), userCommandDepth: 0,
        petWindow: new WindowCounter(), logWindow: new WindowCounter(), httpWindow: new WindowCounter(), busWindow: new WindowCounter(),
        audioWindow: new WindowCounter(), notifyWindow: new WindowCounter(), toastWindow: new WindowCounter(), deliveryWindow: new WindowCounter(), aiWindow: new WindowCounter(), voiceWindow: new WindowCounter(),
      };
      this.#states.set(id, state);
    }
    return state;
  }
}

function countActiveBubbles(state: PluginRuntimeState): number { return state.bubbles.size; }

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

type SimpleHttpResponse = { status: number; ok: boolean; headers: Record<string, string>; text: string; json?: unknown };
type ValidatedNetOptions = { method: string; headers?: Record<string, string>; body?: string; timeoutMs?: number };

const forbiddenHeaderNames = new Set(["host", "cookie", "cookie2", "origin", "referer", "content-length", "connection", "transfer-encoding", "upgrade", "keep-alive", "te", "trailer", "expect", "via"]);

function validateNetOptions(options: unknown, approved: ReadonlySet<PluginPermission>): ValidatedNetOptions {
  const opts = isRecord(options) ? options : {};
  const method = String(opts.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("Plugin HTTP method is not allowed.");
  if (method !== "GET" && !approved.has("network:write")) throw new Error("Plugin permission is not approved: network:write");
  let body: string | undefined;
  if (opts.body !== undefined) {
    if (method === "GET") throw new Error("Plugin GET requests must not have a body.");
    body = String(opts.body);
    if (Buffer.byteLength(body) > quotas.httpRequestBodyBytes) throw new Error("Plugin HTTP request body is too large.");
  }
  return { method, headers: safeNetHeaders(opts.headers), body, timeoutMs: opts.timeoutMs === undefined ? undefined : Number(opts.timeoutMs) };
}

function safeNetHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value).slice(0, 24)) {
    const lower = name.toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(lower) || forbiddenHeaderNames.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-")) continue;
    if (typeof headerValue !== "string" || headerValue.length > 4096 || /[\r\n\0]/.test(headerValue)) continue;
    out[lower] = headerValue;
  }
  return out;
}

function allowedNetworkHosts(record: PluginStateRecord, manifest: OpenPetsJavascriptPluginManifest): Set<string> { const manifestHosts = new Set((manifest.network?.hosts ?? []).map((h) => h.toLowerCase())); const approved = record.approvedNetworkHosts?.map((h) => h.toLowerCase()) ?? []; return new Set(approved.filter((h) => manifestHosts.has(h))); }

async function prepareSafeRequest(urlText: string, opts: ValidatedNetOptions, allowedHosts: Set<string>): Promise<{ url: URL; init: RequestInit; controller: AbortController; timeout: NodeJS.Timeout }> {
  const url = new URL(urlText);
  if (url.protocol !== "https:") throw new Error("Plugin HTTP fetch requires HTTPS.");
  if (url.username || url.password) throw new Error("Plugin HTTP fetch credentials are not allowed.");
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.has(host)) throw new Error("Plugin HTTP host is not approved.");
  await assertPublicHost(host);
  const controller = new AbortController();
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs ?? 10_000), 1_000), 120_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const init: RequestInit = { method: opts.method, redirect: "manual", credentials: "omit", signal: controller.signal, headers: opts.headers ?? {}, ...(opts.body === undefined ? {} : { body: opts.body }) };
  return { url, init, controller, timeout };
}

type NetworkDiagnostics = { logger?: PluginRuntimeLogger; pluginId?: string; route?: string };

export async function safeHttpFetch(urlText: string, options: ValidatedNetOptions | unknown, allowedHosts: Set<string>, diagnostics?: NetworkDiagnostics): Promise<SimpleHttpResponse> {
  const opts: ValidatedNetOptions = isValidatedNetOptions(options) ? options : { method: "GET", headers: undefined, timeoutMs: undefined };
  const started = Date.now();
  let host = "";
  try { host = new URL(urlText).hostname.toLowerCase(); } catch { host = "invalid"; }
  logPluginDiagnostic(diagnostics?.logger, "debug", "plugin network request", { pluginId: diagnostics?.pluginId, route: diagnostics?.route ?? "net.fetch", method: opts.method, host, phase: "begin" });
  let prepared: Awaited<ReturnType<typeof prepareSafeRequest>>;
  try { prepared = await prepareSafeRequest(urlText, opts, allowedHosts); }
  catch (error) { logPluginDiagnostic(diagnostics?.logger, "warn", "plugin network request", { pluginId: diagnostics?.pluginId, route: diagnostics?.route ?? "net.fetch", method: opts.method, host, phase: "denied", reason: error instanceof Error ? error.message : String(error), errorCode: classifyPluginError(error), durationMs: Date.now() - started }); throw error; }
  const { url, init, timeout } = prepared;
  try {
    const response = await fetch(url, init);
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) throw new Error("Plugin HTTP redirects are not allowed.");
    const text = await readCapped(response, quotas.httpResponseBytes);
    const headers: Record<string, string> = {};
    for (const key of ["content-type", "etag", "last-modified", "retry-after", "x-ratelimit-remaining"]) { const value = response.headers.get(key); if (value) headers[key] = value; }
    let json: unknown;
    if ((headers["content-type"] ?? "").includes("application/json")) { try { json = JSON.parse(text); } catch { json = undefined; } }
    logPluginDiagnostic(diagnostics?.logger, "debug", "plugin network request", { pluginId: diagnostics?.pluginId, route: diagnostics?.route ?? "net.fetch", method: opts.method, host: url.hostname, phase: "success", status: response.status, sizeBytes: Buffer.byteLength(text), durationMs: Date.now() - started });
    return { status: response.status, ok: response.ok, headers, text, ...(json === undefined ? {} : { json }) };
  } catch (error) {
    const mapped = error instanceof Error && error.name === "AbortError" ? new Error("Plugin HTTP fetch timed out.") : error;
    logPluginDiagnostic(diagnostics?.logger, "warn", "plugin network request", { pluginId: diagnostics?.pluginId, route: diagnostics?.route ?? "net.fetch", method: opts.method, host: url.hostname, phase: "fail", reason: mapped instanceof Error ? mapped.message : String(mapped), errorCode: classifyPluginError(mapped), durationMs: Date.now() - started });
    if (mapped instanceof Error) throw mapped;
    throw error;
  } finally { clearTimeout(timeout); }
}

export async function safeHttpStream(urlText: string, opts: ValidatedNetOptions, allowedHosts: Set<string>, onChunk: (chunk: string) => void, diagnostics?: NetworkDiagnostics): Promise<{ status: number; ok: boolean }> {
  const started = Date.now();
  let host = "";
  try { host = new URL(urlText).hostname.toLowerCase(); } catch { host = "invalid"; }
  let prepared: Awaited<ReturnType<typeof prepareSafeRequest>>;
  try { prepared = await prepareSafeRequest(urlText, { ...opts, timeoutMs: opts.timeoutMs ?? 120_000 }, allowedHosts); }
  catch (error) { logPluginDiagnostic(diagnostics?.logger, "warn", "plugin network request", { pluginId: diagnostics?.pluginId, route: diagnostics?.route ?? "net.stream", method: opts.method, host, phase: "denied", reason: error instanceof Error ? error.message : String(error), errorCode: classifyPluginError(error), durationMs: Date.now() - started }); throw error; }
  const { url, init, timeout } = prepared;
  try {
    const response = await fetch(url, init);
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) throw new Error("Plugin HTTP redirects are not allowed.");
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > quotas.streamResponseBytes) { await reader.cancel().catch(() => undefined); throw new Error("Plugin HTTP stream is too large."); }
        const chunk = decoder.decode(value, { stream: true });
        if (chunk.length > 0) onChunk(chunk);
      }
      const tail = decoder.decode();
      if (tail.length > 0) onChunk(tail);
    }
    logPluginDiagnostic(diagnostics?.logger, "debug", "plugin network request", { pluginId: diagnostics?.pluginId, route: diagnostics?.route ?? "net.stream", method: opts.method, host: url.hostname, phase: "success", status: response.status, durationMs: Date.now() - started });
    return { status: response.status, ok: response.ok };
  } catch (error) {
    const mapped = error instanceof Error && error.name === "AbortError" ? new Error("Plugin HTTP stream timed out.") : error;
    logPluginDiagnostic(diagnostics?.logger, "warn", "plugin network request", { pluginId: diagnostics?.pluginId, route: diagnostics?.route ?? "net.stream", method: opts.method, host: url.hostname, phase: "fail", reason: mapped instanceof Error ? mapped.message : String(mapped), errorCode: classifyPluginError(mapped), durationMs: Date.now() - started });
    if (mapped instanceof Error) throw mapped;
    throw error;
  } finally { clearTimeout(timeout); }
}

function isValidatedNetOptions(value: unknown): value is ValidatedNetOptions { return isRecord(value) && typeof value.method === "string"; }

async function readCapped(response: Response, cap: number): Promise<string> { const reader = response.body?.getReader(); if (!reader) return ""; const chunks: Uint8Array[] = []; let total = 0; for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > cap) throw new Error("Plugin HTTP response is too large."); chunks.push(value); } return Buffer.concat(chunks).toString("utf8"); }
export async function assertPublicHost(host: string): Promise<void> { if (["localhost", "metadata.google.internal"].includes(host) || host.endsWith(".localhost")) throw new Error("Plugin HTTP host is not public."); const results = await lookup(host, { all: true, verbatim: true }); if (results.length === 0 || results.some((r) => isPrivateIp(r.address))) throw new Error("Plugin HTTP host resolves to a restricted address."); }
export function isPrivateIp(address: string): boolean { if (net.isIPv4(address)) { const p = address.split(".").map(Number); return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127); } const v = address.toLowerCase(); return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80:") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168."); }

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function check(ok: boolean, message: string): void { if (!ok) throw new Error(message); }
function clampNumber(value: number, min: number, max: number): number { if (!Number.isFinite(value)) return min; return Math.min(Math.max(value, min), max); }
function validateCssColor(value: unknown, message: string): string { const color = String(value).trim(); check(color.length <= 48 && safeCssColorPattern.test(color), message); return color; }
function validateStorageKey(key: string): string { if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(key))) throw new Error("Invalid plugin storage key."); return String(key); }
function validatePetHandleId(value: unknown): string { const id = String(value); if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new Error("Invalid pet handle id."); return id; }
function validateReactOptions(value: unknown): PluginReactOptions | undefined { if (value === undefined) return undefined; if (!isRecord(value)) throw new Error("Invalid pet reaction options."); const keys = Object.keys(value); check(keys.every((key) => key === "showMessage"), "Invalid pet reaction option."); if (value.showMessage !== undefined && typeof value.showMessage !== "boolean") throw new Error("Invalid pet reaction showMessage option."); return value.showMessage === undefined ? {} : { showMessage: value.showMessage }; }
function validatePoint(value: unknown): { x: number; y: number } { if (!isRecord(value)) throw new Error("Invalid point."); const x = Number(value.x); const y = Number(value.y); if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Invalid point."); return { x, y }; }
function validateMoveToOptions(value: unknown): { durationMs?: number; easing?: string } { const opts = isRecord(value) ? value : {}; const durationMs = opts.durationMs === undefined ? undefined : clampNumber(Number(opts.durationMs), 100, 10_000); const easing = opts.easing === undefined ? undefined : (check(["linear", "ease-in", "ease-out", "ease-in-out"].includes(String(opts.easing)), "Invalid easing."), String(opts.easing)); return { durationMs, easing }; }

/** Relaxed screen for model-generated speech (§13.1): longer cap, secrets stripped. */
export function validateDynamicText(value: string): string {
  const text = value.replace(/[\0-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
  check(text.length >= 1, "Dynamic speech cannot be empty.");
  check(text.length <= quotas.dynamicTextChars, "Dynamic speech is too long.");
  // Strip obvious secret material even in dynamic mode.
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted]")
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]");
}

export function validatePinnedBubbleText(value: string): string {
  const text = value.trim().replace(/\r\n?/g, "\n");
  check(text.length >= 1, "Pinned bubble text cannot be empty.");
  check(text.length <= 140, "Pinned bubble text is too long.");
  const lines = text.split("\n");
  check(lines.length <= 4, "Pinned bubble text has too many lines.");
  check(lines.every((line) => line.trim().length > 0), "Pinned bubble text cannot contain blank lines.");
  return lines.map((line) => validateSayMessage(line)).join("\n");
}

/** Static (non-dynamic) bubble markdown still gets the ambient content screen. */
function screenStaticBubbleText(markdown: string): void {
  check(!/```|<script|function\s+\w+\(|\b(import|export)\s/.test(markdown), "Bubble markdown looks like code.");
  check(!/https?:\/\/|www\./.test(markdown), "Bubble markdown contains a URL.");
  check(!/(api[_-]?key|secret|password|BEGIN [A-Z ]+PRIVATE KEY)/i.test(markdown), "Bubble markdown looks secret-like.");
}

/**
 * Limited markdown -> safe HTML. Everything is HTML-escaped first; only
 * bold/italic/inline-code/line-break syntax is re-introduced as markup.
 */
export function renderLimitedMarkdown(markdown: string): string {
  const escaped = markdown
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}

function validateBubbleActions(value: unknown): PluginBubbleAction[] {
  check(Array.isArray(value) && value.length >= 1 && value.length <= 4, "Bubble actions must be 1-4 entries.");
  const seen = new Set<string>();
  return (value as unknown[]).map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !commandIdPattern.test(entry.id) || seen.has(entry.id)) throw new Error("Invalid bubble action id.");
    seen.add(entry.id);
    if (typeof entry.label !== "string" || entry.label.trim() === "" || entry.label.length > 32) throw new Error("Invalid bubble action label.");
    const style = entry.style === undefined ? "default" : String(entry.style);
    check(["default", "primary", "danger"].includes(style), "Invalid bubble action style.");
    const iconName = entry.icon === undefined ? undefined : (check(typeof entry.icon === "string" && namedHostIcons.has(entry.icon), "Invalid bubble action icon."), String(entry.icon));
    return { id: entry.id, label: entry.label, style: style as PluginBubbleAction["style"], iconName, dismissesBubble: entry.dismissesBubble !== false };
  });
}

function validateBubbleInput(value: unknown): PluginBubbleInput {
  if (!isRecord(value) || typeof value.id !== "string" || !commandIdPattern.test(value.id)) throw new Error("Invalid bubble input id.");
  const type = String(value.type);
  check(["text", "number", "select"].includes(type), "Invalid bubble input type.");
  const out: PluginBubbleInput = { id: value.id, type: type as PluginBubbleInput["type"] };
  if (value.placeholder !== undefined) { check(typeof value.placeholder === "string" && value.placeholder.length <= 60, "Invalid bubble input placeholder."); out.placeholder = String(value.placeholder); }
  if (value.submitLabel !== undefined) { check(typeof value.submitLabel === "string" && value.submitLabel.length <= 24 && value.submitLabel.trim() !== "", "Invalid bubble input submitLabel."); out.submitLabel = String(value.submitLabel); }
  if (value.default !== undefined) { check(typeof value.default === "string" ? value.default.length <= 200 : Number.isFinite(Number(value.default)), "Invalid bubble input default."); out.default = typeof value.default === "string" ? value.default : Number(value.default); }
  if (type === "select") {
    check(Array.isArray(value.options) && value.options.length >= 1 && value.options.length <= 8, "Bubble select inputs need 1-8 options.");
    out.options = (value.options as unknown[]).map((option) => { if (!isRecord(option) || typeof option.value !== "string" || option.value.length > 80 || typeof option.label !== "string" || option.label.length > 60) throw new Error("Invalid bubble input option."); return { value: option.value, label: option.label }; });
  }
  return out;
}

function validateMenuItems(value: unknown): PluginMenuItem[] {
  check(Array.isArray(value) && value.length <= quotas.menuItems, "Invalid plugin menu items.");
  const seen = new Set<string>();
  return (value as unknown[]).map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !commandIdPattern.test(entry.id) || seen.has(entry.id)) throw new Error("Invalid plugin menu item id.");
    seen.add(entry.id);
    if (typeof entry.title !== "string" || entry.title.trim() === "" || entry.title.length > 80) throw new Error("Invalid plugin menu item title.");
    return { id: entry.id, title: entry.title, enabled: entry.enabled === false ? false : undefined, checked: entry.checked === true ? true : undefined };
  });
}

function validateAiRequest(value: unknown): PluginAiRequest {
  if (!isRecord(value) || !Array.isArray(value.messages)) throw new Error("Invalid AI request.");
  check(value.messages.length >= 1 && value.messages.length <= 64, "AI request needs 1-64 messages.");
  const messages = (value.messages as unknown[]).map((entry) => {
    if (!isRecord(entry) || (entry.role !== "user" && entry.role !== "assistant") || typeof entry.content !== "string") throw new Error("Invalid AI message.");
    check(entry.content.length <= 32 * 1024, "AI message content is too long.");
    return { role: entry.role as "user" | "assistant", content: entry.content };
  });
  const out: PluginAiRequest = { messages };
  if (value.system !== undefined) { check(typeof value.system === "string" && value.system.length <= 32 * 1024, "Invalid AI system prompt."); out.system = String(value.system); }
  if (value.maxTokens !== undefined) out.maxTokens = clampNumber(Number(value.maxTokens), 1, 8192);
  if (value.temperature !== undefined) out.temperature = clampNumber(Number(value.temperature), 0, 2);
  if (value.tools !== undefined) {
    check(Array.isArray(value.tools) && value.tools.length <= 16, "AI request allows at most 16 tools.");
    out.tools = (value.tools as unknown[]).map((tool) => {
      if (!isRecord(tool) || typeof tool.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tool.name) || !isRecord(tool.inputSchema)) throw new Error("Invalid AI tool definition.");
      const description = tool.description === undefined ? undefined : String(tool.description).slice(0, 1024);
      return { name: tool.name, description, inputSchema: normalizeJson(tool.inputSchema, 16 * 1024, "AI tool schema") as Record<string, unknown> };
    });
  }
  return out;
}

function validateOauthConfig(value: unknown): { provider: "google" | "spotify"; clientId: string; clientSecret?: string; scopes: string[] } {
  if (!isRecord(value)) throw new Error("Invalid OAuth config.");
  check(value.authUrl === undefined && value.authorizationUrl === undefined && value.tokenUrl === undefined && value.pkce === undefined && value.usePkce === undefined && value.redirect === undefined && value.redirectUri === undefined, "OAuth endpoints and protected parameters are host-controlled.");
  const clientId = String(value.clientId ?? "");
  check(clientId.length >= 1 && clientId.length <= 512 && !/[\s\0]/.test(clientId), "Invalid OAuth clientId.");
  let clientSecret: string | undefined;
  if (value.clientSecret === undefined) clientSecret = undefined;
  else if (typeof value.clientSecret === "string" && value.clientSecret.length >= 1 && value.clientSecret.length <= 512 && !/[\s\0]/.test(value.clientSecret)) clientSecret = value.clientSecret;
  else throw new Error("Invalid OAuth clientSecret.");
  check(Array.isArray(value.scopes) && value.scopes.length >= 1 && value.scopes.length <= 32, "Invalid OAuth scopes.");
  const scopes = (value.scopes as unknown[]).map((scope) => { const text = String(scope); check(text.length >= 1 && text.length <= 256 && !/[\r\n\0]/.test(text), "Invalid OAuth scope."); return text; });
  const provider = String(value.provider);
  check(provider === "google" || provider === "spotify", "OAuth provider is not supported.");
  const allowedScopes = provider === "google"
    ? new Set(["https://www.googleapis.com/auth/calendar.events.readonly"])
    : new Set(["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing"]);
  check(new Set(scopes).size === scopes.length && scopes.every((scope) => allowedScopes.has(scope)), `OAuth scopes are not allowed for provider: ${provider}`);
  return { provider: provider as "google" | "spotify", clientId, clientSecret, scopes };
}

function validateProviderName(value: unknown): string { const provider = String(value); check(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider), "Invalid OAuth provider name."); return provider; }

/** Clone-safe JSON normalization with a byte cap. */
export function normalizeJson(value: unknown, maxBytes: number, label: string): unknown {
  let text: string;
  try { text = JSON.stringify(value ?? null); } catch { throw new Error(`Plugin ${label} must be JSON-compatible.`); }
  if (text === undefined) throw new Error(`Plugin ${label} must be JSON-compatible.`);
  check(Buffer.byteLength(text) <= maxBytes, `Plugin ${label} is too large.`);
  return JSON.parse(text) as unknown;
}

function validateCommand(command: PluginCommand, validateIconAssetRef: (ref: unknown) => { kind: PluginAssetKind; name: string; path: string }): PluginCommand {
  if (!command || !commandIdPattern.test(command.id)) throw new Error("Invalid plugin command id.");
  if (typeof command.title !== "string" || command.title.trim() === "" || command.title.length > 80) throw new Error("Invalid plugin command title.");
  if (command.description !== undefined && (typeof command.description !== "string" || command.description.length > 240)) throw new Error("Invalid plugin command description.");
  const placement = command.placement === undefined ? undefined : (check(command.placement === "top" || command.placement === "submenu", "Invalid plugin command placement."), command.placement);
  const priority = command.priority === undefined ? undefined : (check(Number.isFinite(Number(command.priority)), "Invalid plugin command priority."), clampNumber(Number(command.priority), -1000, 1000));
  const icon = command.icon === undefined ? undefined : validateCommandIcon(command.icon, validateIconAssetRef);
  const timeoutMs = command.timeoutMs === undefined ? undefined : (check(typeof command.timeoutMs === "number" && Number.isFinite(command.timeoutMs) && Number.isInteger(command.timeoutMs) && command.timeoutMs >= 1_000 && command.timeoutMs <= 5 * 60_000, "Invalid plugin command timeoutMs."), command.timeoutMs);
  return { id: command.id, title: command.title, description: command.description, form: validateCommandForm(command.form), placement, priority, featured: command.featured === true || undefined, icon, timeoutMs };
}

function validateCommandIcon(icon: unknown, validateIconAssetRef: (ref: unknown) => { kind: PluginAssetKind; name: string; path: string }): PluginCommandIcon {
  if (typeof icon === "string") {
    check(namedHostIcons.has(icon), "Invalid plugin command icon.");
    return icon;
  }
  if (!isRecord(icon) || icon.kind !== "icon" || typeof icon.name !== "string") throw new Error("Invalid plugin command icon.");
  validateIconAssetRef(icon);
  return { kind: "icon", name: icon.name };
}

const commandFormFieldTypes = new Set(["text", "textarea", "number", "boolean", "select", "multiSelect", "time", "date", "list"]);

function validateCommandForm(form: unknown): PluginCommandForm | undefined {
  if (form === undefined) return undefined;
  if (!isRecord(form) || !Array.isArray(form.fields) || form.fields.length < 1 || form.fields.length > 8) throw new Error("Invalid plugin command form.");
  const seen = new Set<string>();
  const fields = form.fields.map((field) => {
    if (!isRecord(field) || typeof field.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(field.id) || seen.has(field.id)) throw new Error("Invalid plugin command form field id.");
    seen.add(field.id);
    if (!commandFormFieldTypes.has(String(field.type))) throw new Error("Invalid plugin command form field type.");
    if (typeof field.label !== "string" || field.label.trim() === "" || field.label.length > 80) throw new Error("Invalid plugin command form label.");
    const out: PluginCommandFormField = { id: field.id, type: field.type as PluginCommandFormField["type"], label: field.label, required: field.required === true || undefined };
    if (out.type === "number") {
      if (field.default !== undefined && !Number.isFinite(Number(field.default))) throw new Error("Invalid plugin command form default.");
      if (field.min !== undefined && !Number.isFinite(Number(field.min))) throw new Error("Invalid plugin command form min.");
      if (field.max !== undefined && !Number.isFinite(Number(field.max))) throw new Error("Invalid plugin command form max.");
      if (field.min !== undefined) out.min = Number(field.min);
      if (field.max !== undefined) out.max = Number(field.max);
      if (out.min !== undefined && out.max !== undefined && out.min > out.max) throw new Error("Invalid plugin command form range.");
      if (field.default !== undefined) out.default = Number(field.default);
    } else if (out.type === "boolean") {
      if (field.default !== undefined && typeof field.default !== "boolean") throw new Error("Invalid plugin command form default.");
      if (field.default !== undefined) out.default = field.default;
    } else if (out.type === "select" || out.type === "multiSelect") {
      if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 24) throw new Error("Invalid plugin command form options.");
      const values = new Set<string>();
      out.options = field.options.map((option) => {
        if (!isRecord(option) || typeof option.value !== "string" || option.value.length > 120 || typeof option.label !== "string" || option.label.trim() === "" || option.label.length > 80 || values.has(option.value)) throw new Error("Invalid plugin command form option.");
        values.add(option.value);
        return { label: option.label, value: option.value };
      });
      if (field.default !== undefined) {
        if (out.type === "multiSelect") { if (!Array.isArray(field.default) || field.default.some((entry) => typeof entry !== "string" || !values.has(entry))) throw new Error("Invalid plugin command form default."); out.default = field.default as string[]; }
        else { if (typeof field.default !== "string" || !values.has(field.default)) throw new Error("Invalid plugin command form default."); out.default = field.default; }
      }
    } else if (out.type === "time") {
      if (field.default !== undefined && (typeof field.default !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(field.default))) throw new Error("Invalid plugin command form default.");
      if (field.default !== undefined) out.default = field.default;
    } else if (out.type === "date") {
      if (field.default !== undefined && (typeof field.default !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(field.default))) throw new Error("Invalid plugin command form default.");
      if (field.default !== undefined) out.default = field.default;
    } else if (out.type === "list") {
      if (field.default !== undefined && (!Array.isArray(field.default) || field.default.some((entry) => typeof entry !== "string" || entry.length > 200) || field.default.length > 32)) throw new Error("Invalid plugin command form default.");
      if (field.default !== undefined) out.default = field.default as string[];
      if (field.maxLength !== undefined && (!Number.isInteger(Number(field.maxLength)) || Number(field.maxLength) < 1 || Number(field.maxLength) > 1000)) throw new Error("Invalid plugin command form maxLength.");
      if (field.maxLength !== undefined) out.maxLength = Number(field.maxLength);
    } else {
      if (field.default !== undefined && typeof field.default !== "string") throw new Error("Invalid plugin command form default.");
      if (field.maxLength !== undefined && (!Number.isInteger(Number(field.maxLength)) || Number(field.maxLength) < 1 || Number(field.maxLength) > 1000)) throw new Error("Invalid plugin command form maxLength.");
      if (field.default !== undefined) out.default = field.default;
      if (field.maxLength !== undefined) out.maxLength = Number(field.maxLength);
    }
    return out;
  });
  const submitLabel = typeof form.submitLabel === "string" && form.submitLabel.trim() && form.submitLabel.length <= 40 ? form.submitLabel : undefined;
  return { fields, submitLabel };
}

export function validateCommandFormValues(form: PluginCommandForm, args: unknown): Record<string, unknown> {
  const input = isRecord(args) ? args : {};
  const out: Record<string, unknown> = {};
  for (const field of form.fields) {
    const raw = input[field.id];
    if (field.type === "number") {
      const value = Number(raw ?? field.default ?? 0);
      if (!Number.isFinite(value)) throw new Error(`${field.label} must be a number.`);
      if (field.min !== undefined && value < field.min) throw new Error(`${field.label} is too small.`);
      if (field.max !== undefined && value > field.max) throw new Error(`${field.label} is too large.`);
      out[field.id] = value;
    } else if (field.type === "boolean") {
      out[field.id] = raw === undefined ? field.default === true : raw === true || raw === "true";
    } else if (field.type === "select") {
      const value = String(raw ?? field.default ?? "");
      if (field.required && !value) throw new Error(`${field.label} is required.`);
      if (value && !(field.options ?? []).some((option) => option.value === value)) throw new Error(`${field.label} has an invalid value.`);
      out[field.id] = value;
    } else if (field.type === "multiSelect") {
      const values = Array.isArray(raw) ? raw.map(String) : Array.isArray(field.default) ? field.default : [];
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      if (values.some((value) => !allowed.has(value))) throw new Error(`${field.label} has an invalid value.`);
      out[field.id] = values;
    } else if (field.type === "time") {
      const value = String(raw ?? field.default ?? "").trim();
      if (field.required && !value) throw new Error(`${field.label} is required.`);
      if (value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`${field.label} must be HH:mm.`);
      out[field.id] = value;
    } else if (field.type === "date") {
      const value = String(raw ?? field.default ?? "").trim();
      if (field.required && !value) throw new Error(`${field.label} is required.`);
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field.label} must be YYYY-MM-DD.`);
      out[field.id] = value;
    } else if (field.type === "list") {
      const values = Array.isArray(raw) ? raw.map((entry) => String(entry).trim()).filter(Boolean) : Array.isArray(field.default) ? field.default : [];
      if (values.length > 32) throw new Error(`${field.label} has too many entries.`);
      if (field.maxLength !== undefined && values.some((value) => value.length > field.maxLength!)) throw new Error(`${field.label} entries are too long.`);
      out[field.id] = values;
    } else {
      const text = String(raw ?? field.default ?? "").trim();
      if (field.required && !text) throw new Error(`${field.label} is required.`);
      if (field.maxLength !== undefined && text.length > field.maxLength) throw new Error(`${field.label} is too long.`);
      out[field.id] = text;
    }
  }
  return out;
}

function validateStatus(status: PluginStatus | string): PluginStatus { const value = typeof status === "string" ? { text: status } : status; if (!value || typeof value.text !== "string" || value.text.trim() === "" || value.text.length > 120) throw new Error("Invalid plugin status text."); if (value.tone !== undefined && !["info", "success", "warning", "error"].includes(value.tone)) throw new Error("Invalid plugin status tone."); return { text: value.text, tone: value.tone }; }
function validateMoveBy(value: unknown): { x: number; y: number; durationMs?: number } { if (!isRecord(value)) throw new Error("Invalid pet movement options."); const x = Number(value.x); const y = Number(value.y); if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Invalid pet movement distance."); return { x, y, durationMs: value.durationMs === undefined ? undefined : Number(value.durationMs) }; }
function validateWander(value: unknown): { distance?: number; durationMs?: number } { const options = isRecord(value) ? value : {}; return { distance: options.distance === undefined ? undefined : Number(options.distance), durationMs: options.durationMs === undefined ? undefined : Number(options.durationMs) }; }
function parseDaily(spec: string | { time: string; days?: number[] }): { time: string; days?: number[] } { const value = typeof spec === "string" ? { time: spec } : spec; const m = /^(\d{2}):(\d{2})$/.exec(value.time); if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error("Daily schedule time must be HH:mm between 00:00 and 23:59."); if (value.days && (!Array.isArray(value.days) || value.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) throw new Error("Daily schedule days must be weekdays 0-6."); return value; }
function msUntilDaily(spec: { time: string; days?: number[] }): number { const [hour, minute] = spec.time.split(":").map(Number); const now = new Date(); for (let add = 0; add <= 7; add += 1) { const next = new Date(now); next.setDate(now.getDate() + add); next.setHours(hour ?? 0, minute ?? 0, 0, 0); if (next > now && (!spec.days || spec.days.includes(next.getDay()))) return next.getTime() - now.getTime(); } return 24 * 60 * 60 * 1000; }

function nextScheduleDelayMs(spec: ScheduleSpec): number | null {
  if (spec.type === "once") return Math.max(1, spec.delayMs);
  if (spec.type === "every") return Math.max(1, spec.intervalMs);
  if (spec.type === "daily") return msUntilDaily(spec.daily);
  if (spec.type === "at") return Math.max(1_000, spec.timestamp - Date.now());
  const next = nextCronRunMs(spec.expr, Date.now());
  return next === null ? null : Math.max(1_000, next - Date.now());
}

// ---------------------------------------------------------------------------
// 5-field cron (m h dom mon dow)
// ---------------------------------------------------------------------------

type CronField = Set<number>;
type ParsedCron = { minutes: CronField; hours: CronField; daysOfMonth: CronField; months: CronField; daysOfWeek: CronField; domWildcard: boolean; dowWildcard: boolean };

export function parseCronExpression(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron expressions must have 5 fields (m h dom mon dow).");
  const [minutePart, hourPart, domPart, monthPart, dowPart] = parts as [string, string, string, string, string];
  return {
    minutes: parseCronField(minutePart, 0, 59),
    hours: parseCronField(hourPart, 0, 23),
    daysOfMonth: parseCronField(domPart, 1, 31),
    months: parseCronField(monthPart, 1, 12),
    daysOfWeek: parseCronField(dowPart, 0, 7, true),
    domWildcard: domPart === "*",
    dowWildcard: dowPart === "*",
  };
}

function parseCronField(field: string, min: number, max: number, mapSevenToZero = false): CronField {
  const values = new Set<number>();
  if (field.length === 0 || field.length > 64) throw new Error("Invalid cron field.");
  for (const part of field.split(",")) {
    const stepMatch = /^(.+)\/(\d+)$/.exec(part);
    const base = stepMatch ? stepMatch[1]! : part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1 || step > max) throw new Error("Invalid cron step.");
    let start = min; let end = max;
    if (base !== "*") {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(base);
      if (rangeMatch) { start = Number(rangeMatch[1]); end = Number(rangeMatch[2]); }
      else { if (!/^\d+$/.test(base)) throw new Error("Invalid cron value."); start = Number(base); end = stepMatch ? max : start; }
    }
    if (start < min || end > max || start > end) throw new Error("Cron value out of range.");
    for (let value = start; value <= end; value += step) values.add(mapSevenToZero && value === 7 ? 0 : value);
  }
  if (values.size === 0) throw new Error("Invalid cron field.");
  return values;
}

/** Next run strictly after `fromMs`, or null if none within 4 years. */
export function nextCronRunMs(expr: string, fromMs: number): number | null {
  const cron = parseCronExpression(expr);
  const candidate = new Date(fromMs);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const limit = fromMs + 4 * 366 * 24 * 60 * 60 * 1000;
  while (candidate.getTime() <= limit) {
    if (!cron.months.has(candidate.getMonth() + 1)) { candidate.setMonth(candidate.getMonth() + 1, 1); candidate.setHours(0, 0, 0, 0); continue; }
    const domMatch = cron.daysOfMonth.has(candidate.getDate());
    const dowMatch = cron.daysOfWeek.has(candidate.getDay());
    const dayMatch = cron.domWildcard && cron.dowWildcard ? true : cron.domWildcard ? dowMatch : cron.dowWildcard ? domMatch : domMatch || dowMatch;
    if (!dayMatch) { candidate.setDate(candidate.getDate() + 1); candidate.setHours(0, 0, 0, 0); continue; }
    if (!cron.hours.has(candidate.getHours())) { candidate.setHours(candidate.getHours() + 1, 0, 0, 0); continue; }
    if (!cron.minutes.has(candidate.getMinutes())) { candidate.setMinutes(candidate.getMinutes() + 1, 0, 0); continue; }
    return candidate.getTime();
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> { return new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("Plugin command timed out.")), timeoutMs); promise.then((v) => { clearTimeout(timeout); resolve(v); }, (e) => { clearTimeout(timeout); reject(e); }); }); }
function safeError(error: unknown): string { return error instanceof Error ? error.message : "Plugin SDK callback failed."; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
