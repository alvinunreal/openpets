import { BrowserWindow } from "electron";

import { getAppStateSnapshot, type PetScaleValue } from "./app-state.js";
import { clampToVisibleWorkArea, defaultPetWindowSize, getDefaultPetInitialPosition } from "./display.js";
import { debug, info, warn } from "./logger.js";
import { planLanPetPresence, resolveRenderableLanPetId } from "./lan-pet-presence.js";
import type { LanPetRecord, LanPoint } from "./lan-state.js";
import { createAgentPetWindow, getTransientDisplayDurationMs, loadExplicitPetContent, readWindowPosition } from "./pet-window.js";
import type { OpenPetsReaction } from "./local-ipc-protocol.js";
import { registerRoamingPet, unregisterRoamingPet } from "./pet-roaming-controller.js";

type VisitingPetWindow = {
  readonly ownerHost: string;
  readonly requestedPetId: string;
  readonly renderedPetId: string;
  readonly motionHandleId: string;
  readonly window: BrowserWindow;
};

const visitingPetWindows = new Map<string, VisitingPetWindow>();
const dismissedOwnerHosts = new Set<string>();
const unavailablePetWarnings = new Set<string>();
const displayClearTimers = new Map<string, NodeJS.Timeout>();

export function syncLanVisitingPets(localHost: string, pets: readonly LanPetRecord[]): void {
  const plan = planLanPetPresence(localHost, pets, [...visitingPetWindows.keys()]);
  const desiredOwners = new Set(plan.show.map((pet) => pet.ownerHost));
  for (const ownerHost of [...dismissedOwnerHosts]) {
    if (!desiredOwners.has(ownerHost)) dismissedOwnerHosts.delete(ownerHost);
  }
  for (const ownerHost of [...unavailablePetWarnings]) {
    if (!desiredOwners.has(ownerHost)) unavailablePetWarnings.delete(ownerHost);
  }
  for (const ownerHost of plan.closeOwnerHosts) {
    closeLanVisitingPet(ownerHost);
  }
  for (const pet of plan.show) showLanVisitingPet(pet);
}

export function getLanVisitingPetPosition(ownerHost: string): LanPoint | null {
  const entry = visitingPetWindows.get(ownerHost);
  if (!entry || entry.window.isDestroyed() || !entry.window.isVisible()) return null;
  return readWindowPosition(entry.window);
}

export function closeAllLanVisitingPets(): void {
  for (const ownerHost of [...visitingPetWindows.keys()]) closeLanVisitingPet(ownerHost);
  dismissedOwnerHosts.clear();
  unavailablePetWarnings.clear();
}

export function applyLanVisitingPetSay(ownerHost: string, message: string, reaction: OpenPetsReaction, sequence: number): boolean {
  const entry = visitingPetWindows.get(ownerHost);
  if (!entry || entry.window.isDestroyed()) return false;
  const existingTimer = displayClearTimers.get(ownerHost);
  if (existingTimer) clearTimeout(existingTimer);
  const display = { message, reaction, suppressReactionMessage: true, dismissToken: `lan-work:${ownerHost}:${sequence}` };
  void loadExplicitPetContent(entry.window, entry.renderedPetId, display, null, display.dismissToken, getAppStateSnapshot().preferences.petScale as PetScaleValue);
  const timer = setTimeout(() => {
    displayClearTimers.delete(ownerHost);
    const current = visitingPetWindows.get(ownerHost);
    if (current && !current.window.isDestroyed()) void loadExplicitPetContent(current.window, current.renderedPetId);
  }, getTransientDisplayDurationMs(display));
  timer.unref?.();
  displayClearTimers.set(ownerHost, timer);
  return true;
}

export function reclampLanVisitingPetWindows(): void {
  for (const entry of visitingPetWindows.values()) {
    if (entry.window.isDestroyed()) continue;
    const safe = readWindowPosition(entry.window);
    const [x, y] = entry.window.getPosition();
    if (safe.x !== x || safe.y !== y) entry.window.setPosition(safe.x, safe.y, false);
  }
}

function showLanVisitingPet(pet: LanPetRecord): void {
  if (dismissedOwnerHosts.has(pet.ownerHost)) return;
  const state = getAppStateSnapshot();
  const renderedPetId = resolveRenderableLanPetId(pet.petId, state.pets.installed);
  if (!renderedPetId) {
    if (!unavailablePetWarnings.has(pet.ownerHost)) {
      unavailablePetWarnings.add(pet.ownerHost);
      warn("pet.agent", "lan visiting pet unavailable", { ownerHost: pet.ownerHost, petId: pet.petId });
    }
    closeLanVisitingPet(pet.ownerHost);
    return;
  }
  unavailablePetWarnings.delete(pet.ownerHost);

  const existing = visitingPetWindows.get(pet.ownerHost);
  if (existing && !existing.window.isDestroyed() && existing.renderedPetId === renderedPetId) {
    existing.window.showInactive();
    return;
  }
  if (existing) closeLanVisitingPet(pet.ownerHost);

  const installed = state.pets.installed.find((candidate) => candidate.id === renderedPetId);
  if (!installed) return;
  const offset = visitingPetWindows.size + 1;
  const base = getDefaultPetInitialPosition(defaultPetWindowSize);
  const position = clampToVisibleWorkArea({ x: base.x - offset * 48, y: base.y - offset * 28 }, defaultPetWindowSize);
  const motionHandleId = `lan:${pet.ownerHost}`;
  const window = createAgentPetWindow({
    petId: renderedPetId,
    displayName: `${installed.displayName} — ${pet.ownerHost}`,
    scale: state.preferences.petScale as PetScaleValue,
    position,
    display: null,
    badge: null,
    plainContextMenu: true,
    onCloseRequested: () => {
      dismissedOwnerHosts.add(pet.ownerHost);
      closeLanVisitingPet(pet.ownerHost);
    },
  });
  const entry: VisitingPetWindow = {
    ownerHost: pet.ownerHost,
    requestedPetId: pet.petId,
    renderedPetId,
    motionHandleId,
    window,
  };
  visitingPetWindows.set(pet.ownerHost, entry);
  window.once("closed", () => {
    const current = visitingPetWindows.get(pet.ownerHost);
    if (current?.window !== window) return;
    unregisterRoamingPet(motionHandleId);
    visitingPetWindows.delete(pet.ownerHost);
  });
  window.showInactive();
  registerRoamingPet(motionHandleId, () => {
    const current = visitingPetWindows.get(pet.ownerHost);
    return current?.window && !current.window.isDestroyed() ? current.window : null;
  });
  info("pet.agent", "lan visiting pet shown", { ownerHost: pet.ownerHost, requestedPetId: pet.petId, renderedPetId, windowId: window.id });
}

function closeLanVisitingPet(ownerHost: string): void {
  const displayTimer = displayClearTimers.get(ownerHost);
  if (displayTimer) clearTimeout(displayTimer);
  displayClearTimers.delete(ownerHost);
  const entry = visitingPetWindows.get(ownerHost);
  if (!entry) return;
  visitingPetWindows.delete(ownerHost);
  unregisterRoamingPet(entry.motionHandleId);
  if (!entry.window.isDestroyed()) {
    debug("pet.agent", "lan visiting pet close", { ownerHost, petId: entry.renderedPetId, windowId: entry.window.id });
    entry.window.destroy();
  }
}
