import { BrowserWindow, powerMonitor, screen, shell, type Display } from "electron";

import { getAppStateSnapshot, getDefaultPetPosition, getPerMonitorPetPosition, resetDefaultPetPosition, setDefaultPetPosition, setPerMonitorPetPosition, updatePreferences } from "./app-state.js";
import { shouldShowDefaultPetForExternalEvent } from "./app-state-core.js";
import { defaultPetWindowSize, getAllDisplayKeys, getDefaultPetInitialPosition, getDisplayKey, getDisplayKeyForPosition, invalidateDisplayCache, type Point } from "./display.js";
import { motionMoveTo } from "./pet-motion-engine.js";
import { registerRoamingPet } from "./pet-roaming-controller.js";
import { debug, info } from "./logger.js";
import { transientDisplayMs, type OpenPetsReaction } from "./local-ipc-protocol.js";
import { clearTransientReaction, createDefaultPetWindow, getSafeDefaultPetPosition, getTransientDisplayDurationMs, getTransientReactionAnimationMs, isPetWindowDragging, loadDefaultPetContent, mergePetTransientDisplay, readWindowPosition, recoverPetMouseInterop, setPetReactionState, type PetPluginBubbles, type PetShowMediaOptions, type PetStatusBadgeReaction, type PetTransientDisplay } from "./pet-window.js";
import { PetBubbleArbiter, type ActiveBubble, type PetBubbleSink } from "./plugin-bubble-arbiter.js";
import { publishPluginPetEvent } from "./plugin-events-source.js";
import { reclampAgentPetWindows } from "./agent-pet-controller.js";
import { reclampPluginPetWindows } from "./plugin-pet-registry.js";
import { reclampLanVisitingPetWindows } from "./lan-pet-controller.js";

let defaultPetWindow: BrowserWindow | null = null;
let paused = false;
let transientDisplay: PetTransientDisplay | null = null;
let statusBadge: PetStatusBadgeReaction | null = null;
let transientDisplayTimeout: NodeJS.Timeout | null = null;
let transientAnimationTimeout: NodeJS.Timeout | null = null;
let statusBadgeTimeout: NodeJS.Timeout | null = null;
let displayGeneration = 0;
const busyStatusBadgeMs = 120_000;
const maxPluginMoveDistance = 160;
const minPluginMoveDurationMs = 250;
const maxPluginMoveDurationMs = 1_500;
let movementInProgress = false;

export type PetMoveOptions = { readonly x: number; readonly y: number; readonly durationMs?: number };
export type PetWanderOptions = { readonly distance?: number; readonly durationMs?: number };
export type PetReactionOptions = { readonly showMessage?: boolean };

// Plugin bubble slots (SDK v3): the arbiter decides what each slot shows; the
// sink merges its decisions into the default pet render.
let pluginTransientBubble: ActiveBubble | null = null;
let pluginPinnedBubble: ActiveBubble | null = null;

const defaultPetBubbleSink: PetBubbleSink = {
  present(slot, content) {
    if (slot === "pinned") pluginPinnedBubble = content;
    else pluginTransientBubble = content;
    debug("pet.default", "plugin bubble slot", { slot, token: content?.token ?? null, pluginId: content?.pluginId });
    if (content) showDefaultPetForExternalEvent();
    refreshDefaultPetContent();
  },
};

/** The default pet's bubble arbiter — the Electron bubbles capability targets this. */
export const defaultPetBubbleArbiter = new PetBubbleArbiter(defaultPetBubbleSink);

export function getDefaultPetPluginBubbles(): PetPluginBubbles | null {
  if (!pluginTransientBubble && !pluginPinnedBubble) return null;
  return { transient: pluginTransientBubble, pinned: pluginPinnedBubble };
}

export function showDefaultPet(): void {
  updatePreferences({ openDefaultPetOnLaunch: true });
  showDefaultPetWindow("user");
}

export function showDefaultPetForLan(): void {
  showDefaultPetWindow("external-event");
}

function showDefaultPetWindow(source: "user" | "external-event"): void {
  const window = getOrCreateDefaultPetWindow();
  info("pet.default", "show requested", { source, windowId: window.id, visible: window.isVisible(), minimized: window.isMinimized(), paused, petId: getAppStateSnapshot().preferences.defaultPetId });

  if (window.isMinimized()) {
    window.restore();
  }

  window.showInactive();
  registerRoamingPet("default", getDefaultPetWindowForPlugins);
}

export function hideDefaultPet(): void {
  updatePreferences({ openDefaultPetOnLaunch: false });
  hideDefaultPetWindow();
}

export function hideDefaultPetForLan(): void {
  hideDefaultPetWindow();
}

function hideDefaultPetWindow(): void {
  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) {
    debug("pet.default", "hide skipped", { reason: "no-window" });
    return;
  }
  if (!defaultPetWindow.isVisible()) {
    return;
  }

  const hidePosition = readWindowPosition(defaultPetWindow);
  info("pet.default", "hide requested", { windowId: defaultPetWindow.id, position: hidePosition, petId: getAppStateSnapshot().preferences.defaultPetId });
  handlePositionChanged(hidePosition);
  defaultPetWindow.hide();
}

export function getDefaultPetLanPosition(): { readonly x: number; readonly y: number } | null {
  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) return null;
  return readWindowPosition(defaultPetWindow);
}

export function isDefaultPetVisible(): boolean {
  return Boolean(defaultPetWindow && !defaultPetWindow.isDestroyed() && defaultPetWindow.isVisible());
}

export function setDefaultPetPaused(nextPaused: boolean): void {
  paused = nextPaused;
  info("pet.default", "pause changed", { paused });

  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) {
    return;
  }

  void loadDefaultPetContent(defaultPetWindow, paused, transientDisplay, statusBadge, getCurrentDismissToken(), getDefaultPetPluginBubbles());
}

export function getDefaultPetPaused(): boolean {
  return paused;
}

export function getDefaultPetWindowForPlugins(): BrowserWindow | null {
  return defaultPetWindow && !defaultPetWindow.isDestroyed() ? defaultPetWindow : null;
}

export function refreshDefaultPetContent(): void {
  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) {
    debug("pet.default", "refresh skipped", { reason: "no-window" });
    return;
  }

  debug("pet.default", "refresh content", { windowId: defaultPetWindow.id, paused, hasDisplay: Boolean(transientDisplay), badge: statusBadge, petId: getAppStateSnapshot().preferences.defaultPetId });
  void loadDefaultPetContent(defaultPetWindow, paused, transientDisplay, statusBadge, getCurrentDismissToken(), getDefaultPetPluginBubbles());
}

export function recoverDefaultPetMouseInterop(reason: string): void {
  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) {
    debug("pet.default", "mouse interop recovery skipped", { reason, skippedReason: "no-window" });
    return;
  }

  debug("pet.default", "mouse interop recovery requested", { windowId: defaultPetWindow.id, reason, petId: getAppStateSnapshot().preferences.defaultPetId });
  recoverPetMouseInterop(defaultPetWindow, reason);
}

export function applyExternalPetReaction(reaction: OpenPetsReaction, options: PetReactionOptions = {}): { readonly shown: boolean; readonly reason?: string } {
  if (paused) {
    return { shown: false, reason: "paused" };
  }

  setTransientDisplay({ reaction, ...(options.showMessage === false ? { suppressReactionMessage: true } : {}) });
  showDefaultPetForExternalEvent();
  return { shown: isDefaultPetVisible() };
}

export function applyExternalPetSay(message: string, reaction?: OpenPetsReaction): { readonly shown: boolean; readonly reason?: string } {
  if (paused) {
    return { shown: false, reason: "paused" };
  }

  if (!reaction) clearStatusBadge();
  setTransientDisplay({ message, reaction });
  showDefaultPetForExternalEvent();
  return { shown: isDefaultPetVisible() };
}

export function applyExternalPetShowMedia(options: PetShowMediaOptions): { readonly shown: boolean; readonly reason?: string } {
  if (paused) {
    return { shown: false, reason: "paused" };
  }

  if (!options.reaction) clearStatusBadge();
  setTransientDisplay({ message: options.message, reaction: options.reaction, mediaPath: options.mediaPath, displayDurationMs: options.durationMs, clickUrl: options.clickUrl });
  showDefaultPetForExternalEvent();
  return { shown: isDefaultPetVisible() };
}

export function applyExternalPetStatusReaction(reaction: OpenPetsReaction | null): void {
  if (reaction === null || reaction === "idle") clearStatusBadge();
  else setStatusBadge(reaction);
  refreshDefaultPetContent();
}

export function applyExternalPetMoveBy(options: PetMoveOptions): Promise<{ readonly moved: boolean; readonly reason?: string }> {
  return moveDefaultPetBy(Number(options.x), Number(options.y), options.durationMs);
}

export function applyExternalPetWander(options: PetWanderOptions): Promise<{ readonly moved: boolean; readonly reason?: string }> {
  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) return Promise.resolve({ moved: false, reason: "no-window" });
  const blockedReason = getMovementBlockedReason(defaultPetWindow);
  if (blockedReason) {
    debug("pet.default", "wander skipped", { reason: blockedReason });
    return Promise.resolve({ moved: false, reason: blockedReason });
  }
  const distance = clampNumber(Number(options.distance ?? 80), 0, maxPluginMoveDistance);
  const angle = Math.random() * Math.PI * 2;
  const current = readWindowPosition(defaultPetWindow);
  const durationMs = clampNumber(Number(options.durationMs ?? 700), minPluginMoveDurationMs, maxPluginMoveDurationMs);
  const rawTarget = {
    x: current.x + Math.cos(angle) * distance,
    y: current.y + Math.sin(angle) * distance,
  };
  const target = getSafeDefaultPetPosition(rawTarget);
  return motionMoveTo("default", getDefaultPetWindowForPlugins, target, { durationMs })
    .then(() => ({ moved: true } as const))
    .catch(() => ({ moved: false, reason: "engine-error" } as const));
}

export function applyExternalPetMoveToHome(): Promise<{ readonly moved: boolean; readonly reason?: string }> {
  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) return Promise.resolve({ moved: false, reason: "no-window" });
  const current = readWindowPosition(defaultPetWindow);
  const home = getSafeDefaultPetPosition(getDefaultPetInitialPosition(defaultPetWindowSize));
  return moveDefaultPetBy(home.x - current.x, home.y - current.y, maxPluginMoveDurationMs, Number.POSITIVE_INFINITY);
}

export function destroyDefaultPet(): void {
  clearDefaultPetDisplayTimers();

  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) {
    debug("pet.default", "destroy skipped", { reason: "no-window" });
    defaultPetWindow = null;
    return;
  }

  const destroyPosition = readWindowPosition(defaultPetWindow);
  info("pet.default", "destroy requested", { windowId: defaultPetWindow.id, position: destroyPosition, petId: getAppStateSnapshot().preferences.defaultPetId });
  handlePositionChanged(destroyPosition);
  const window = defaultPetWindow;
  defaultPetWindow = null;
  window.setIgnoreMouseEvents(false);
  window.destroy();
}

export function installDefaultPetDisplayHandlers(): void {
  screen.on("display-added", debounceDisplayChange("display-added"));
  screen.on("display-removed", debounceDisplayChange("display-removed"));
  screen.on("display-metrics-changed", debounceDisplayChange("display-metrics-changed"));
  powerMonitor.on("resume", recoverDefaultPetWindowAfterResume);
}

type DisplayChangeReason = "display-added" | "display-removed" | "display-metrics-changed";

function debounceDisplayChange(reason: DisplayChangeReason): (_event: unknown, display: Display) => void {
  let timer: NodeJS.Timeout | null = null;
  let latestDisplay: Display | undefined;
  return (_event: unknown, display: Display) => {
    latestDisplay = display;
    invalidateDisplayCache();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      reclampAllLivePetWindows(reason, latestDisplay);
    }, 200);
  };
}

function handleBubbleDismissed(dismissToken: string): void {
  debug("pet.default", "bubble dismissed callback", { windowId: defaultPetWindow?.id, dismissToken, currentGeneration: displayGeneration });
  if (PetBubbleArbiter.isArbiterToken(dismissToken)) {
    defaultPetBubbleArbiter.handleDismissed(dismissToken);
    return;
  }
  if (dismissToken !== String(displayGeneration)) {
    debug("pet.default", "bubble dismissed stale token", { dismissToken, currentGeneration: displayGeneration });
    return;
  }
  const clickUrl = transientDisplay?.clickUrl;
  if (clickUrl) {
    info("pet.default", "media bubble clicked", { windowId: defaultPetWindow?.id });
    void shell.openExternal(clickUrl).catch((error: unknown) => {
      debug("pet.default", "media bubble click open failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }
  clearDefaultPetDisplayTimers();
  if (defaultPetWindow && !defaultPetWindow.isDestroyed()) {
    void loadDefaultPetContent(defaultPetWindow, paused, null, null, undefined, getDefaultPetPluginBubbles());
  }
}

function getOrCreateDefaultPetWindow(): BrowserWindow {
  if (defaultPetWindow && !defaultPetWindow.isDestroyed()) {
    return defaultPetWindow;
  }

  // The flat position is the most recently saved position across all monitors.
  // Do not scan every connected per-monitor entry here: display order is usually
  // primary-first, which can override the true last position with an older
  // primary-display entry.
  const position = getSafeDefaultPetPosition(getDefaultPetPosition());

  defaultPetWindow = createDefaultPetWindow({
    position,
    paused,
    display: transientDisplay,
    badge: statusBadge,
    pluginBubbles: getDefaultPetPluginBubbles(),
    onPositionChanged: handlePositionChanged,
    onHideRequested: hideDefaultPet,
    onBubbleDismissed: handleBubbleDismissed,
    onBubbleAction: (token, actionId) => defaultPetBubbleArbiter.handleAction(token, actionId),
    onBubbleSubmit: (token, values) => defaultPetBubbleArbiter.handleSubmit(token, values),
    onPetEvent: (name, payload) => publishPluginPetEvent("default", name, payload),
  }, getCurrentDismissToken());
  const windowId = defaultPetWindow.id;
  info("pet.default", "created", { windowId, position, paused, petId: getAppStateSnapshot().preferences.defaultPetId });

  defaultPetWindow.on("closed", () => {
    info("pet.default", "closed", { windowId });
    defaultPetWindow = null;
  });

  return defaultPetWindow;
}

function setTransientDisplay(display: PetTransientDisplay): void {
  debug("pet.default", "transient display set", { reaction: display.reaction, hasMessage: Boolean(display.message), hasReactionMessage: Boolean(display.reactionMessage) });
  displayGeneration++;
  transientDisplay = mergePetTransientDisplay(transientDisplay, { ...display, dismissToken: String(displayGeneration) });
  if (display.reaction) setStatusBadge(display.reaction);

  if (transientDisplayTimeout) {
    clearTimeout(transientDisplayTimeout);
  }
  if (transientAnimationTimeout) {
    clearTimeout(transientAnimationTimeout);
    transientAnimationTimeout = null;
  }

  const animationMs = getTransientReactionAnimationMs(transientDisplay);
  const displayDurationMs = getTransientDisplayDurationMs(transientDisplay);
  if (animationMs !== null && animationMs < displayDurationMs) {
    transientAnimationTimeout = setTimeout(() => {
      if (!transientDisplay) return;
      transientDisplay = clearTransientReaction(transientDisplay);
      transientAnimationTimeout = null;
      if (defaultPetWindow && !defaultPetWindow.isDestroyed()) setPetReactionState(defaultPetWindow, "idle");
    }, animationMs);
  }

  transientDisplayTimeout = setTimeout(() => {
    transientDisplay = null;
    transientDisplayTimeout = null;
    if (transientAnimationTimeout) {
      clearTimeout(transientAnimationTimeout);
      transientAnimationTimeout = null;
    }
    refreshDefaultPetContent();
  }, displayDurationMs);

  refreshDefaultPetContent();
}

function showDefaultPetForExternalEvent(): void {
  const state = getAppStateSnapshot();
  const visible = isDefaultPetVisible();
  if (!shouldShowDefaultPetForExternalEvent(visible, state.preferences.openDefaultPetOnLaunch, paused)) {
    debug("pet.default", "external show skipped", { reason: "paused", visible, openDefaultPetOnLaunch: state.preferences.openDefaultPetOnLaunch });
    return;
  }

  showDefaultPetWindow("external-event");
}

async function moveDefaultPetBy(rawX: number, rawY: number, rawDurationMs: unknown, maxDistance = maxPluginMoveDistance): Promise<{ readonly moved: boolean; readonly reason?: string }> {
  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) return { moved: false, reason: "no-window" };
  const window = defaultPetWindow;
  const blockedReason = getMovementBlockedReason(window);
  if (blockedReason) {
    debug("pet.default", "move skipped", { reason: blockedReason });
    return { moved: false, reason: blockedReason };
  }
  const current = readWindowPosition(window);
  const distance = Math.min(Math.hypot(rawX, rawY), maxDistance);
  if (!Number.isFinite(distance) || distance <= 0) return { moved: false, reason: "invalid-distance" };
  const scale = distance / Math.hypot(rawX, rawY);
  const target = getSafeDefaultPetPosition({ x: current.x + rawX * scale, y: current.y + rawY * scale });
  const durationMs = clampNumber(Number(rawDurationMs ?? 700), minPluginMoveDurationMs, maxPluginMoveDurationMs);
  const steps = Math.max(8, Math.min(16, Math.round(durationMs / 100)));
  movementInProgress = true;
  debug("pet.default", "move start", { windowId: window.id, from: current, target, durationMs, steps });
  try {
    for (let step = 1; step <= steps; step += 1) {
      if (window.isDestroyed()) return { moved: false, reason: "destroyed" };
      const blocked = getMovementBlockedReason(window, true);
      if (blocked) return { moved: false, reason: blocked };
      const t = step / steps;
      window.setPosition(Math.round(current.x + (target.x - current.x) * t), Math.round(current.y + (target.y - current.y) * t), false);
      await delay(durationMs / steps);
    }
    window.setPosition(target.x, target.y, false);
    handlePositionChanged(target);
    debug("pet.default", "move finished", { windowId: window.id, target });
    return { moved: true };
  } finally {
    movementInProgress = false;
  }
}

function getMovementBlockedReason(window: BrowserWindow, allowMoving = false): string | undefined {
  if (movementInProgress && !allowMoving) return "already-moving";
  if (!window.isVisible()) return "hidden";
  if (paused) return "paused";
  if (isPetWindowDragging(window)) return "dragging";
  if (transientDisplay) return "transient-display";
  if (statusBadge) return "status-active";
  return undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStatusBadge(reaction: OpenPetsReaction): void {
  if (reaction === "idle") {
    clearStatusBadge();
    return;
  }

  statusBadge = reaction;
  debug("pet.default", "status badge set", { reaction, durationMs: isBusyStatusBadgeReaction(reaction) ? busyStatusBadgeMs : transientDisplayMs });
  if (statusBadgeTimeout) clearTimeout(statusBadgeTimeout);
  statusBadgeTimeout = setTimeout(() => {
    clearStatusBadge();
    refreshDefaultPetContent();
  }, isBusyStatusBadgeReaction(reaction) ? busyStatusBadgeMs : transientDisplayMs);
}

function clearStatusBadge(): void {
  if (statusBadge) debug("pet.default", "status badge cleared", { reaction: statusBadge });
  statusBadge = null;
  if (statusBadgeTimeout) clearTimeout(statusBadgeTimeout);
  statusBadgeTimeout = null;
}

function clearDefaultPetDisplayTimers(): void {
  if (transientDisplayTimeout) clearTimeout(transientDisplayTimeout);
  if (transientAnimationTimeout) clearTimeout(transientAnimationTimeout);
  if (statusBadgeTimeout) clearTimeout(statusBadgeTimeout);
  transientDisplayTimeout = null;
  transientAnimationTimeout = null;
  statusBadgeTimeout = null;
  transientDisplay = null;
  statusBadge = null;
}

function getCurrentDismissToken(): string | undefined {
  return transientDisplay?.dismissToken ?? (statusBadge ? String(displayGeneration) : undefined);
}

function isBusyStatusBadgeReaction(reaction: OpenPetsReaction): boolean {
  return reaction === "thinking" || reaction === "working" || reaction === "editing" || reaction === "running" || reaction === "testing" || reaction === "waiting";
}

/** Save position both in the flat key (backwards compat) and per-monitor map. */
function handlePositionChanged(position: Point): void {
  setDefaultPetPosition(position);
  const displayKey = getDisplayKeyForPosition(position);
  setPerMonitorPetPosition(displayKey, position);
}

function reclampDefaultPetWindow(reason: DisplayChangeReason, changedDisplay?: Display): void {
  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) {
    return;
  }

  const currentPosition = readWindowPosition(defaultPetWindow);
  const currentDisplayKey = getDisplayKeyForPosition(currentPosition);
  const changedDisplayKey = changedDisplay ? getDisplayKey(changedDisplay.bounds) : undefined;
  let restoredPosition: Point | undefined;

  // Only restore to a newly-added display. Iterating every connected display can
  // pick the primary display first and skip the secondary monitor that was just
  // reconnected.
  if (reason === "display-added" && changedDisplayKey && changedDisplayKey !== currentDisplayKey && getAllDisplayKeys().includes(changedDisplayKey)) {
    restoredPosition = getPerMonitorPetPosition(changedDisplayKey);
  }

  const safePosition = restoredPosition
    ? getSafeDefaultPetPosition(restoredPosition)
    : getSafeDefaultPetPosition(currentPosition);

  info("pet.default", "reclamp position", { windowId: defaultPetWindow.id, position: safePosition, restored: Boolean(restoredPosition), reason, changedDisplayKey });
  defaultPetWindow.setPosition(safePosition.x, safePosition.y, false);
  handlePositionChanged(safePosition);
  recoverDefaultPetMouseInterop("display-change");
}

function reclampAllLivePetWindows(reason: DisplayChangeReason, changedDisplay?: Display): void {
  reclampDefaultPetWindow(reason, changedDisplay);
  reclampAgentPetWindows();
  reclampLanVisitingPetWindows();
  reclampPluginPetWindows();
}

function recoverDefaultPetWindowAfterResume(): void {
  recoverDefaultPetMouseInterop("power-resume");
  setTimeout(() => recoverDefaultPetMouseInterop("power-resume+500ms"), 500).unref?.();
}

export function shouldOpenDefaultPetOnLaunch(): boolean {
  return getAppStateSnapshot().preferences.openDefaultPetOnLaunch;
}

export function resetDefaultPetToInitialPosition(): void {
  const safePosition = getSafeDefaultPetPosition(getDefaultPetInitialPosition(defaultPetWindowSize));
  resetDefaultPetPosition(safePosition);

  if (defaultPetWindow && !defaultPetWindow.isDestroyed()) {
    defaultPetWindow.setPosition(safePosition.x, safePosition.y, false);
  }
}
