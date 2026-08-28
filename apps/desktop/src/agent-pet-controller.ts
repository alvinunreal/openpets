import { BrowserWindow } from "electron";

import { getAppStateSnapshot, type PetScaleValue } from "./app-state.js";
import { registerRoamingPet, unregisterRoamingPet } from "./pet-roaming-controller.js";
import { clampToTerminalBounds, getConfinementState, getEffectiveConfinementBounds } from "./confinement-manager.js";
import { defaultPetWindowSize, clampToVisibleWorkArea, getDefaultPetInitialPosition } from "./display.js";
import { debug, info } from "./logger.js";
import { transientDisplayMs, type OpenPetsReaction } from "./local-ipc-protocol.js";
import { clearTransientReaction, createAgentPetWindow, getTransientDisplayDurationMs, getTransientReactionAnimationMs, loadExplicitPetContent, mergePetTransientDisplay, readWindowPosition, setPetReactionState, type PetShowMediaOptions, type PetStatusBadgeReaction, type PetTransientDisplay } from "./pet-window.js";
import { focusTerminalWindow } from "./terminal-focus.js";

const agentPetWindows = new Map<string, BrowserWindow>();
const transientDisplays = new Map<string, PetTransientDisplay>();
const statusBadges = new Map<string, PetStatusBadgeReaction>();
const transientTimers = new Map<string, NodeJS.Timeout>();
const transientAnimationTimers = new Map<string, NodeJS.Timeout>();
const statusBadgeTimers = new Map<string, NodeJS.Timeout>();
const dismissedAgentPets = new Set<string>();
const displayGenerations = new Map<string, number>();
const busyStatusBadgeMs = 120_000;

export function showAgentPet(petId: string): boolean {
  if (dismissedAgentPets.has(petId)) {
    info("pet.agent", "show skipped", { petId, reason: "dismissed", activeWindows: agentPetWindows.size });
    return false;
  }
  const window = getOrCreateAgentPetWindow(petId);
  info("pet.agent", "show requested", { petId, windowId: window.id, visible: window.isVisible(), minimized: window.isMinimized(), activeWindows: agentPetWindows.size });
  if (window.isMinimized()) window.restore();
  // Pull the pet into its terminal window bounds if confinement is active.
  repositionConfinedPet(petId, window);
  window.showInactive();
  const shownWin = agentPetWindows.get(petId);
  if (shownWin && !shownWin.isDestroyed()) {
    registerRoamingPet(petId, () => agentPetWindows.get(petId) ?? null);
  }
  return true;
}

/**
 * Reposition a pet so it sits inside its terminal window bounds (if confined).
 * This is called on show and whenever confinement state changes.
 * If the pet is in free-roam mode this is a no-op.
 */
export function repositionConfinedPet(petId: string, win?: BrowserWindow): void {
  const confinementBounds = getEffectiveConfinementBounds(petId);
  if (!confinementBounds) return;
  const window = win ?? agentPetWindows.get(petId);
  if (!window || window.isDestroyed()) return;
  const [cx, cy] = window.getPosition();
  const clamped = clampToTerminalBounds({ x: cx, y: cy }, defaultPetWindowSize, confinementBounds);
  if (clamped.x !== cx || clamped.y !== cy) {
    debug("pet.agent", "reposition confined", { petId, from: { x: cx, y: cy }, to: clamped });
    window.setPosition(clamped.x, clamped.y, false);
  }
}

export function closeAgentPetIfOpen(petId: string): void {
  const window = agentPetWindows.get(petId);
  if (!window || window.isDestroyed()) {
    debug("pet.agent", "close skipped", { petId, reason: "no-window", activeWindows: agentPetWindows.size });
    return;
  }
  info("pet.agent", "close requested", { petId, windowId: window.id, activeWindows: agentPetWindows.size });
  agentPetWindows.delete(petId);
  clearAgentDisplay(petId);
  unregisterRoamingPet(petId);
  window.setIgnoreMouseEvents(false);
  window.destroy();
}

export function dismissAgentPetForActiveLease(petId: string): void {
  info("pet.agent", "dismiss requested", { petId });
  dismissedAgentPets.add(petId);
  closeAgentPetIfOpen(petId);
}

export function clearAgentPetDismissal(petId: string): void {
  debug("pet.agent", "dismissal cleared", { petId, wasDismissed: dismissedAgentPets.has(petId) });
  dismissedAgentPets.delete(petId);
}

export function clearAgentPetLeaseState(petId: string): void {
  info("pet.agent", "lease state cleared", { petId, hadWindow: agentPetWindows.has(petId), wasDismissed: dismissedAgentPets.has(petId) });
  dismissedAgentPets.delete(petId);
  closeAgentPetIfOpen(petId);
  clearAgentDisplay(petId);
}

export function applyAgentPetReaction(petId: string, reaction: OpenPetsReaction): { readonly shown: boolean; readonly reason?: string } {
  debug("pet.agent", "reaction apply", { petId, reaction });
  setAgentDisplay(petId, { reaction });
  const shown = showAgentPet(petId);
  return shown ? { shown } : { shown, reason: "dismissed" };
}

export function applyAgentPetSay(petId: string, message: string, reaction?: OpenPetsReaction): { readonly shown: boolean; readonly reason?: string } {
  debug("pet.agent", "say apply", { petId, reaction, messageLength: message.length });
  if (!reaction) clearStatusBadge(petId);
  setAgentDisplay(petId, { message, reaction });
  const shown = showAgentPet(petId);
  return shown ? { shown } : { shown, reason: "dismissed" };
}

export function applyAgentPetShowMedia(petId: string, options: PetShowMediaOptions): { readonly shown: boolean; readonly reason?: string } {
  debug("pet.agent", "showMedia apply", { petId, reaction: options.reaction, hasMessage: Boolean(options.message), durationMs: options.durationMs });
  if (!options.reaction) clearStatusBadge(petId);
  setAgentDisplay(petId, { message: options.message, reaction: options.reaction, mediaPath: options.mediaPath, displayDurationMs: options.durationMs, clickUrl: options.clickUrl });
  const shown = showAgentPet(petId);
  return shown ? { shown } : { shown, reason: "dismissed" };
}

export function closeAllAgentPets(): void {
  info("pet.agent", "close all requested", { activeWindows: agentPetWindows.size });
  for (const petId of [...agentPetWindows.keys()]) {
    closeAgentPetIfOpen(petId);
  }
  clearAllAgentDisplayTimers();
}

export function refreshAgentPetContent(): void {
  debug("pet.agent", "refresh all content", { activeWindows: agentPetWindows.size, petIds: [...agentPetWindows.keys()] });
  const scale = getPreferredPetScale();
  for (const [petId, window] of agentPetWindows.entries()) {
    if (!window.isDestroyed()) {
      const display = transientDisplays.get(petId) ?? null;
      const badge = statusBadges.get(petId) ?? null;
      void loadExplicitPetContent(window, petId, display, badge, getCurrentDismissToken(petId, display, badge), scale);
    }
  }
}

/**
 * Re-clamp all live agent pet windows to a valid display position.
 * Called on display topology changes to ensure agent pets are not stranded
 * on a display that has been removed or whose geometry has changed.
 */
export function reclampAgentPetWindows(): void {
  for (const [petId, window] of agentPetWindows.entries()) {
    if (!window || window.isDestroyed()) continue;
    const safePosition = readWindowPosition(window);
    const [currentX, currentY] = window.getPosition();
    if (safePosition.x !== currentX || safePosition.y !== currentY) {
      info("pet.agent", "reclamp position", { petId, windowId: window.id, from: { x: currentX, y: currentY }, to: safePosition });
      window.setPosition(safePosition.x, safePosition.y, false);
    }
  }
}

function handleBubbleDismissed(petId: string, dismissToken: string): void {
  const currentGeneration = displayGenerations.get(petId) ?? 0;
  debug("pet.agent", "bubble dismissed callback", { petId, windowId: agentPetWindows.get(petId)?.id, dismissToken, currentGeneration });
  if (dismissToken !== String(currentGeneration)) {
    debug("pet.agent", "bubble dismissed stale token", { petId, dismissToken, currentGeneration });
    return;
  }
  clearAgentDisplay(petId);
  const window = agentPetWindows.get(petId);
  if (window && !window.isDestroyed()) {
    void loadExplicitPetContent(window, petId, null, null, undefined, getPreferredPetScale());
  }
}

function getOrCreateAgentPetWindow(petId: string): BrowserWindow {
  const existing = agentPetWindows.get(petId);
  if (existing && !existing.isDestroyed()) {
    debug("pet.agent", "reuse existing window", { petId, windowId: existing.id, activeWindows: agentPetWindows.size });
    return existing;
  }

  const state = getAppStateSnapshot();
  const scale = state.preferences.petScale as PetScaleValue;
  const pet = state.pets.installed.find((candidate) => candidate.id === petId);
  if (!pet) throw new Error(`Installed pet is unavailable: ${petId}`);
  const offset = agentPetWindows.size + 1;
  // Use terminal bounds for initial position when confinement is active.
  const confinementBounds = getEffectiveConfinementBounds(petId);
  const baseInitial = confinementBounds
    ? { x: confinementBounds.x + Math.max(0, (confinementBounds.width - defaultPetWindowSize.width) / 2), y: confinementBounds.y + Math.max(0, confinementBounds.height - defaultPetWindowSize.height) }
    : getDefaultPetInitialPosition(defaultPetWindowSize);
  const rawPosition = { x: baseInitial.x - offset * 36, y: baseInitial.y - offset * 24 };
  // Clamp the offset position so multi-pet stacking stays within bounds.
  const initial = confinementBounds
    ? clampToTerminalBounds(rawPosition, defaultPetWindowSize, confinementBounds)
    : clampToVisibleWorkArea(rawPosition, defaultPetWindowSize);
  const display = transientDisplays.get(petId) ?? null;
  const badge = statusBadges.get(petId) ?? null;
  const window = createAgentPetWindow({
    petId,
    displayName: pet.displayName,
    scale,
    position: { x: initial.x, y: initial.y },
    display,
    badge,
    onCloseRequested: () => dismissAgentPetForActiveLease(petId),
    onBubbleDismissed: (token) => handleBubbleDismissed(petId, token),
    onWindowReplaced: (replacement) => {
      agentPetWindows.set(petId, replacement);
      const currentDisplay = transientDisplays.get(petId) ?? null;
      const currentBadge = statusBadges.get(petId) ?? null;
      void loadExplicitPetContent(replacement, petId, currentDisplay, currentBadge, getCurrentDismissToken(petId, currentDisplay, currentBadge), getPreferredPetScale());
      replacement.on("closed", () => {
        if (agentPetWindows.get(petId) !== replacement) return;
        unregisterRoamingPet(petId);
        agentPetWindows.delete(petId);
        clearAgentDisplay(petId);
      });
    },
    onFocusSessionWindow: () => {
      const confinement = getConfinementState(petId);
      if (confinement?.terminalOwnerPid) {
        focusTerminalWindow(confinement.terminalOwnerPid).catch((err) => {
          debug("pet.agent", "focus session window failed", { petId, error: String(err) });
        });
      }
    },
  }, getCurrentDismissToken(petId, display, badge));
  const windowId = window.id;

  window.on("closed", () => {
    if (agentPetWindows.get(petId) !== window) return;
    info("pet.agent", "closed", { petId, windowId, activeWindowsBeforeDelete: agentPetWindows.size });
    // Unregister from the motion engine BEFORE deleting the window map entry
    // to prevent the shared ticker from touching the destroyed window.
    unregisterRoamingPet(petId);
    agentPetWindows.delete(petId);
    clearAgentDisplay(petId);
  });
  agentPetWindows.set(petId, window);
  info("pet.agent", "created", { petId, windowId: window.id, offset, activeWindows: agentPetWindows.size, position: initial, confined: confinementBounds !== null });
  return window;
}

function setAgentDisplay(petId: string, display: PetTransientDisplay): void {
  debug("pet.agent", "display set", { petId, reaction: display.reaction, hasMessage: Boolean(display.message), hasReactionMessage: Boolean(display.reactionMessage) });
  const nextGeneration = (displayGenerations.get(petId) ?? 0) + 1;
  displayGenerations.set(petId, nextGeneration);
  const preparedDisplay = mergePetTransientDisplay(transientDisplays.get(petId) ?? null, { ...display, dismissToken: String(nextGeneration) });
  transientDisplays.set(petId, preparedDisplay);
  if (display.reaction) setStatusBadge(petId, display.reaction);
  const existingTimer = transientTimers.get(petId);
  if (existingTimer) clearTimeout(existingTimer);
  const existingAnimationTimer = transientAnimationTimers.get(petId);
  if (existingAnimationTimer) clearTimeout(existingAnimationTimer);

  const animationMs = getTransientReactionAnimationMs(preparedDisplay);
  const displayDurationMs = getTransientDisplayDurationMs(preparedDisplay);
  if (animationMs !== null && animationMs < displayDurationMs) {
    const animationTimer = setTimeout(() => {
      const current = transientDisplays.get(petId);
      if (!current) return;
      const updated = clearTransientReaction(current);
      transientDisplays.set(petId, updated);
      transientAnimationTimers.delete(petId);
      const window = agentPetWindows.get(petId);
      if (window && !window.isDestroyed()) setPetReactionState(window, "idle");
    }, animationMs);
    transientAnimationTimers.set(petId, animationTimer);
  }

  const timer = setTimeout(() => {
    transientDisplays.delete(petId);
    transientTimers.delete(petId);
    const animationTimer = transientAnimationTimers.get(petId);
    if (animationTimer) clearTimeout(animationTimer);
    transientAnimationTimers.delete(petId);
    const window = agentPetWindows.get(petId);
    if (window && !window.isDestroyed()) {
      const badge = statusBadges.get(petId) ?? null;
      void loadExplicitPetContent(window, petId, null, badge, getCurrentDismissToken(petId, null, badge), getPreferredPetScale());
    }
  }, displayDurationMs);
  transientTimers.set(petId, timer);
  const window = agentPetWindows.get(petId);
  if (window && !window.isDestroyed()) void loadExplicitPetContent(window, petId, preparedDisplay, statusBadges.get(petId) ?? null, preparedDisplay.dismissToken, getPreferredPetScale());
}

function clearAgentDisplay(petId: string): void {
  debug("pet.agent", "display cleared", { petId, hadDisplay: transientDisplays.has(petId), hadBadge: statusBadges.has(petId) });
  const timer = transientTimers.get(petId);
  if (timer) clearTimeout(timer);
  const animationTimer = transientAnimationTimers.get(petId);
  if (animationTimer) clearTimeout(animationTimer);
  transientTimers.delete(petId);
  transientAnimationTimers.delete(petId);
  const badgeTimer = statusBadgeTimers.get(petId);
  if (badgeTimer) clearTimeout(badgeTimer);
  statusBadgeTimers.delete(petId);
  transientDisplays.delete(petId);
  statusBadges.delete(petId);
}

function clearAllAgentDisplayTimers(): void {
  for (const timer of transientTimers.values()) clearTimeout(timer);
  for (const timer of transientAnimationTimers.values()) clearTimeout(timer);
  for (const timer of statusBadgeTimers.values()) clearTimeout(timer);
  transientTimers.clear();
  transientAnimationTimers.clear();
  statusBadgeTimers.clear();
  transientDisplays.clear();
  statusBadges.clear();
}

function setStatusBadge(petId: string, reaction: OpenPetsReaction): void {
  if (reaction === "idle") {
    clearStatusBadge(petId);
    return;
  }

  statusBadges.set(petId, reaction);
  debug("pet.agent", "status badge set", { petId, reaction, durationMs: isBusyStatusBadgeReaction(reaction) ? busyStatusBadgeMs : transientDisplayMs });
  const existingTimer = statusBadgeTimers.get(petId);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    clearStatusBadge(petId);
    const window = agentPetWindows.get(petId);
    if (window && !window.isDestroyed()) {
      const display = transientDisplays.get(petId) ?? null;
      void loadExplicitPetContent(window, petId, display, null, getCurrentDismissToken(petId, display, null), getPreferredPetScale());
    }
  }, isBusyStatusBadgeReaction(reaction) ? busyStatusBadgeMs : transientDisplayMs);
  statusBadgeTimers.set(petId, timer);
}

function clearStatusBadge(petId: string): void {
  if (statusBadges.has(petId)) debug("pet.agent", "status badge cleared", { petId, reaction: statusBadges.get(petId) });
  statusBadges.delete(petId);
  const timer = statusBadgeTimers.get(petId);
  if (timer) clearTimeout(timer);
  statusBadgeTimers.delete(petId);
}

function isBusyStatusBadgeReaction(reaction: OpenPetsReaction): boolean {
  return reaction === "thinking" || reaction === "working" || reaction === "editing" || reaction === "running" || reaction === "testing" || reaction === "waiting";
}

function getCurrentDismissToken(petId: string, display: PetTransientDisplay | null, badge: PetStatusBadgeReaction | null): string | undefined {
  return display?.dismissToken ?? (badge ? String(displayGenerations.get(petId) ?? 0) : undefined);
}

function getPreferredPetScale(): PetScaleValue {
  return getAppStateSnapshot().preferences.petScale as PetScaleValue;
}
