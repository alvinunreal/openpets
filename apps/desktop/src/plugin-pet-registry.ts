import { BrowserWindow } from "electron";

import { getAppStateSnapshot, type PetScaleValue } from "./app-state.js";
import { applyExternalPetReaction, applyExternalPetStatusReaction, getDefaultPetPaused, getDefaultPetWindowForPlugins, defaultPetBubbleArbiter } from "./default-pet-controller.js";
import { clampToNearestDisplayIfOffscreen, clampToVisibleWorkArea, defaultPetWindowSize, getDefaultPetInitialPosition, isCrossDisplayRoamingEnabled, type Point } from "./display.js";
import { builtInPet } from "./built-in-pet.js";
import { debug, info } from "./logger.js";
import type { OpenPetsReaction } from "./local-ipc-protocol.js";
import { motionMoveTo, motionSetFollowCursor, motionSetPhysics, motionStop, type WindowAccessor } from "./pet-motion-engine.js";
import { createAgentPetWindow, isPetWindowDragging, loadExplicitPetContent, readWindowPosition, setPetReactionState, setPetSpriteOverride, setPetWindowScale, type PetPluginBubbles, type PetStatusBadgeReaction } from "./pet-window.js";
import { PetBubbleArbiter, type PetBubbleSink } from "./plugin-bubble-arbiter.js";
import { publishPluginPetEvent } from "./plugin-events-source.js";
import { resolveReactionSpriteState } from "./reaction-animation-mapping.js";
import type { PluginAnimationSpec, PluginPetInfo, PluginPetState } from "./plugin-sdk-bridge.js";

/**
 * Multi-pet registry (§4): addressable pet handles for plugins. "default" is
 * the user's default pet; plugin-spawned pets get their own windows, bubble
 * arbiters, and liveness loops, and are torn down with their owning plugin.
 */

type SpawnedPet = {
  readonly handleId: string;
  readonly ownerPluginId: string;
  readonly petId: string;
  readonly name: string;
  window: BrowserWindow | null;
  readonly arbiter: PetBubbleArbiter;
  bubbles: PetPluginBubbles;
  statusReaction: PetStatusBadgeReaction | null;
  currentAnimation: string;
  spriteOverride: { filePath: string; fps: number; loop: boolean } | null;
  scale: PetScaleValue;
  reactionRevert: NodeJS.Timeout | null;
};

const spawnedPets = new Map<string, SpawnedPet>();
const changeListeners = new Set<(pets: PluginPetInfo[]) => void>();
const tickSubscribers = new Map<string, Set<(dtMs: number) => void>>();
const tickLoops = new Map<string, { timer: NodeJS.Timeout; lastAt: number }>();
const tickIntervalMs = 100;
let nextSpawnId = 0;
let defaultAnimation = "idle";

function windowAccessor(petHandleId: string): WindowAccessor {
  if (petHandleId === "default") return getDefaultPetWindowForPlugins;
  return () => {
    const pet = spawnedPets.get(petHandleId);
    return pet?.window && !pet.window.isDestroyed() ? pet.window : null;
  };
}

function requireWindow(petHandleId: string): BrowserWindow {
  const window = windowAccessor(petHandleId)();
  if (!window) throw new Error(`Pet is not available: ${petHandleId}`);
  return window;
}

function notifyChange(): void {
  const pets = listPluginPets();
  for (const listener of changeListeners) { try { listener(pets); } catch { /* listener errors are isolated */ } }
}

export function listPluginPets(): PluginPetInfo[] {
  const state = getAppStateSnapshot();
  const defaultName = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId)?.displayName ?? "Default pet";
  const out: PluginPetInfo[] = [{ id: "default", name: defaultName, kind: "default", visible: getDefaultPetWindowForPlugins()?.isVisible() ?? false }];
  for (const pet of spawnedPets.values()) {
    out.push({ id: pet.handleId, name: pet.name, kind: "plugin", visible: pet.window !== null && !pet.window.isDestroyed() && pet.window.isVisible() });
  }
  return out;
}

export function onPluginPetsChange(listener: (pets: PluginPetInfo[]) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function refreshSpawnedPet(pet: SpawnedPet): void {
  if (!pet.window || pet.window.isDestroyed()) return;
  void loadExplicitPetContent(pet.window, pet.petId, null, pet.statusReaction, undefined, pet.scale, pet.bubbles.transient || pet.bubbles.pinned ? pet.bubbles : null).then(() => {
    if (!pet.window || pet.window.isDestroyed()) return;
    if (pet.spriteOverride) {
      setPetSpriteOverride(pet.window, pet.spriteOverride);
      return;
    }
    if (pet.currentAnimation !== "idle" && pet.currentAnimation !== "sprite") {
      const spriteState = resolveReactionSpriteState(pet.currentAnimation as OpenPetsReaction, getAppStateSnapshot().preferences.reactionAnimationOverrides);
      setPetReactionState(pet.window, spriteState);
    }
  });
}

export async function spawnPluginPet(opts: { pluginId: string; petId: string; name?: string; position?: Point }): Promise<string> {
  const state = getAppStateSnapshot();
  const installed = state.pets.installed.find((pet) => pet.id === opts.petId);
  if (!installed || installed.broken || installed.id === builtInPet.id) throw new Error(`Pet is not installed or cannot be spawned: ${opts.petId}`);
  const handleId = `plugin-pet-${++nextSpawnId}`;
  const base = getDefaultPetInitialPosition(defaultPetWindowSize);
  const offset = (spawnedPets.size + 1) * 60;
  const rawPos = opts.position ?? { x: base.x - offset, y: base.y };
  const position = isCrossDisplayRoamingEnabled()
    ? clampToNearestDisplayIfOffscreen(rawPos, defaultPetWindowSize)
    : clampToVisibleWorkArea(rawPos, defaultPetWindowSize);

  const pet: SpawnedPet = {
    handleId,
    ownerPluginId: opts.pluginId,
    petId: opts.petId,
    name: opts.name ?? installed.displayName,
    window: null,
    arbiter: null as unknown as PetBubbleArbiter,
    bubbles: { transient: null, pinned: null },
    statusReaction: null,
    currentAnimation: "idle",
    spriteOverride: null,
    scale: state.preferences.petScale as PetScaleValue,
    reactionRevert: null,
  };
  const sink: PetBubbleSink = {
    present(slot, content) {
      pet.bubbles = slot === "pinned" ? { ...pet.bubbles, pinned: content } : { ...pet.bubbles, transient: content };
      refreshSpawnedPet(pet);
    },
  };
  (pet as { arbiter: PetBubbleArbiter }).arbiter = new PetBubbleArbiter(sink);

  const window = createAgentPetWindow({
    petId: opts.petId,
    displayName: pet.name,
    scale: pet.scale,
    position,
    display: null,
    badge: null,
    onCloseRequested: () => closePluginPet(opts.pluginId, handleId, true),
    onBubbleDismissed: (token) => { if (PetBubbleArbiter.isArbiterToken(token)) pet.arbiter.handleDismissed(token); },
    onBubbleAction: (token, actionId) => pet.arbiter.handleAction(token, actionId),
    onBubbleSubmit: (token, values) => pet.arbiter.handleSubmit(token, values),
    onPetEvent: (name, payload) => publishPluginPetEvent(handleId, name, payload),
    onWindowReplaced: (replacement) => {
      pet.window = replacement;
      replacement.once("closed", () => { if (pet.window === replacement) pet.window = null; });
      refreshSpawnedPet(pet);
    },
  });
  pet.window = window;
  window.once("closed", () => { if (pet.window === window) pet.window = null; });
  window.showInactive();
  spawnedPets.set(handleId, pet);
  info("plugin", "plugin pet spawned", { handleId, petId: opts.petId, pluginId: opts.pluginId });
  notifyChange();
  return handleId;
}

export async function closePluginPet(pluginId: string, petHandleId: string, force = false): Promise<void> {
  const pet = spawnedPets.get(petHandleId);
  if (!pet) return;
  if (!force && pet.ownerPluginId !== pluginId) throw new Error("Plugins may only close pets they spawned.");
  spawnedPets.delete(petHandleId);
  motionStop(petHandleId);
  stopTicker(petHandleId);
  if (pet.reactionRevert) clearTimeout(pet.reactionRevert);
  pet.arbiter.clearPlugin(pet.ownerPluginId);
  if (pet.window && !pet.window.isDestroyed()) pet.window.destroy();
  info("plugin", "plugin pet closed", { petHandleId, pluginId });
  notifyChange();
}

/** Tear down everything a plugin spawned or animated (plugin stop/reload). */
export function clearPluginPetsForPlugin(pluginId: string): void {
  for (const pet of [...spawnedPets.values()]) {
    if (pet.ownerPluginId === pluginId) void closePluginPet(pluginId, pet.handleId, true);
  }
  defaultPetBubbleArbiter.clearPlugin(pluginId);
}

export function showPluginPet(petHandleId: string): void {
  if (petHandleId === "default") { import("./default-pet-controller.js").then(({ showDefaultPet }) => showDefaultPet()).catch(() => undefined); notifyChange(); return; }
  requireWindow(petHandleId).showInactive();
  notifyChange();
}

export function hidePluginPet(petHandleId: string): void {
  if (petHandleId === "default") { import("./default-pet-controller.js").then(({ hideDefaultPet }) => hideDefaultPet()).catch(() => undefined); notifyChange(); return; }
  requireWindow(petHandleId).hide();
  notifyChange();
}

export function reactPluginPet(petHandleId: string, reaction: OpenPetsReaction, options: { readonly showMessage?: boolean } = {}): void {
  if (petHandleId === "default") { applyExternalPetReaction(reaction, options); defaultAnimation = String(reaction); return; }
  const pet = spawnedPets.get(petHandleId);
  if (!pet) throw new Error(`Pet is not available: ${petHandleId}`);
  applySpawnedPetAnimation(pet, { kind: "reaction", reaction });
}

export function setPluginPetAnimation(petHandleId: string, spec: PluginAnimationSpec): void {
  if (petHandleId === "default") {
    const window = requireWindow("default");
    if (spec.kind === "reaction") {
      applyExternalPetReaction(spec.reaction);
      setPetSpriteOverride(window, null);
      defaultAnimation = String(spec.reaction);
    } else {
      setPetSpriteOverride(window, { filePath: spec.spritePath, fps: spec.fps, loop: spec.loop });
      defaultAnimation = "sprite";
    }
    return;
  }
  const pet = spawnedPets.get(petHandleId);
  if (!pet) throw new Error(`Pet is not available: ${petHandleId}`);
  applySpawnedPetAnimation(pet, spec);
}

function applySpawnedPetAnimation(pet: SpawnedPet, spec: PluginAnimationSpec): void {
  if (!pet.window || pet.window.isDestroyed()) throw new Error(`Pet is not available: ${pet.handleId}`);
  if (pet.reactionRevert) { clearTimeout(pet.reactionRevert); pet.reactionRevert = null; }
  if (spec.kind === "reaction") {
    pet.spriteOverride = null;
    setPetSpriteOverride(pet.window, null);
    const spriteState = resolveReactionSpriteState(spec.reaction, getAppStateSnapshot().preferences.reactionAnimationOverrides);
    setPetReactionState(pet.window, spriteState);
    pet.currentAnimation = String(spec.reaction);
    pet.reactionRevert = setTimeout(() => {
      pet.reactionRevert = null;
      if (pet.window && !pet.window.isDestroyed()) setPetReactionState(pet.window, "idle");
      pet.currentAnimation = "idle";
    }, 4_000);
    pet.reactionRevert.unref?.();
  } else {
    pet.spriteOverride = { filePath: spec.spritePath, fps: spec.fps, loop: spec.loop };
    setPetSpriteOverride(pet.window, pet.spriteOverride);
    pet.currentAnimation = "sprite";
  }
}

export function setPluginPetScale(petHandleId: string, scale: number): void {
  setPetWindowScale(requireWindow(petHandleId), scale);
  const pet = spawnedPets.get(petHandleId);
  if (pet) pet.scale = scale as PetScaleValue;
}

export function setPluginPetStatusReaction(petHandleId: string, reaction: OpenPetsReaction | null): void {
  if (petHandleId === "default") {
    applyExternalPetStatusReaction(reaction);
    return;
  }
  const pet = spawnedPets.get(petHandleId);
  if (!pet) throw new Error(`Pet is not available: ${petHandleId}`);
  pet.statusReaction = reaction === null || reaction === "idle" ? null : reaction as PetStatusBadgeReaction;
  refreshSpawnedPet(pet);
}

export async function movePluginPetBy(petHandleId: string, opts: { x: number; y: number; durationMs?: number }): Promise<void> {
  const window = requireWindow(petHandleId);
  const [x, y] = window.getPosition();
  const distance = Math.min(Math.hypot(opts.x, opts.y), 160);
  const scale = distance > 0 ? distance / Math.hypot(opts.x, opts.y) : 0;
  await motionMoveTo(petHandleId, windowAccessor(petHandleId), { x: x + opts.x * scale, y: y + opts.y * scale }, { durationMs: opts.durationMs ?? 700 });
}

export async function wanderPluginPet(petHandleId: string, opts: { distance?: number; durationMs?: number }): Promise<void> {
  const distance = Math.min(Math.max(opts.distance ?? 80, 0), 160);
  const angle = Math.random() * Math.PI * 2;
  await movePluginPetBy(petHandleId, { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance, durationMs: opts.durationMs });
}

export async function movePluginPetToHome(petHandleId: string): Promise<void> {
  const home = getDefaultPetInitialPosition(defaultPetWindowSize);
  await motionMoveTo(petHandleId, windowAccessor(petHandleId), home, { durationMs: 1_200 });
}

export async function movePluginPetTo(petHandleId: string, point: Point, opts: { durationMs?: number; easing?: string } = {}): Promise<void> {
  requireWindow(petHandleId);
  await motionMoveTo(petHandleId, windowAccessor(petHandleId), point, opts);
}

export function setPluginPetFollowCursor(petHandleId: string, opts: { enabled: boolean; lag?: number }): void {
  requireWindow(petHandleId);
  motionSetFollowCursor(petHandleId, windowAccessor(petHandleId), opts);
}

export function setPluginPetPhysics(petHandleId: string, opts: { gravity?: boolean; bounce?: number }): void {
  requireWindow(petHandleId);
  motionSetPhysics(petHandleId, windowAccessor(petHandleId), opts);
}

export function getPluginPetState(petHandleId: string): PluginPetState {
  const window = requireWindow(petHandleId);
  const [x, y] = window.getPosition();
  const [width, height] = window.getSize();
  const pet = spawnedPets.get(petHandleId);
  return {
    position: { x, y },
    bounds: { x, y, width, height },
    currentAnimation: petHandleId === "default" ? (getDefaultPetPaused() ? "paused" : defaultAnimation) : pet?.currentAnimation ?? "idle",
    visible: window.isVisible(),
    dragging: isPetWindowDragging(window),
  };
}

/** Host-driven behavior loop: throttled, auto-paused while hidden/dragging. */
export function onPluginPetTick(petHandleId: string, handler: (dtMs: number) => void): () => void {
  let subscribers = tickSubscribers.get(petHandleId);
  if (!subscribers) { subscribers = new Set(); tickSubscribers.set(petHandleId, subscribers); }
  subscribers.add(handler);
  if (!tickLoops.has(petHandleId)) {
    const loop = { timer: null as unknown as NodeJS.Timeout, lastAt: Date.now() };
    loop.timer = setInterval(() => {
      const window = windowAccessor(petHandleId)();
      const now = Date.now();
      if (!window || window.isDestroyed() || !window.isVisible() || isPetWindowDragging(window)) { loop.lastAt = now; return; }
      const dt = now - loop.lastAt;
      loop.lastAt = now;
      const live = tickSubscribers.get(petHandleId);
      if (!live || live.size === 0) return;
      for (const subscriber of live) { try { subscriber(dt); } catch { /* isolated upstream */ } }
    }, tickIntervalMs);
    loop.timer.unref?.();
    tickLoops.set(petHandleId, loop);
  }
  return () => {
    const live = tickSubscribers.get(petHandleId);
    live?.delete(handler);
    if (live && live.size === 0) stopTicker(petHandleId);
  };
}

function stopTicker(petHandleId: string): void {
  const loop = tickLoops.get(petHandleId);
  if (loop) { clearInterval(loop.timer); tickLoops.delete(petHandleId); }
  tickSubscribers.delete(petHandleId);
}

/** Show a plugin bubble on a pet surface (the bubbles capability entry point). */
export function getPluginPetArbiter(petHandleId: string): PetBubbleArbiter {
  if (petHandleId === "default") return defaultPetBubbleArbiter;
  const pet = spawnedPets.get(petHandleId);
  if (!pet) throw new Error(`Pet is not available: ${petHandleId}`);
  return pet.arbiter;
}

export function reclampPluginPetWindows(): void {
  for (const pet of spawnedPets.values()) {
    const { window } = pet;
    if (!window || window.isDestroyed()) continue;
    const [cx, cy] = window.getPosition();
    const safe = readWindowPosition(window);
    if (safe.x !== cx || safe.y !== cy) window.setPosition(safe.x, safe.y, false);
  }
}

export function closeAllPluginPets(): void {
  for (const pet of [...spawnedPets.values()]) void closePluginPet(pet.ownerPluginId, pet.handleId, true);
  debug("plugin", "all plugin pets closed");
}
