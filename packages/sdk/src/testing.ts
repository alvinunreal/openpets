/**
 * `@open-pets/plugin-sdk/testing` — the supported plugin test kit (§18.2).
 *
 * Lets a plugin's `start` handler run against a fully mocked
 * {@link OpenPetsContext} with no Electron, no network, no real timers, and
 * no real user data:
 *
 * ```ts
 * import { createTestHarness } from "@open-pets/plugin-sdk/testing"
 * import { register } from "../src/index.js"
 *
 * const h = createTestHarness(register, {
 *   permissions: ["pet:speak", "schedule", "storage"],
 *   config: { frequency: "low" },
 * })
 * await h.start()
 * await h.clock.advance("90m")
 * h.expectSpoke(/stretch/i)
 * ```
 */
import type {
  OpenPetsBubble,
  OpenPetsBubbleDismissReason,
  OpenPetsBubbleHandle,
  OpenPetsAlert,
  OpenPetsAlertHandle,
  OpenPetsAssistantCapability,
  OpenPetsAssistantCapabilityHandler,
  OpenPetsCommand,
  OpenPetsCommandHandler,
  OpenPetsContext,
  OpenPetsDelivery,
  OpenPetsDeliveryDismissReason,
  OpenPetsDeliveryHandle,
  OpenPetsEventName,
  OpenPetsMenuItem,
  OpenPetsPermission,
  OpenPetsPetHandle,
  OpenPetsPetInfo,
  OpenPetsPetState,
  OpenPetsPluginApi,
  OpenPetsPluginDefinition,
  OpenPetsPluginEntry,
  OpenPetsReaction,
  OpenPetsScheduleHandler,
  OpenPetsStatus,
  OpenPetsUserSoundRef,
} from "./index.js";

// ---------------------------------------------------------------------------
// Recorded call shapes
// ---------------------------------------------------------------------------

export interface RecordedBubble {
  spec: OpenPetsBubble;
  handle: OpenPetsBubbleHandle;
  petId: string;
  updates: Array<Partial<OpenPetsBubble>>;
  pinned: boolean;
  dismissed: boolean;
}

export interface RecordedAlert {
  spec: OpenPetsAlert;
  handle: OpenPetsAlertHandle;
  bubble: RecordedBubble;
  updates: Array<Partial<OpenPetsBubble>>;
  dismissed: boolean;
  acknowledged: boolean;
}

export interface RecordedDelivery {
  /** Deterministic delivery id accepted by `harness.dismissDelivery`. */
  id: string;
  spec: OpenPetsDelivery;
  handle: OpenPetsDeliveryHandle;
  dismissed: boolean;
}

export interface RecordedAssistantCapability {
  capability: OpenPetsAssistantCapability;
  handler: OpenPetsAssistantCapabilityHandler;
}

export interface RecordedSchedule {
  type: "once" | "every" | "daily" | "cron" | "at";
  handler: OpenPetsScheduleHandler;
  dueMs: number;
  intervalMs?: number;
  daily?: { time: string; days?: number[] };
  cronExpr?: string;
}

export interface RecordedNetCall {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  stream: boolean;
}

export interface MockCalls {
  speak: string[];
  react: string[];
  reactions: Array<{ reaction: string; options?: { showMessage?: boolean } }>;
  statusReactions: Array<string | null>;
  status: OpenPetsStatus[];
  storage: Map<string, unknown>;
  schedules: Map<string, RecordedSchedule>;
  commands: Map<string, { meta: OpenPetsCommand; handler: OpenPetsCommandHandler }>;
  assistantCapabilities: Map<string, RecordedAssistantCapability>;
  menuItems: OpenPetsMenuItem[];
  bubbles: RecordedBubble[];
  alerts: RecordedAlert[];
  deliveries: RecordedDelivery[];
  dismissedBubbles: string[];
  toasts: Array<{ text: string; tone?: string }>;
  notifications: Array<{ title: string; body?: string }>;
  sounds: Array<{ sound: unknown; volume?: number }>;
  importedUserSounds: Array<{ ref: OpenPetsUserSoundRef; fileName: string; name?: string }>;
  forgottenUserSounds: OpenPetsUserSoundRef[];
  busPublishes: Array<{ topic: string; payload: unknown }>;
  netCalls: RecordedNetCall[];
  aiCalls: Array<{ system?: string; messages: Array<{ role: string; content: string }> }>;
  voiceSpeaks: string[];
  openedExternal: string[];
  clipboardWrites: string[];
  spawnedPets: string[];
  panelMessages: unknown[];
  savedFiles: Array<{ suggestedName: string; data: string | Uint8Array }>;
  secrets: Map<string, string>;
  errors: string[];
}

const allowedReactions = new Set<string>(["idle", "thinking", "working", "editing", "running", "testing", "waiting", "waving", "success", "error", "celebrating"]);

function assertReaction(value: unknown): void {
  if (typeof value !== "string" || !allowedReactions.has(value)) throw new Error("Invalid pet reaction.");
}

export interface MockContextOptions {
  /** Approved permissions. Omit to approve everything (legacy default). */
  permissions?: readonly OpenPetsPermission[];
  /** Effective plugin config returned by `ctx.config.get()`. */
  config?: Record<string, unknown>;
  /**
   * Initial virtual clock value (ms since epoch). Defaults to the real
   * current time so plugin code using `Date.now()` stays consistent with the
   * harness clock; pin it explicitly for fully reproducible cron/daily tests.
   */
  nowMs?: number;
  /**
   * Optional in-memory plugin catalogs keyed by locale, mirroring the host's
   * `locales/<locale>.json` files. When provided, `ctx.t(key, vars)` resolves
   * against the active locale's catalog, then the `en` catalog, then echoes the
   * key. When omitted, `ctx.t` simply echoes the key with `{vars}` interpolated.
   *
   * ```ts
   * createTestHarness(register, {
   *   locales: { en: { "greet": "Hi {name}" }, ja: { "greet": "やあ {name}" } },
   * })
   * ```
   */
  locales?: Record<string, Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

export class FakeClock {
  #nowMs: number;
  readonly #schedules: Map<string, RecordedSchedule>;
  readonly #onError: (message: string) => void;

  constructor(nowMs: number, schedules: Map<string, RecordedSchedule>, onError: (message: string) => void) {
    this.#nowMs = nowMs;
    this.#schedules = schedules;
    this.#onError = onError;
  }

  now(): number {
    return this.#nowMs;
  }

  /** Advance virtual time, firing due schedules in order. Accepts ms or "30s"/"90m"/"2h"/"1d". */
  async advance(amount: number | string): Promise<void> {
    const target = this.#nowMs + parseDuration(amount);
    for (;;) {
      let nextId: string | undefined;
      let nextDue = Number.POSITIVE_INFINITY;
      for (const [id, schedule] of this.#schedules) {
        if (schedule.dueMs <= target && schedule.dueMs < nextDue) { nextDue = schedule.dueMs; nextId = id; }
      }
      if (nextId === undefined) break;
      const schedule = this.#schedules.get(nextId)!;
      this.#nowMs = Math.max(this.#nowMs, schedule.dueMs);
      if (schedule.type === "once" || schedule.type === "at") this.#schedules.delete(nextId);
      else if (schedule.type === "every") schedule.dueMs += schedule.intervalMs ?? 60_000;
      else if (schedule.type === "daily") schedule.dueMs = nextDailyRunMs(schedule.daily!, this.#nowMs);
      else schedule.dueMs = nextCronRunMs(schedule.cronExpr!, this.#nowMs) ?? Number.POSITIVE_INFINITY;
      try { await schedule.handler(); } catch (error) { this.#onError(error instanceof Error ? error.message : String(error)); }
    }
    this.#nowMs = target;
  }

  computeDue(schedule: Omit<RecordedSchedule, "dueMs">): number {
    if (schedule.type === "every") return this.#nowMs + (schedule.intervalMs ?? 60_000);
    if (schedule.type === "daily") return nextDailyRunMs(schedule.daily!, this.#nowMs);
    if (schedule.type === "cron") return nextCronRunMs(schedule.cronExpr!, this.#nowMs) ?? Number.POSITIVE_INFINITY;
    return this.#nowMs + (schedule.intervalMs ?? 0);
  }
}

/** Replace `{name}` placeholders, mirroring the host catalog's `interpolate`. */
function interpolateVars(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}

function parseDuration(amount: number | string): number {
  if (typeof amount === "number") return amount;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(amount.trim());
  if (!match) throw new Error(`Invalid duration: ${amount}`);
  const value = Number(match[1]);
  const unit = match[2] as "ms" | "s" | "m" | "h" | "d";
  return value * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
}

function nextDailyRunMs(spec: { time: string; days?: number[] }, fromMs: number): number {
  const [hour, minute] = spec.time.split(":").map(Number);
  const from = new Date(fromMs);
  for (let add = 0; add <= 7; add += 1) {
    const next = new Date(fromMs);
    next.setDate(from.getDate() + add);
    next.setHours(hour ?? 0, minute ?? 0, 0, 0);
    if (next.getTime() > fromMs && (!spec.days || spec.days.includes(next.getDay()))) return next.getTime();
  }
  return fromMs + 86_400_000;
}

/** Minimal 5-field cron next-run (m h dom mon dow), mirroring the host scheduler. */
export function nextCronRunMs(expr: string, fromMs: number): number | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron expressions must have 5 fields.");
  const [minutes, hours, dom, months, dow] = fields.map((field, index) => {
    const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    const [min, max] = ranges[index]!;
    const values = new Set<number>();
    for (const part of field!.split(",")) {
      const stepMatch = /^(.+)\/(\d+)$/.exec(part);
      const base = stepMatch ? stepMatch[1]! : part;
      const step = stepMatch ? Number(stepMatch[2]) : 1;
      let start = min; let end = max;
      if (base !== "*") {
        const range = /^(\d+)-(\d+)$/.exec(base);
        if (range) { start = Number(range[1]); end = Number(range[2]); }
        else { start = Number(base); end = stepMatch ? max : start; }
      }
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) throw new Error("Invalid cron field.");
      for (let value = start; value <= end; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    return values;
  }) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  const domWildcard = fields[2] === "*";
  const dowWildcard = fields[4] === "*";
  const candidate = new Date(fromMs);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const limit = fromMs + 4 * 366 * 86_400_000;
  while (candidate.getTime() <= limit) {
    if (!months.has(candidate.getMonth() + 1)) { candidate.setMonth(candidate.getMonth() + 1, 1); candidate.setHours(0, 0, 0, 0); continue; }
    const dayMatch = domWildcard && dowWildcard ? true : domWildcard ? dow.has(candidate.getDay()) : dowWildcard ? dom.has(candidate.getDate()) : dom.has(candidate.getDate()) || dow.has(candidate.getDay());
    if (!dayMatch) { candidate.setDate(candidate.getDate() + 1); candidate.setHours(0, 0, 0, 0); continue; }
    if (!hours.has(candidate.getHours())) { candidate.setHours(candidate.getHours() + 1, 0, 0, 0); continue; }
    if (!minutes.has(candidate.getMinutes())) { candidate.setMinutes(candidate.getMinutes() + 1, 0, 0); continue; }
    return candidate.getTime();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mock context
// ---------------------------------------------------------------------------

type EventHandler = (payload: unknown) => void;

// Minimal declarations so this types-only package needs no DOM lib.
declare class TextDecoder { decode(input?: Uint8Array): string }
declare class TextEncoder { encode(input?: string): Uint8Array }

export interface MockHarnessCore {
  clock: FakeClock;
  emit(event: OpenPetsEventName, payload: unknown): Promise<void>;
  fireBubbleAction(bubbleId: string, actionId: string): Promise<void>;
  fireBubbleSubmit(bubbleId: string, values: Record<string, string | number>): Promise<void>;
  dismissBubble(bubbleId: string, reason?: OpenPetsBubbleDismissReason): Promise<void>;
  dismissDelivery(deliveryId: string, reason?: OpenPetsDeliveryDismissReason): Promise<void>;
  /**
   * Invoke a recorded capability handler directly for deterministic plugin
   * behavior tests. This assumes a host-valid descriptor and input; it does
   * not emulate the desktop bridge's security or validation boundary.
   */
  runCapability(id: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  runCommand(commandId: string, values?: Record<string, unknown>): Promise<void>;
  setConfig(config: Record<string, unknown>): Promise<void>;
  net: { mock(urlPrefix: string, response: { status?: number; json?: unknown; text?: string; chunks?: string[] }): void };
  ai: { mock(responder: (req: { system?: string; messages: Array<{ role: string; content: string }> }) => string): void };
  files: { provide(files: Array<{ name: string; text?: string; bytes?: Uint8Array }>): void };
  auth: { mock(tokens: { accessToken: string; refreshToken?: string; expiresAt?: number }): void };
  voice: { mockListen(text: string): void };
  system: { set(info: Partial<{ platform: "mac" | "win" | "linux"; locale: string; timezone: string; theme: "light" | "dark"; online: boolean }>): void; setMetrics(metrics: { cpuPercent: number; memUsedPercent: number; battery?: { percent: number; charging: boolean } }): void; setClipboard(text: string): void };
  panel: { sendToPlugin(msg: unknown): void };
}

export function createMockContext(optionsOrConfig: MockContextOptions | Record<string, unknown> = {}): {
  ctx: OpenPetsContext;
  calls: MockCalls;
  harness: MockHarnessCore;
  cleanup(): Promise<void>;
} {
  const options: MockContextOptions = isMockOptions(optionsOrConfig) ? optionsOrConfig : { config: optionsOrConfig as Record<string, unknown> };
  const approved = options.permissions === undefined ? null : new Set(options.permissions);
  let config = { ...(options.config ?? {}) };
  const calls: MockCalls = {
    speak: [], react: [], reactions: [], statusReactions: [], status: [], storage: new Map(), schedules: new Map(), commands: new Map(), menuItems: [],
    bubbles: [], alerts: [], deliveries: [], dismissedBubbles: [], toasts: [], notifications: [], sounds: [], importedUserSounds: [], forgottenUserSounds: [], busPublishes: [], netCalls: [],
    aiCalls: [], voiceSpeaks: [], openedExternal: [], clipboardWrites: [], spawnedPets: [], panelMessages: [], assistantCapabilities: new Map(),
    savedFiles: [], secrets: new Map(), errors: [],
  };
  const clock = new FakeClock(options.nowMs ?? Date.now(), calls.schedules, (message) => calls.errors.push(message));
  const eventSubscribers = new Map<string, Set<EventHandler>>();
  const storageSubscribers = new Map<string, Set<(value: unknown) => void>>();
  const busSubscribers = new Map<string, Set<(payload: unknown) => void>>();
  const configListeners = new Set<(value: Record<string, unknown>) => void | Promise<void>>();
  const panelToPluginHandlers = new Set<(msg: unknown) => void>();
  const panelClosers = new Set<() => Promise<void>>();
  const netMocks: Array<{ urlPrefix: string; response: { status?: number; json?: unknown; text?: string; chunks?: string[] } }> = [];
  let aiResponder: ((req: { system?: string; messages: Array<{ role: string; content: string }> }) => string) | null = null;
  let pickableFiles: Array<{ name: string; text?: string; bytes?: Uint8Array }> = [];
  let authTokens: { accessToken: string; refreshToken?: string; expiresAt?: number } | null = null;
  let listenText: string | null = null;
  let clipboardText = "";
  let systemInfo: { platform: "mac" | "win" | "linux"; locale: string; timezone: string; theme: "light" | "dark"; appVersion: string; online: boolean } = { platform: "mac", locale: "en-US", timezone: "UTC", theme: "light", appVersion: "0.0.0-test", online: true };
  let systemMetrics: { cpuPercent: number; memUsedPercent: number; battery?: { percent: number; charging: boolean } } = { cpuPercent: 5, memUsedPercent: 40 };
  let nextId = 0;
  const newId = (prefix: string) => `${prefix}-${++nextId}`;

  // ---- i18n: ctx.t / ctx.locale ----
  // `ctx.locale` defaults to "en" and follows `harness.system.set({ locale })`.
  // `ctx.t` resolves an optional in-memory catalog (active locale -> exact, then
  // language prefix, then `en`), then echoes the key, finally interpolating {vars}.
  const localeCatalogs = options.locales;
  const activeLocale = (): string => {
    const raw = systemInfo.locale;
    return raw && raw !== "en-US" ? raw : "en";
  };
  const lookupCatalog = (key: string): string | undefined => {
    if (!localeCatalogs) return undefined;
    const locale = activeLocale();
    const lang = locale.split(/[-_]/)[0]!;
    return localeCatalogs[locale]?.[key] ?? localeCatalogs[lang]?.[key] ?? localeCatalogs.en?.[key];
  };
  const translate = (key: string, vars?: Record<string, string | number>): string =>
    interpolateVars(lookupCatalog(key) ?? key, vars);

  const requirePermission = (permission: OpenPetsPermission): void => {
    if (approved !== null && !approved.has(permission)) throw new Error(`Plugin permission is not approved: ${permission}`);
  };

  const makeBubble = (petId: string, spec: string | OpenPetsBubble): OpenPetsBubbleHandle => {
    requirePermission("pet:speak");
    const normalized: OpenPetsBubble = typeof spec === "string" ? { text: spec } : { ...spec };
    if (normalized.actions || normalized.input) requirePermission("pet:interact");
    if (normalized.pin) requirePermission("pet:pin");
    if (normalized.dynamic) requirePermission("pet:speak:dynamic");
    const id = newId("bubble");
    const callbacks: { onAction?: (actionId: string) => void | Promise<void>; onSubmit?: (values: Record<string, string | number>) => void | Promise<void>; onDismiss?: (reason: OpenPetsBubbleDismissReason) => void } = {};
    const record: RecordedBubble = {
      spec: normalized,
      petId,
      updates: [],
      pinned: normalized.pin === true,
      dismissed: false,
      handle: {
        id,
        update: async (patch) => { record.updates.push(patch); Object.assign(record.spec, patch); },
        dismiss: async () => { if (!record.dismissed) { record.dismissed = true; calls.dismissedBubbles.push(id); callbacks.onDismiss?.("manual"); } },
        pin: async () => { requirePermission("pet:pin"); record.pinned = true; },
        unpin: async () => { record.pinned = false; },
        onAction: (handler) => { callbacks.onAction = handler; },
        onSubmit: (handler) => { callbacks.onSubmit = handler; },
        onDismiss: (handler) => { callbacks.onDismiss = handler; },
      },
    };
    bubbleCallbacks.set(id, { record, callbacks });
    calls.bubbles.push(record);
    if (normalized.text) calls.speak.push(normalized.text);
    return record.handle;
  };
  const bubbleCallbacks = new Map<string, { record: RecordedBubble; callbacks: { onAction?: (actionId: string) => void | Promise<void>; onSubmit?: (values: Record<string, string | number>) => void | Promise<void>; onDismiss?: (reason: OpenPetsBubbleDismissReason) => void } }>();

  const deliveryCallbacks = new Map<string, { record: RecordedDelivery; onDismiss?: (reason: OpenPetsDeliveryDismissReason) => void }>();
  const makeDelivery = (spec: OpenPetsDelivery): OpenPetsDeliveryHandle => {
    requirePermission("ui:delivery");
    const id = newId("delivery");
    const record: RecordedDelivery = {
      id,
      spec: { ...spec },
      dismissed: false,
      handle: {
        dismiss: async () => dismissDelivery(id, "manual"),
        onDismiss: (handler) => { deliveryCallbacks.get(id)!.onDismiss = handler; },
      },
    };
    deliveryCallbacks.set(id, { record });
    calls.deliveries.push(record);
    return record.handle;
  };
  const dismissDelivery = async (id: string, reason: OpenPetsDeliveryDismissReason): Promise<void> => {
    const entry = deliveryCallbacks.get(id);
    if (!entry || entry.record.dismissed) return;
    entry.record.dismissed = true;
    entry.onDismiss?.(reason);
  };

  const makeAlert = (spec: OpenPetsAlert): OpenPetsAlertHandle => {
    if (spec.sound !== undefined) requirePermission("audio");
    if (spec.notify !== undefined) requirePermission("notify");
    const { sound, notify, indicator, ...bubbleSpec } = spec;
    const bubble = makeBubble("default", {
      ...bubbleSpec,
      ...(indicator === false ? {} : { indicator }),
      sticky: true,
      priority: "high",
    });
    const bubbleRecord = calls.bubbles[calls.bubbles.length - 1]!;
    if (sound !== undefined) calls.sounds.push({ sound });
    if (notify !== undefined) calls.notifications.push({ title: notify.title, body: notify.body });
    const id = newId("alert");
    const record: RecordedAlert = {
      spec: { ...spec, actions: spec.actions?.map((action) => ({ ...action })) },
      bubble: bubbleRecord,
      updates: [],
      dismissed: false,
      acknowledged: false,
      handle: {
        id,
        update: async (patch) => { record.updates.push(patch); Object.assign(record.spec, patch); await bubble.update(patch); },
        dismiss: async () => { if (!record.dismissed) { record.dismissed = true; await bubble.dismiss(); } },
        pin: async () => bubble.pin(),
        unpin: async () => bubble.unpin(),
        onAction: (handler) => { bubble.onAction(handler); },
        onSubmit: (handler) => { bubble.onSubmit(handler); },
        onDismiss: (handler) => { bubble.onDismiss(handler); },
        acknowledge: async () => { record.acknowledged = true; await record.handle.dismiss(); },
      },
    };
    calls.alerts.push(record);
    return record.handle;
  };

  const petInfos: OpenPetsPetInfo[] = [{ id: "default", name: "Default pet", kind: "default", visible: true }];
  const petState: OpenPetsPetState = { position: { x: 100, y: 100 }, bounds: { x: 100, y: 100, width: 220, height: 240 }, currentAnimation: "idle", visible: true, dragging: false };
  const tickHandlers = new Set<(dtMs: number) => void>();

  const makePetHandle = (petId: string): OpenPetsPetHandle => ({
    id: petId,
    speak: async (spec) => makeBubble(petId, spec),
    react: async (reaction: OpenPetsReaction, options) => { requirePermission("pet:reaction"); assertReaction(reaction); const record = { reaction: String(reaction), ...(options === undefined ? {} : { options: { ...options } }) }; calls.react.push(record.reaction); calls.reactions.push(record); },
    setAnimation: async (state) => { if (typeof state === "string") { requirePermission("pet:reaction"); calls.react.push(String(state)); } else { requirePermission("pet:animate"); petState.currentAnimation = `sprite:${state.sprite.name}`; } },
    setScale: async () => { requirePermission("pet:animate"); },
    setStatusReaction: async (reaction) => { requirePermission("pet:reaction"); if (reaction !== null) assertReaction(reaction); calls.statusReactions.push(reaction === null ? null : String(reaction)); },
    moveBy: async () => { requirePermission("pet:move"); },
    wander: async () => { requirePermission("pet:move"); },
    moveToHome: async () => { requirePermission("pet:move"); },
    moveTo: async (point) => { requirePermission("pet:move"); petState.position = { ...point }; },
    followCursor: async () => { requirePermission("pet:move"); },
    physics: async () => { requirePermission("pet:move"); },
    onTick: (handler) => { requirePermission("events"); tickHandlers.add(handler); return () => tickHandlers.delete(handler); },
    getState: async () => { requirePermission("pets:read"); return { ...petState, position: { ...petState.position }, bounds: { ...petState.bounds } }; },
    show: async () => { requirePermission("pets:manage"); },
    hide: async () => { requirePermission("pets:manage"); },
    close: async () => { requirePermission("pets:manage"); },
  });

  const matchNetMock = (url: string) => netMocks.find((mock) => url.startsWith(mock.urlPrefix));

  const ctx: OpenPetsContext = {
    pet: makePetHandle("default"),
    pets: {
      default: makePetHandle("default"),
      list: async () => { requirePermission("pets:read"); return petInfos.map((info) => ({ ...info })); },
      get: (petId) => makePetHandle(petId),
      spawn: async (spec) => { requirePermission("pets:manage"); const id = newId("pet"); calls.spawnedPets.push(spec.petId); petInfos.push({ id, name: spec.name ?? spec.petId, kind: "plugin", visible: true }); return makePetHandle(id); },
      onChange: () => () => undefined,
    },
    ui: {
      bubble: async (spec) => makeBubble("default", spec),
      toast: async (spec) => { requirePermission("ui:toast"); calls.toasts.push({ text: spec.text, tone: spec.tone }); },
      alert: async (spec) => makeAlert(spec),
      panel: async () => {
        requirePermission("ui:panel");
        const id = newId("panel");
        const panel = {
          id,
          show: async () => undefined,
          hide: async () => undefined,
          postMessage: async (msg: unknown) => { calls.panelMessages.push(msg); },
          onMessage: (handler: (msg: unknown) => void) => { panelToPluginHandlers.add(handler); },
          close: async () => undefined,
        };
        panelClosers.add(panel.close);
        return panel;
      },
      delivery: async (spec) => makeDelivery(spec),
      menu: {
        setItems: async (items) => { requirePermission("commands"); calls.menuItems = items.map((item) => ({ ...item })); },
        onSelect: () => () => undefined,
      },
    },
    audio: {
      play: async (sound, options) => { requirePermission("audio"); calls.sounds.push({ sound, volume: options?.volume }); },
      importUserSound: async (file, opts) => {
        requirePermission("audio");
        requirePermission("files");
        const ref: OpenPetsUserSoundRef = { kind: "user-sound", id: newId("sound"), name: opts?.name ?? file.name };
        calls.importedUserSounds.push({ ref, fileName: file.name, name: opts?.name });
        return ref;
      },
      forgetUserSound: async (ref) => { requirePermission("audio"); calls.forgottenUserSounds.push(ref); },
      stop: async () => { requirePermission("audio"); },
    },
    events: {
      on: (event, handler) => {
        requirePermission("events");
        if (event === "pet:drop") requirePermission("pet:drop");
        let subscribers = eventSubscribers.get(event);
        if (!subscribers) { subscribers = new Set(); eventSubscribers.set(event, subscribers); }
        const wrapped: EventHandler = (payload) => (handler as (payload: unknown) => void)(payload);
        subscribers.add(wrapped);
        return () => subscribers!.delete(wrapped);
      },
    },
    assets: {
      icon: (name) => ({ kind: "icon", name }),
      image: (name) => ({ kind: "image", name }),
      svg: (name) => ({ kind: "svg", name }),
      sprite: (name) => ({ kind: "sprite", name }),
      sound: (name) => ({ kind: "sound", name }),
    },
    bus: {
      publish: async (topic, payload) => { requirePermission("bus"); calls.busPublishes.push({ topic, payload }); for (const handler of busSubscribers.get(topic) ?? []) handler(payload); },
      subscribe: (topic, handler) => {
        requirePermission("bus");
        let subscribers = busSubscribers.get(topic);
        if (!subscribers) { subscribers = new Set(); busSubscribers.set(topic, subscribers); }
        subscribers.add(handler);
        return () => subscribers!.delete(handler);
      },
    },
    schedule: {
      once: async (id, delayMs, handler) => { requirePermission("schedule"); calls.schedules.set(id, { type: "once", handler, dueMs: clock.now() + delayMs, intervalMs: delayMs }); },
      every: async (id, intervalMs, handler) => { requirePermission("schedule"); calls.schedules.set(id, { type: "every", handler, dueMs: clock.now() + intervalMs, intervalMs }); },
      daily: async (id, spec, handler) => { requirePermission("schedule"); const daily = typeof spec === "string" ? { time: spec } : spec; calls.schedules.set(id, { type: "daily", handler, daily, dueMs: nextDailyRunMs(daily, clock.now()) }); },
      cron: async (id, expr, handler) => { requirePermission("schedule"); const due = nextCronRunMs(expr, clock.now()); calls.schedules.set(id, { type: "cron", handler, cronExpr: expr, dueMs: due ?? Number.POSITIVE_INFINITY }); },
      at: async (id, isoTimestamp, handler) => { requirePermission("schedule"); const due = Date.parse(isoTimestamp); calls.schedules.set(id, { type: "at", handler, dueMs: Number.isFinite(due) ? Math.max(due, clock.now()) : clock.now() }); },
      list: async () => [...calls.schedules.entries()].map(([id, schedule]) => ({ id, nextRunMs: schedule.dueMs })),
      cancel: async (id) => void calls.schedules.delete(id),
      cancelAll: async () => void calls.schedules.clear(),
    },
    storage: {
      get: async (key) => { requirePermission("storage"); return calls.storage.get(key) as never; },
      set: async (key, value) => { requirePermission("storage"); calls.storage.set(key, value); for (const handler of storageSubscribers.get(key) ?? []) handler(value); },
      delete: async (key) => { requirePermission("storage"); calls.storage.delete(key); for (const handler of storageSubscribers.get(key) ?? []) handler(undefined); },
      keys: async () => { requirePermission("storage"); return [...calls.storage.keys()]; },
      subscribe: (key, handler) => {
        requirePermission("storage");
        let subscribers = storageSubscribers.get(key);
        if (!subscribers) { subscribers = new Set(); storageSubscribers.set(key, subscribers); }
        subscribers.add(handler);
        return () => subscribers!.delete(handler);
      },
    },
    config: {
      get: async <T,>() => ({ ...config }) as T,
      onChange: <T,>(handler: (value: T) => void | Promise<void>) => { configListeners.add(handler as (value: Record<string, unknown>) => void); return () => configListeners.delete(handler as (value: Record<string, unknown>) => void); },
    },
    net: {
      fetch: async (url, options) => {
        requirePermission("network");
        if (options?.method && options.method !== "GET") requirePermission("network:write");
        calls.netCalls.push({ url, method: options?.method ?? "GET", headers: options?.headers, body: options?.body, stream: false });
        const mock = matchNetMock(url);
        if (!mock) throw new Error(`No net mock for ${url} — call harness.net.mock(...) first.`);
        const text = mock.response.text ?? (mock.response.json !== undefined ? JSON.stringify(mock.response.json) : "");
        return { status: mock.response.status ?? 200, ok: (mock.response.status ?? 200) < 400, headers: { "content-type": mock.response.json !== undefined ? "application/json" : "text/plain" }, text, json: mock.response.json };
      },
      stream: async (url, options, onChunk) => {
        requirePermission("network");
        if (options.method && options.method !== "GET") requirePermission("network:write");
        calls.netCalls.push({ url, method: options.method ?? "GET", headers: options.headers, body: options.body, stream: true });
        const mock = matchNetMock(url);
        if (!mock) throw new Error(`No net mock for ${url} — call harness.net.mock(...) first.`);
        for (const chunk of mock.response.chunks ?? [mock.response.text ?? ""]) if (chunk) onChunk(chunk);
        return { status: mock.response.status ?? 200, ok: (mock.response.status ?? 200) < 400 };
      },
    },
    notify: {
      notify: async (spec) => { requirePermission("notify"); calls.notifications.push({ title: spec.title, body: spec.body }); },
    },
    ai: {
      available: async () => { requirePermission("ai"); return aiResponder !== null; },
      complete: async (req) => {
        requirePermission("ai");
        calls.aiCalls.push({ system: req.system, messages: req.messages });
        if (!aiResponder) throw new Error("No AI mock — call harness.ai.mock(...) first.");
        return { text: aiResponder(req) };
      },
      stream: async (req, onToken) => {
        requirePermission("ai");
        calls.aiCalls.push({ system: req.system, messages: req.messages });
        if (!aiResponder) throw new Error("No AI mock — call harness.ai.mock(...) first.");
        const text = aiResponder(req);
        for (const token of text.split(/(?<=\s)/)) onToken(token);
        return { text };
      },
    },
    secrets: {
      set: async (key, value) => { requirePermission("secrets"); calls.secrets.set(key, value); },
      get: async (key) => { requirePermission("secrets"); return calls.secrets.get(key); },
      delete: async (key) => { requirePermission("secrets"); calls.secrets.delete(key); },
      has: async (key) => { requirePermission("secrets"); return calls.secrets.has(key); },
    },
    voice: {
      speak: async (text) => { requirePermission("voice:speak"); calls.voiceSpeaks.push(text); },
      listen: async () => { requirePermission("voice:listen"); if (listenText === null) throw new Error("No listen mock — call harness.voice.mockListen(...) first."); return { text: listenText }; },
    },
    auth: {
      oauth: async () => { requirePermission("auth"); if (!authTokens) throw new Error("No auth mock — call harness.auth.mock(...) first."); return { ...authTokens }; },
      refresh: async () => { requirePermission("auth"); if (!authTokens) throw new Error("No auth mock — call harness.auth.mock(...) first."); return { accessToken: authTokens.accessToken, expiresAt: authTokens.expiresAt }; },
      signOut: async () => { requirePermission("auth"); authTokens = null; },
    },
    files: {
      pick: async () => {
        requirePermission("files");
        return pickableFiles.map((file) => ({
          name: file.name,
          sizeBytes: file.bytes?.byteLength ?? (file.text ? file.text.length : 0),
          readText: async () => file.text ?? new TextDecoder().decode(file.bytes ?? new Uint8Array()),
          readBytes: async () => file.bytes ?? new TextEncoder().encode(file.text ?? ""),
        }));
      },
      save: async (opts) => { requirePermission("files"); calls.savedFiles.push(opts); },
    },
    system: {
      info: async () => ({ ...systemInfo }),
      metrics: async () => { requirePermission("system:metrics"); return { ...systemMetrics }; },
      openExternal: async (url) => { requirePermission("system:openExternal"); if (!url.startsWith("https://")) throw new Error("openExternal requires an HTTPS URL."); calls.openedExternal.push(url); },
      readClipboardText: async () => { requirePermission("clipboard"); return clipboardText; },
      writeClipboardText: async (text) => { requirePermission("clipboard"); clipboardText = text; calls.clipboardWrites.push(text); },
    },
    commands: {
      register: async (command, handler) => { requirePermission("commands"); calls.commands.set(command.id, { meta: command, handler }); },
      unregister: async (id) => void calls.commands.delete(id),
    },
    status: {
      set: async (status) => { requirePermission("status"); calls.status.push(status); },
      clear: async () => { requirePermission("status"); },
    },
    assistant: {
      registerCapability: async (capability, handler) => { calls.assistantCapabilities.set(capability.id, { capability: { ...capability, inputSchema: { ...capability.inputSchema } }, handler }); },
      unregisterCapability: async (id) => { calls.assistantCapabilities.delete(id); },
    },
    http: {
      fetch: async (url, options) => {
        requirePermission("network");
        calls.netCalls.push({ url, method: "GET", headers: options?.headers, stream: false });
        const mock = matchNetMock(url);
        if (!mock) return { status: 200, ok: true, headers: {}, text: "" };
        const text = mock.response.text ?? (mock.response.json !== undefined ? JSON.stringify(mock.response.json) : "");
        return { status: mock.response.status ?? 200, ok: (mock.response.status ?? 200) < 400, headers: {}, text, json: mock.response.json };
      },
    },
    log: {
      debug: async () => undefined,
      info: async () => undefined,
      warn: async () => undefined,
      error: async () => undefined,
    },
    t: (key, vars) => translate(key, vars),
    get locale() { return activeLocale(); },
  };

  const harness: MockHarnessCore = {
    clock,
    emit: async (event, payload) => { for (const handler of eventSubscribers.get(event) ?? []) await Promise.resolve(handler(payload)); },
    fireBubbleAction: async (bubbleId, actionId) => { const entry = bubbleCallbacks.get(bubbleId); if (!entry) throw new Error(`Unknown bubble: ${bubbleId}`); await entry.callbacks.onAction?.(actionId); const action = entry.record.spec.actions?.find((candidate) => candidate.id === actionId); if (action?.dismissesBubble !== false) await entry.record.handle.dismiss(); },
    fireBubbleSubmit: async (bubbleId, values) => { const entry = bubbleCallbacks.get(bubbleId); if (!entry) throw new Error(`Unknown bubble: ${bubbleId}`); await entry.callbacks.onSubmit?.(values); },
    dismissBubble: async (bubbleId, reason = "click") => { const entry = bubbleCallbacks.get(bubbleId); if (!entry || entry.record.dismissed) return; entry.record.dismissed = true; calls.dismissedBubbles.push(bubbleId); entry.callbacks.onDismiss?.(reason); },
    dismissDelivery,
    runCapability: async (id, input) => {
      const capability = calls.assistantCapabilities.get(id);
      if (!capability) throw new Error(`Unknown assistant capability: ${id}`);
      return capability.handler(input);
    },
    runCommand: async (commandId, values) => { const command = calls.commands.get(commandId); if (!command) throw new Error(`Unknown command: ${commandId}`); await command.handler(values); },
    setConfig: async (next) => { config = { ...next }; for (const listener of configListeners) await Promise.resolve(listener({ ...config })); },
    net: { mock: (urlPrefix, response) => { netMocks.unshift({ urlPrefix, response }); } },
    ai: { mock: (responder) => { aiResponder = responder; } },
    files: { provide: (files) => { pickableFiles = files; } },
    auth: { mock: (tokens) => { authTokens = tokens; } },
    voice: { mockListen: (text) => { listenText = text; } },
    system: {
      set: (info) => { systemInfo = { ...systemInfo, ...info }; },
      setMetrics: (metrics) => { systemMetrics = metrics; },
      setClipboard: (text) => { clipboardText = text; },
    },
    panel: { sendToPlugin: (msg) => { for (const handler of panelToPluginHandlers) handler(msg); } },
  };

  const cleanup = async (): Promise<void> => {
    calls.schedules.clear();
    calls.commands.clear();
    calls.assistantCapabilities.clear();
    for (const entry of bubbleCallbacks.values()) {
      try { await entry.record.handle.dismiss(); } catch {}
    }
    for (const entry of deliveryCallbacks.values()) {
      try { await dismissDelivery(entry.record.id, "plugin-stopped"); } catch {}
    }
    for (const close of panelClosers) {
      try { await close(); } catch {}
    }
    eventSubscribers.clear();
    storageSubscribers.clear();
    busSubscribers.clear();
    configListeners.clear();
    panelToPluginHandlers.clear();
    tickHandlers.clear();
    bubbleCallbacks.clear();
    deliveryCallbacks.clear();
    panelClosers.clear();
  };

  return { ctx, calls, harness, cleanup };
}

function isMockOptions(value: MockContextOptions | Record<string, unknown>): value is MockContextOptions {
  return "permissions" in value || "config" in value || "nowMs" in value || "locales" in value;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

export interface TestHarness extends MockHarnessCore {
  ctx: OpenPetsContext;
  calls: MockCalls;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Drive every registered onTick handler once with the given dt. */
  tick(dtMs: number): Promise<void>;
  expectSpoke(matcher: string | RegExp): void;
  expectReacted(reaction: string): void;
  expectScheduled(id: string): void;
  expectBubble(matcher: Partial<OpenPetsBubble> & { textMatch?: RegExp }): void;
  expectStored(key: string, predicate?: (value: unknown) => boolean): void;
  expectNetCall(urlSubstring: string): void;
  expectNotified(matcher: string | RegExp): void;
  expectNoErrors(): void;
}

/**
 * Build a batteries-included harness around a plugin definition or an exported
 * `register(OpenPetsPlugin)` entry function.
 */
export function createTestHarness(
  plugin: OpenPetsPluginDefinition | OpenPetsPluginEntry,
  options: MockContextOptions = {},
): TestHarness {
  const { ctx, calls, harness, cleanup } = createMockContext(options);
  let definition: OpenPetsPluginDefinition | null = typeof plugin === "function" ? null : plugin;
  const entry: OpenPetsPluginEntry | null = typeof plugin === "function" ? plugin : null;

  const fail = (message: string): never => { throw new Error(message); };

  return {
    ...harness,
    ctx,
    calls,
    async start() {
      if (entry) {
        const api: OpenPetsPluginApi = { register: (registered) => { definition = registered; } };
        await entry(api);
        if (!definition) fail("Plugin entry never called OpenPetsPlugin.register().");
      }
      await definition!.start(ctx);
    },
    async stop() {
      try {
        await definition?.stop?.();
      } finally {
        await cleanup();
      }
    },
    async tick(dtMs: number) {
      // The mock pet handle records tick handlers internally; route through emit-like dispatch.
      await harness.emit("pet:hover" as OpenPetsEventName, { petId: "default", __tickDtMs: dtMs });
    },
    expectSpoke(matcher) {
      const found = calls.speak.some((message) => (typeof matcher === "string" ? message.includes(matcher) : matcher.test(message)));
      if (!found) fail(`Expected pet speech matching ${String(matcher)}; got ${JSON.stringify(calls.speak)}`);
    },
    expectReacted(reaction) {
      if (!calls.react.includes(reaction)) fail(`Expected reaction "${reaction}"; got ${JSON.stringify(calls.react)}`);
    },
    expectScheduled(id) {
      if (!calls.schedules.has(id)) fail(`Expected schedule "${id}"; got ${JSON.stringify([...calls.schedules.keys()])}`);
    },
    expectBubble(matcher) {
      const { textMatch, ...rest } = matcher;
      const found = calls.bubbles.some((bubble) => {
        if (textMatch && !(bubble.spec.text && textMatch.test(bubble.spec.text))) return false;
        return Object.entries(rest).every(([key, value]) => JSON.stringify((bubble.spec as Record<string, unknown>)[key]) === JSON.stringify(value));
      });
      if (!found) fail(`Expected a bubble matching ${JSON.stringify(matcher)}; got ${JSON.stringify(calls.bubbles.map((bubble) => bubble.spec))}`);
    },
    expectStored(key, predicate) {
      if (!calls.storage.has(key)) fail(`Expected storage key "${key}"; got ${JSON.stringify([...calls.storage.keys()])}`);
      if (predicate && !predicate(calls.storage.get(key))) fail(`Storage value for "${key}" failed the predicate: ${JSON.stringify(calls.storage.get(key))}`);
    },
    expectNetCall(urlSubstring) {
      if (!calls.netCalls.some((call) => call.url.includes(urlSubstring))) fail(`Expected a network call containing "${urlSubstring}"; got ${JSON.stringify(calls.netCalls.map((call) => call.url))}`);
    },
    expectNotified(matcher) {
      const found = calls.notifications.some((notification) => (typeof matcher === "string" ? notification.title.includes(matcher) || (notification.body ?? "").includes(matcher) : matcher.test(notification.title) || matcher.test(notification.body ?? "")));
      if (!found) fail(`Expected a notification matching ${String(matcher)}; got ${JSON.stringify(calls.notifications)}`);
    },
    expectNoErrors() {
      if (calls.errors.length > 0) fail(`Expected no schedule/handler errors; got ${JSON.stringify(calls.errors)}`);
    },
  };
}
