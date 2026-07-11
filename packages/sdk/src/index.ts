/**
 * Type definitions for OpenPets plugins — SDK v3 ("SuperPlugins").
 *
 * This package ships **types only**. There is no runtime to import — the
 * OpenPets desktop app injects the `OpenPetsPlugin` global into the plugin
 * sandbox and passes your `start(ctx)` handler an {@link OpenPetsContext}.
 *
 * In a plain JavaScript plugin, reference these types for editor IntelliSense:
 *
 * ```js
 * /// <reference types="@open-pets/plugin-sdk" />
 *
 * OpenPetsPlugin.register({
 *   async start(ctx) {
 *     const bubble = await ctx.ui.bubble({ text: "Hello!", sticky: true })
 *     bubble.onAction(() => bubble.dismiss())
 *   },
 * })
 * ```
 *
 * SDK v3 reframes a pet as a programmable surface: the API is organized into
 * subsystems (`ui`, `pets`, `events`, `audio`, `ai`, …) instead of one flat
 * `ctx.pet` namespace. The v2 surface (`ctx.pet.speak`, `ctx.http.fetch`, …)
 * keeps working unchanged.
 *
 * @packageDocumentation
 */

/** Capabilities a plugin can request in its manifest's `permissions` array. */
export type OpenPetsPermission =
  // v2 permissions (unchanged)
  | "pet:speak"
  | "pet:reaction"
  | "pet:move"
  | "schedule"
  | "storage"
  | "status"
  | "commands"
  | "network"
  // v3 permissions
  | "pet:interact"
  | "pet:pin"
  | "pet:animate"
  | "pet:speak:dynamic"
  | "pet:drop"
  | "pets:read"
  | "pets:manage"
  | "audio"
  | "events"
  | "ui:toast"
  | "ui:panel"
  | "ui:delivery"
  | "notify"
  | "bus"
  | "ai"
  | "secrets"
  | "voice:speak"
  | "voice:listen"
  | "auth"
  | "files"
  | "system:openExternal"
  | "system:metrics"
  | "clipboard"
  | "network:write";

/**
 * Reaction name passed to {@link OpenPetsPetHandle.react}. Common values are
 * listed for autocomplete; any string the host accepts is allowed.
 */
export type OpenPetsReaction =
  | "idle"
  | "thinking"
  | "working"
  | "editing"
  | "running"
  | "testing"
  | "waiting"
  | "waving"
  | "success"
  | "error"
  | "celebrating"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/** Tone shown alongside a plugin's status line or bubble. */
export type OpenPetsStatusTone = "info" | "success" | "warning" | "error";

/** A status line, either a bare string or text plus a {@link OpenPetsStatusTone}. */
export type OpenPetsStatus = string | { text: string; tone?: OpenPetsStatusTone };

/** A point in screen coordinates. */
export interface OpenPetsPoint {
  x: number;
  y: number;
}

/** A rectangle in screen coordinates. */
export interface OpenPetsRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Assets (§6)
// ---------------------------------------------------------------------------

/**
 * An opaque reference to an asset bundled with the plugin and declared in the
 * manifest's `assets` block. Obtained from {@link OpenPetsAssetsApi}; never
 * constructed by hand. Plugins pass references, never raw bytes or markup.
 */
export interface OpenPetsAssetRef {
  readonly kind: "icon" | "image" | "svg" | "sprite" | "sound";
  readonly name: string;
}

/** A named host icon (curated set) or a bundled icon asset reference. */
export type OpenPetsIconRef = string | OpenPetsAssetRef;

/** A JSON-safe reference to a user-imported sound. */
export interface OpenPetsUserSoundRef {
  readonly kind: "user-sound";
  readonly id: string;
  readonly name?: string;
}

/** A named host sound, bundled sound asset, or user-imported sound reference. */
export type OpenPetsSoundRef = string | OpenPetsAssetRef | OpenPetsUserSoundRef;

/** Resolve manifest-declared assets to opaque references. */
export interface OpenPetsAssetsApi {
  /** Resolve a manifest-declared icon. */
  icon(name: string): OpenPetsAssetRef;
  /** Resolve a manifest-declared raster image. */
  image(name: string): OpenPetsAssetRef;
  /** Resolve a manifest-declared, install-time-sanitized SVG. */
  svg(name: string): OpenPetsAssetRef;
  /** Resolve a manifest-declared spritesheet. */
  sprite(name: string): OpenPetsAssetRef;
  /** Resolve a manifest-declared sound. */
  sound(name: string): OpenPetsAssetRef;
}

// ---------------------------------------------------------------------------
// Rich bubbles (§1)
// ---------------------------------------------------------------------------

/** A button rendered inside a bubble. Requires `pet:interact`. */
export interface OpenPetsBubbleAction {
  /** Short, stable id (`[A-Za-z0-9._:-]`, 1–64 chars). */
  id: string;
  label: string;
  style?: "default" | "primary" | "danger";
  icon?: OpenPetsIconRef;
  /** Dismiss the bubble when this action fires. Default true. */
  dismissesBubble?: boolean;
}

/** An inline input rendered inside a bubble. Requires `pet:interact`. */
export interface OpenPetsBubbleInput {
  id: string;
  type: "text" | "number" | "select";
  placeholder?: string;
  default?: string | number;
  /** Options for `select` inputs. */
  options?: Array<{ value: string; label: string }>;
  submitLabel?: string;
}

/** A HUD item shown in the host-rendered pinned mini-HUD bubble. */
export interface OpenPetsBubbleHudItem {
  /** Named host icon or bundled icon asset reference. */
  icon: OpenPetsIconRef;
  /** Numeric value between 0 and 100 inclusive. */
  value: number;
  /** Optional short display label. */
  label?: string;
  /** Optional theme color tone for the bar/indicator. */
  tone?: "amber" | "blue" | "green" | "pink" | "slate" | "red";
}

/** Descriptor for a host-rendered mini HUD layout, used in pinned bubbles. */
export interface OpenPetsBubbleHud {
  /** List of HUD items (usually up to 4 items). */
  items: OpenPetsBubbleHudItem[];
}

/**
 * A structured, host-rendered bubble descriptor. The plugin describes; the
 * host renders — no raw HTML or live DOM ever crosses the SDK boundary.
 */
export interface OpenPetsBubble {
  // --- content ---
  /** Host-rendered mini HUD layout for pinned bubbles. */
  hud?: OpenPetsBubbleHud;
  /** Plain text, length-capped, content-filtered. */
  text?: string;
  /** Limited markdown (bold/italic/code/line breaks), host-sanitized. */
  markdown?: string;
  /** Named host icon or a bundled icon asset. Body media is icon-only; use `indicator` for icon + message. */
  icon?: OpenPetsIconRef;
  /** Bundled, install-time-sanitized SVG. Body media is icon-only; use `indicator` for icon + message. */
  svg?: OpenPetsAssetRef;
  /** Bundled raster image. Body media is icon-only; use `indicator` for icon + message. */
  image?: OpenPetsAssetRef;
  tone?: OpenPetsStatusTone;
  /** Optional top-row indicator/header. Intended primarily for alerts. */
  indicator?: OpenPetsAlertIndicator | false;
  /** Theme-token name, not a raw color string. */
  accent?: string;
  /**
   * Marks content as model-generated. Requires `pet:speak:dynamic` and the
   * global "allow AI speech" setting; uses the relaxed dynamic screen instead
   * of the static ambient filter (§13.1).
   */
  dynamic?: boolean;

  // --- lifetime ---
  /** Auto-dismiss after N ms; omit for the host default. */
  durationMs?: number;
  /** Ignore duration; stay until dismissed or replaced. */
  sticky?: boolean;
  /** Occupy the persistent pinned slot (max 1 per pet). Requires `pet:pin`. */
  pin?: boolean;
  dismissOn?: Array<"timeout" | "click" | "petClick" | "action" | "outsideClick">;
  /** Feeds the bubble arbiter. Default "normal". */
  priority?: "low" | "normal" | "high" | "urgent";

  // --- interaction ---
  actions?: OpenPetsBubbleAction[];
  input?: OpenPetsBubbleInput;
}

/** Why a bubble went away. */
export type OpenPetsBubbleDismissReason = "timeout" | "click" | "replaced" | "manual" | "unpinned";

/**
 * Live handle to a shown bubble. Lets the plugin update it in place
 * (progress, countdowns, streamed tokens) and receive interaction callbacks.
 */
export interface OpenPetsBubbleHandle {
  readonly id: string;
  update(patch: Partial<OpenPetsBubble>): Promise<void>;
  dismiss(): Promise<void>;
  /** Promote this bubble to the pinned slot (§1.5). Requires `pet:pin`. */
  pin(): Promise<void>;
  /** Release the pinned slot. */
  unpin(): Promise<void>;
  onAction(handler: (actionId: string) => void | Promise<void>): void;
  onSubmit(handler: (values: Record<string, string | number>) => void | Promise<void>): void;
  onDismiss(handler: (reason: OpenPetsBubbleDismissReason) => void): void;
}

// ---------------------------------------------------------------------------
// UI surfaces beyond the bubble (§7)
// ---------------------------------------------------------------------------

/** Options for opening a sandboxed plugin panel (§7.2). Requires `ui:panel`. */
export interface OpenPetsPanelOptions {
  /** Name of a manifest-declared panel page (`panels` block). */
  panel: string;
  title?: string;
  width?: number;
  height?: number;
}

/** Handle to a sandboxed plugin panel window. */
export interface OpenPetsPanelHandle {
  readonly id: string;
  show(): Promise<void>;
  hide(): Promise<void>;
  /** Host -> panel. Payload must be clone-safe data. */
  postMessage(msg: unknown): Promise<void>;
  /** Panel -> plugin, clone-safe. */
  onMessage(handler: (msg: unknown) => void): void;
  close(): Promise<void>;
}

/** Descriptor for a host-owned, display-level delivery surface. Requires `ui:delivery`. */
export interface OpenPetsDelivery {
  /** Stable, plugin-scoped id (`[A-Za-z0-9._:-]`, 1–96 chars). */
  key: string;
  /** A manifest-declared courier spritesheet (`ctx.assets.sprite(name)`). */
  courier: OpenPetsAssetRef;
  /** Plain-text title (1–160 characters). */
  title: string;
  /** Optional plain-text detail (0–200 characters). */
  detail: string;
  /** Finite epoch milliseconds, in the next seven days. */
  expiresAt: number;
}

export type OpenPetsDeliveryDismissReason = "click" | "manual" | "expired" | "plugin-stopped";

/** Opaque handle for a host-owned delivery surface. */
export interface OpenPetsDeliveryHandle {
  dismiss(): Promise<void>;
  onDismiss(handler: (reason: OpenPetsDeliveryDismissReason) => void): void;
}

/** Alert header indicator rendered above alert text. Custom art must be a manifest-declared asset. */
export interface OpenPetsAlertIndicator {
  /** Visible/accessibility label shown next to the icon. */
  label?: string;
  /** Named host icon or manifest-declared icon asset (`ctx.assets.icon(...)`). */
  icon?: OpenPetsIconRef;
  /** Manifest-declared sanitized SVG asset (`ctx.assets.svg(...)`). */
  svg?: OpenPetsAssetRef;
  /** Manifest-declared raster/icon image asset. */
  image?: OpenPetsAssetRef;
  tone?: OpenPetsStatusTone;
  /** Safe CSS color for the icon/SVG (`#hex`, `rgb(a)`, or `hsl(a)`). */
  color?: string;
  /** Safe CSS background color for the circular icon well. */
  background?: string;
  /** Alias for `background`. */
  backgroundColor?: string;
  /** Safe CSS border color for the circular icon well. */
  borderColor?: string;
}

/**
 * Must-not-miss pet alert. Alerts render as sticky high-priority bubbles and
 * may also request best-effort sound and OS notification delivery.
 */
export interface OpenPetsAlert extends Omit<OpenPetsBubble, "sticky" | "priority"> {
  /** Optional sound to play with the alert. Requires `audio` only when set. */
  sound?: OpenPetsSoundRef;
  /** Optional OS notification. Requires `notify` only when set. */
  notify?: { title: string; body?: string; sound?: boolean };
}

/** Handle to a live alert bubble. */
export interface OpenPetsAlertHandle extends OpenPetsBubbleHandle {
  /** Mark the alert acknowledged and dismiss it. */
  acknowledge(): Promise<void>;
}

/** Bubbles, toasts, panels, and the dynamic context-menu section. */
export interface OpenPetsUiApi {
  /** Show a bubble on the default pet. Requires `pet:speak`. */
  bubble(spec: string | OpenPetsBubble): Promise<OpenPetsBubbleHandle>;
  /** Show a transient host toast. Requires `ui:toast`. */
  toast(spec: { text: string; tone?: OpenPetsStatusTone; durationMs?: number }): Promise<void>;
  /** Show a sticky high-priority alert bubble. Requires `pet:speak`. */
  alert(spec: OpenPetsAlert): Promise<OpenPetsAlertHandle>;
  /** Open a sandboxed plugin webview panel. Requires `ui:panel`. */
  panel(spec: OpenPetsPanelOptions): Promise<OpenPetsPanelHandle>;
  /** Show a host-owned delivery surface on the cursor display. Requires `ui:delivery`. */
  delivery(spec: OpenPetsDelivery): Promise<OpenPetsDeliveryHandle>;
  /** Fully dynamic context-menu section. Requires `commands`. */
  menu: OpenPetsMenuApi;
}

/** OS notifications. Requires `notify`. */
export interface OpenPetsNotifyApi {
  notify(spec: { title: string; body?: string; sound?: boolean }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Audio (§2)
// ---------------------------------------------------------------------------

/** Play named host sounds or bundled plugin sounds. Requires `audio`. */
export interface OpenPetsAudioApi {
  /**
   * Play a sound. Named host sounds (`"chime"`, `"pop"`, `"nom"`, `"alert"`,
   * `"level-up"`) need no assets; bundled sounds come from
   * {@link OpenPetsAssetsApi.sound}. Gated by the global sound toggle and
   * quiet hours.
   */
  play(sound: OpenPetsSoundRef, options?: { volume?: number }): Promise<void>;
  /** Import a user-picked sound into plugin-owned host storage. Requires `audio` and `files`. */
  importUserSound(file: OpenPetsPickedFile, opts?: { name?: string }): Promise<OpenPetsUserSoundRef>;
  /** Forget a previously imported user sound. Requires `audio`. */
  forgetUserSound(ref: OpenPetsUserSoundRef): Promise<void>;
  stop(handle?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// The senses bus (§3)
// ---------------------------------------------------------------------------

/** Curated, read-only host event names. */
export type OpenPetsEventName =
  | "pet:clicked"
  | "pet:doubleClicked"
  | "pet:dragStart"
  | "pet:dragEnd"
  | "pet:hover"
  | "pet:drop"
  | "idle:enter"
  | "idle:exit"
  | "agent:activity"
  | "config:changed"
  | "screen:locked"
  | "screen:unlocked"
  | "power:battery-low"
  | "power:charging"
  | "display:changed"
  | "online"
  | "offline"
  | "day:partChanged";

/** A file delivered by an explicit user drop onto the pet (§13.7). */
export interface OpenPetsDroppedFile {
  name: string;
  sizeBytes: number;
  /** One-shot, size-capped read of the dropped file's text content. */
  readText(): Promise<string>;
}

/** Payload for `pet:drop`. */
export interface OpenPetsDropEvent {
  kind: "text" | "files";
  text?: string;
  files?: OpenPetsDroppedFile[];
  petId: string;
}

/** Payload shapes per event. Unlisted events carry a small data record. */
export interface OpenPetsEventPayloads {
  "pet:clicked": { petId: string };
  "pet:doubleClicked": { petId: string };
  "pet:dragStart": { petId: string };
  "pet:dragEnd": { petId: string };
  "pet:hover": { petId: string };
  "pet:drop": OpenPetsDropEvent;
  "idle:enter": { idleSeconds: number };
  "idle:exit": { idleSeconds: number };
  "agent:activity": { kind: string; reaction?: string; active: boolean; petId: string };
  "config:changed": Record<string, unknown>;
  "screen:locked": Record<string, never>;
  "screen:unlocked": Record<string, never>;
  "power:battery-low": { percent?: number };
  "power:charging": { charging: boolean };
  "display:changed": { displays: number };
  online: Record<string, never>;
  offline: Record<string, never>;
  "day:partChanged": { part: "morning" | "afternoon" | "evening" | "night" };
}

export type OpenPetsEvent<E extends OpenPetsEventName> = OpenPetsEventPayloads[E];

/**
 * Subscribe to the curated host event stream. Requires `events`
 * (`pet:drop` additionally requires `pet:drop`).
 *
 * The event set is explicitly bounded: no keystrokes, no screen contents, no
 * other apps' window titles, no clipboard, no ambient filesystem watching.
 */
export interface OpenPetsEventsApi {
  on<E extends OpenPetsEventName>(event: E, handler: (e: OpenPetsEvent<E>) => void): () => void;
}

// ---------------------------------------------------------------------------
// Multi-pet & liveness (§4, §5, §13.6)
// ---------------------------------------------------------------------------

/** Options for {@link OpenPetsPetHandle.moveBy}. */
export interface OpenPetsMoveByOptions {
  x: number;
  y: number;
  durationMs?: number;
}

/** Options for {@link OpenPetsPetHandle.wander}. */
export interface OpenPetsWanderOptions {
  distance?: number;
  durationMs?: number;
}

/** Beyond named reactions: a bundled spritesheet animation (§5). */
export type OpenPetsAnimationState =
  | OpenPetsReaction
  | { sprite: OpenPetsAssetRef; loop?: boolean; fps?: number };

/** Self-perception snapshot returned by {@link OpenPetsPetHandle.getState}. */
export interface OpenPetsPetState {
  position: OpenPetsPoint;
  bounds: OpenPetsRect;
  currentAnimation: string;
  visible: boolean;
  dragging: boolean;
}

export interface OpenPetsPetInfo {
  id: string;
  name: string;
  kind: "default" | "agent" | "plugin";
  visible: boolean;
}

export interface OpenPetsReactOptions {
  /** Set false to animate without showing the built-in reaction/status message. */
  showMessage?: boolean;
}

/** Addressable handle to a single pet. */
export interface OpenPetsPetHandle {
  readonly id: string;
  /** Requires `pet:speak`. Accepts plain text or a full bubble descriptor. */
  speak(spec: string | OpenPetsBubble): Promise<OpenPetsBubbleHandle>;
  /** Requires `pet:reaction`. */
  react(reaction: OpenPetsReaction, options?: OpenPetsReactOptions): Promise<void>;
  /** Requires `pet:animate` for sprite states; named reactions need `pet:reaction`. */
  setAnimation(state: OpenPetsAnimationState): Promise<void>;
  /** Bounded by the host (0.5–2). Requires `pet:animate`. */
  setScale(scale: number): Promise<void>;
  /** Show a status reaction (or clear with null). Requires `pet:reaction`. */
  setStatusReaction(reaction: OpenPetsReaction | null): Promise<void>;
  /** Requires `pet:move`. Movement is bounded to the work area. */
  moveBy(options: OpenPetsMoveByOptions): Promise<void>;
  /** Requires `pet:move`. */
  wander(options?: OpenPetsWanderOptions): Promise<void>;
  /** Requires `pet:move`. */
  moveToHome(): Promise<void>;
  /** Animated absolute move. Requires `pet:move`. */
  moveTo(point: OpenPetsPoint, opts?: { durationMs?: number; easing?: string }): Promise<void>;
  /** Continuous cursor following with lag. Requires `pet:move`. */
  followCursor(opts?: { enabled: boolean; lag?: number }): Promise<void>;
  /** Lightweight physics (gravity/bounce). Requires `pet:move`. */
  physics(opts?: { gravity?: boolean; bounce?: number; climbEdges?: boolean }): Promise<void>;
  /**
   * Continuous behavior loop — host-driven, throttled, auto-paused while the
   * pet is hidden or being dragged. The brain loop for "alive" pets.
   * Requires `events`. Returns an unsubscribe function.
   */
  onTick(handler: (dtMs: number) => void): () => void;
  /** Self-perception. Requires `pets:read`. */
  getState(): Promise<OpenPetsPetState>;
  /** Requires `pets:manage`. */
  show(): Promise<void>;
  /** Requires `pets:manage`. */
  hide(): Promise<void>;
  /** Close an ephemeral/spawned pet. Requires `pets:manage`. */
  close(): Promise<void>;
}

/** Multi-pet registry: list, target, spawn. */
export interface OpenPetsPetsApi {
  readonly default: OpenPetsPetHandle;
  /** Requires `pets:read`. */
  list(): Promise<OpenPetsPetInfo[]>;
  get(petId: string): OpenPetsPetHandle;
  /** Spawn an ephemeral pet window. Requires `pets:manage`. */
  spawn(spec: {
    petId: string;
    name?: string;
    position?: OpenPetsPoint;
    ephemeral?: boolean;
  }): Promise<OpenPetsPetHandle>;
  /** Requires `pets:read`. Returns an unsubscribe function. */
  onChange(handler: (pets: OpenPetsPetInfo[]) => void): () => void;
}

// ---------------------------------------------------------------------------
// Commands & menus (§8)
// ---------------------------------------------------------------------------

/** A single field in a command's input form (extended in v3, §8.1). */
export interface OpenPetsCommandFormField {
  /** Identifier for this field; the submitted value is keyed by it. */
  id: string;
  type:
    | "text"
    | "textarea"
    | "number"
    | "boolean"
    | "select"
    | "multiselect"
    | "time"
    | "date"
    | "list";
  label: string;
  default?: string | number | boolean | string[];
  options?: Array<{ label: string; value: string }>;
  /** Minimum value (number fields only). */
  min?: number;
  /** Maximum value (number fields only). */
  max?: number;
  /** Maximum length (text/textarea fields only). */
  maxLength?: number;
  required?: boolean;
}

/** Optional input form attached to a command. */
export interface OpenPetsCommandForm {
  fields: OpenPetsCommandFormField[];
  submitLabel?: string;
}

/** A right-click pet action registered via {@link OpenPetsCommandsApi.register}. */
export interface OpenPetsCommand {
  /** Short, stable id (`[A-Za-z0-9._:-]`, 1–64 chars). */
  id: string;
  title: string;
  description?: string;
  icon?: OpenPetsIconRef;
  /** When present, the host opens a dialog and passes validated values to the handler. */
  form?: OpenPetsCommandForm;
  /** Top-level item vs grouped plugin submenu. Default "submenu". */
  placement?: "top" | "submenu";
  /** Ordering within its group (higher first). */
  priority?: number;
  featured?: boolean;
  /** Maximum time the host waits for this command (1 second to 5 minutes). Defaults to 5 seconds. */
  timeoutMs?: number;
}

/** A dynamic context-menu item set via {@link OpenPetsMenuApi.setItems}. */
export interface OpenPetsMenuItem {
  id: string;
  title: string;
  enabled?: boolean;
  checked?: boolean;
}

/** Fully dynamic context-menu section. Requires `commands`. */
export interface OpenPetsMenuApi {
  setItems(items: OpenPetsMenuItem[]): Promise<void>;
  onSelect(handler: (id: string) => void | Promise<void>): () => void;
}

/** Handler invoked when a command runs, with validated form values when present. */
export type OpenPetsCommandHandler = (values?: Record<string, unknown>) => void | Promise<void>;

/** Register right-click pet actions. Requires `commands`. */
export interface OpenPetsCommandsApi {
  register(command: OpenPetsCommand, handler: OpenPetsCommandHandler): Promise<void>;
  unregister(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Scheduling (§9)
// ---------------------------------------------------------------------------

/** A daily schedule time, optionally restricted to specific weekdays. */
export type OpenPetsDailySpec = string | { time: string; days?: number[] };

/** A callback fired by a schedule. */
export type OpenPetsScheduleHandler = () => void | Promise<void>;

/**
 * Run callbacks once, on an interval, daily, on a cron expression, or at an
 * absolute time. Wall-clock aware: schedules re-arm after sleep/wake.
 * Requires `schedule`.
 */
export interface OpenPetsScheduleApi {
  /** Fire once after `delayMs`. */
  once(id: string, delayMs: number, handler: OpenPetsScheduleHandler): Promise<void>;
  /** Fire repeatedly every `intervalMs` (a minimum interval is enforced). */
  every(id: string, intervalMs: number, handler: OpenPetsScheduleHandler): Promise<void>;
  /** Fire daily at `HH:mm`, optionally only on the given weekdays (0–6, Sunday = 0). */
  daily(id: string, spec: OpenPetsDailySpec, handler: OpenPetsScheduleHandler): Promise<void>;
  /** Fire on a 5-field cron expression (`m h dom mon dow`). */
  cron(id: string, expr: string, handler: OpenPetsScheduleHandler): Promise<void>;
  /** Fire once at an absolute ISO-8601 timestamp. Past timestamps fire immediately. */
  at(id: string, isoTimestamp: string, handler: OpenPetsScheduleHandler): Promise<void>;
  list(): Promise<Array<{ id: string; nextRunMs: number }>>;
  cancel(id: string): Promise<void>;
  cancelAll(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Storage (§10)
// ---------------------------------------------------------------------------

/** Persist per-plugin state across restarts (quota: a few MB). Requires `storage`. */
export interface OpenPetsStorageApi {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  /** Reactive subscription to a key. Returns an unsubscribe function. */
  subscribe(key: string, handler: (value: unknown) => void): () => void;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Read user configuration and react to changes. Always available. */
export interface OpenPetsConfigApi {
  get<T = Record<string, unknown>>(): Promise<T>;
  /** Subscribe to config changes. Returns an unsubscribe function. */
  onChange<T = Record<string, unknown>>(handler: (config: T) => void | Promise<void>): () => void;
}

// ---------------------------------------------------------------------------
// Inter-plugin bus (§11)
// ---------------------------------------------------------------------------

/** Inter-plugin pub/sub. Topics should be namespaced `pluginId/topic`. Requires `bus`. */
export interface OpenPetsBusApi {
  /** Publish a clone-safe payload. Rate- and size-capped by the host. */
  publish(topic: string, payload: unknown): Promise<void>;
  subscribe(topic: string, handler: (payload: unknown) => void): () => void;
}

// ---------------------------------------------------------------------------
// Network (§12, §13.4)
// ---------------------------------------------------------------------------

/** Options for {@link OpenPetsNetApi.fetch}. Non-GET methods require `network:write`. */
export interface OpenPetsNetFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** Response returned by {@link OpenPetsNetApi.fetch}. */
export interface OpenPetsHttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text: string;
  json?: unknown;
}

/**
 * HTTPS fetch to manifest-declared, user-approved hosts. Requires `network`.
 * HTTPS-only with redirect, response-size, and private-IP/SSRF guards.
 */
export interface OpenPetsNetApi {
  fetch(url: string, options?: OpenPetsNetFetchOptions): Promise<OpenPetsHttpResponse>;
  /** Streaming fetch (SSE/chunked) for LLM-style responses. */
  stream(
    url: string,
    options: OpenPetsNetFetchOptions,
    onChunk: (chunk: string) => void,
  ): Promise<{ status: number; ok: boolean }>;
}

/** v2 GET-only fetch options, kept for back-compat (`ctx.http`). */
export interface OpenPetsHttpOptions {
  method?: "GET";
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** v2 HTTP namespace, kept for back-compat. Requires `network`. */
export interface OpenPetsHttpApi {
  fetch(url: string, options?: OpenPetsHttpOptions): Promise<OpenPetsHttpResponse>;
}

// ---------------------------------------------------------------------------
// AI gateway (§13.2)
// ---------------------------------------------------------------------------

/** A tool the model may call (host AI gateway function calling). */
export interface OpenPetsAiTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

/** A tool call requested by the model. */
export interface OpenPetsAiToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** Request for {@link OpenPetsAiApi.complete} / {@link OpenPetsAiApi.stream}. */
export interface OpenPetsAiRequest {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
  tools?: OpenPetsAiTool[];
}

/**
 * Host AI gateway backed by the user's one configured provider/model.
 * Keys live in host config, never in plugin code. Requires `ai`.
 */
export interface OpenPetsAiApi {
  /** Whether a provider is configured. */
  available(): Promise<boolean>;
  complete(req: OpenPetsAiRequest): Promise<{ text: string; toolCalls?: OpenPetsAiToolCall[] }>;
  stream(req: OpenPetsAiRequest, onToken: (chunk: string) => void): Promise<{ text: string }>;
}

// ---------------------------------------------------------------------------
// Secrets (§13.3)
// ---------------------------------------------------------------------------

/** Encrypted per-plugin credentials (OS keychain / safeStorage). Requires `secrets`. */
export interface OpenPetsSecretsApi {
  set(key: string, value: string): Promise<void>;
  /** Returned only to the owning plugin. */
  get(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Voice (§13.5)
// ---------------------------------------------------------------------------

/** TTS out (`voice:speak`) and opt-in, push-to-talk STT in (`voice:listen`). */
export interface OpenPetsVoiceApi {
  speak(text: string, opts?: { voice?: string; rate?: number }): Promise<void>;
  /**
   * One-shot speech-to-text. Off by default, never ambient, clearly
   * indicated. Requires `voice:listen` (sensitive) and a configured
   * transcription-capable AI provider.
   */
  listen(opts?: { timeoutMs?: number }): Promise<{ text: string }>;
}

// ---------------------------------------------------------------------------
// Auth (§14.1)
// ---------------------------------------------------------------------------

/** Host-mediated OAuth configuration for the host-approved provider registry. */
export interface OpenPetsOauthConfig {
  provider: "google" | "spotify";
  clientId: string;
  /** Optional installed-app credential secret required by the provider token endpoint. */
  clientSecret?: string;
  scopes: string[];
}

/** Tokens returned by the host after running the OAuth dance. */
export interface OpenPetsOauthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/** Stable OAuth error codes returned by host-managed providers. */
export type OpenPetsOauthErrorCode = "invalid_grant";

/** OAuth errors may expose this code for reconnect-required handling. */
export interface OpenPetsOauthError extends Error {
  readonly code: OpenPetsOauthErrorCode;
}

/** Host-mediated OAuth: the host opens the system browser and runs PKCE. Requires `auth`. */
export interface OpenPetsAuthApi {
  oauth(config: OpenPetsOauthConfig): Promise<OpenPetsOauthTokens>;
  refresh(provider: string): Promise<{ accessToken: string; expiresAt?: number }>;
  signOut(provider: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Files (§14.2)
// ---------------------------------------------------------------------------

/** A user-picked file. Reads are size-capped; no plugin-chosen paths. */
export interface OpenPetsPickedFile {
  name: string;
  sizeBytes: number;
  readText(): Promise<string>;
  readBytes(): Promise<Uint8Array>;
}

/** User-initiated file access behind OS dialogs. Requires `files`. */
export interface OpenPetsFilesApi {
  pick(opts?: { accept?: string[]; multiple?: boolean }): Promise<OpenPetsPickedFile[]>;
  save(opts: { suggestedName: string; data: string | Uint8Array }): Promise<void>;
}

// ---------------------------------------------------------------------------
// System (§14.3, §14.4)
// ---------------------------------------------------------------------------

/** Read-only environment info. Always non-sensitive. */
export interface OpenPetsSystemInfo {
  platform: "mac" | "win" | "linux";
  locale: string;
  timezone: string;
  theme: "light" | "dark";
  appVersion: string;
  online: boolean;
}

/** Aggregate machine metrics — never per-process or per-app data. */
export interface OpenPetsSystemMetrics {
  /** 0–100, recent average. */
  cpuPercent: number;
  /** 0–100. */
  memUsedPercent: number;
  battery?: { percent: number; charging: boolean };
}

/** Read-only environment + open-external + gated clipboard. */
export interface OpenPetsSystemApi {
  /** Always available. */
  info(): Promise<OpenPetsSystemInfo>;
  /** Requires `system:metrics`. */
  metrics(): Promise<OpenPetsSystemMetrics>;
  /** HTTPS-only; opens the user's real browser. Requires `system:openExternal`. */
  openExternal(url: string): Promise<void>;
  /**
   * Allowed only from inside a user-invoked command handler, never ambient.
   * Requires `clipboard` (sensitive).
   */
  readClipboardText(): Promise<string>;
  /** Requires `clipboard`. */
  writeClipboardText(text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Status & log
// ---------------------------------------------------------------------------

/** Show a short status line in the Plugins window. Requires `status`. */
export interface OpenPetsStatusApi {
  set(status: OpenPetsStatus): Promise<void>;
  clear(): Promise<void>;
}

/** Write to the desktop app log under the `plugin` scope. Always available. */
export interface OpenPetsLogApi {
  debug(...args: unknown[]): Promise<void>;
  info(...args: unknown[]): Promise<void>;
  warn(...args: unknown[]): Promise<void>;
  error(...args: unknown[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Context & registration
// ---------------------------------------------------------------------------

/**
 * The capability object passed to {@link OpenPetsPluginDefinition.start}.
 *
 * Each namespace is only functional when the matching permission is approved
 * in the manifest. `config`, `log`, `assets`, and `system.info` are always
 * available.
 *
 * `pet` is an alias for `pets.default` (back-compat + convenience); the v2
 * surface (`ctx.pet.speak(text)`, `ctx.http.fetch`) keeps working.
 */
export interface OpenPetsContext {
  pets: OpenPetsPetsApi;
  pet: OpenPetsPetHandle;
  ui: OpenPetsUiApi;
  audio: OpenPetsAudioApi;
  events: OpenPetsEventsApi;
  assets: OpenPetsAssetsApi;
  bus: OpenPetsBusApi;
  schedule: OpenPetsScheduleApi;
  storage: OpenPetsStorageApi;
  config: OpenPetsConfigApi;
  net: OpenPetsNetApi;
  notify: OpenPetsNotifyApi;
  ai: OpenPetsAiApi;
  secrets: OpenPetsSecretsApi;
  voice: OpenPetsVoiceApi;
  auth: OpenPetsAuthApi;
  files: OpenPetsFilesApi;
  system: OpenPetsSystemApi;
  commands: OpenPetsCommandsApi;
  status: OpenPetsStatusApi;
  /** v2 alias of `net` (GET-only). */
  http: OpenPetsHttpApi;
  log: OpenPetsLogApi;
  /**
   * Translate a key against the plugin's own `locales/<locale>.json` catalogs
   * for the active host locale, falling back to the plugin's `en` catalog and
   * then to the raw key. `{var}` placeholders are interpolated from `vars`.
   *
   * Use this for strings the plugin *composes at runtime* (bubble/notify/status
   * bodies). Static manifest strings (`name`, `description`, `configSchema`
   * labels, command titles) should instead use the `$t:key` reference form,
   * which the host resolves at display time.
   *
   * ```ts
   * await ctx.ui.bubble({ text: ctx.t("reminder.fire", { message: "Stretch" }) })
   * // locales/ja.json: { "reminder.fire": "リマインダー: {message}" } -> "リマインダー: Stretch"
   * ```
   */
  t: (key: string, vars?: Record<string, string | number>) => string;
  /**
   * The active host locale string (e.g. `"en"`, `"ja"`, `"pt-BR"`, `"zh-Hans"`).
   * Read it to branch on language at runtime; `ctx.t` already follows it.
   *
   * ```ts
   * if (ctx.locale.startsWith("ja")) { /* ... *\/ }
   * ```
   */
  readonly locale: string;
}

/** The object you pass to {@link OpenPetsPluginApi.register}. */
export interface OpenPetsPluginDefinition {
  /** Runs when the plugin is enabled or the app launches. */
  start(ctx: OpenPetsContext): void | Promise<void>;
  /** Optional cleanup. Schedules, commands, bubbles, and subscriptions are torn down for you. */
  stop?(ctx?: OpenPetsContext): void | Promise<void>;
}

/** The injected global used to register a plugin. */
export interface OpenPetsPluginApi {
  register(definition: OpenPetsPluginDefinition): void;
}

/**
 * The signature of an exported `register` function — the testable plugin
 * style used by the official plugins:
 *
 * ```ts
 * export function register(OpenPetsPlugin: OpenPetsPluginApi) {
 *   OpenPetsPlugin.register({ async start(ctx) {} })
 * }
 * ```
 */
export type OpenPetsPluginEntry = (api: OpenPetsPluginApi) => void | Promise<void>;

/** Field types supported by `configSchema` in the manifest. */
export type OpenPetsConfigFieldType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "time"
  | "date"
  | "list"
  | "multiselect"
  | "sound"
  /** Masked input, encrypted at rest, never logged or echoed (v3). */
  | "secret";

/** v2 alias: the old flat pet namespace shape. */
export type OpenPetsPetApi = Pick<
  OpenPetsPetHandle,
  "speak" | "react" | "moveBy" | "wander" | "moveToHome"
>;

declare global {
  /**
   * Injected by the OpenPets runtime. Call once at the top level of your
   * entry file to register your plugin.
   */
  const OpenPetsPlugin: OpenPetsPluginApi;
}

export {};
