import { createRequire } from "node:module";

import type { BrowserWindow } from "electron";

import { clampToTerminalBounds, getEffectiveConfinementBounds } from "./confinement-manager.js";
import { clampToNearestDisplayIfOffscreen, clampToVisibleWorkArea, defaultPetWindowSize, isCrossDisplayRoamingEnabled, type Point } from "./display.js";
// isPetWindowDragging is lazily loaded via _setIsPetWindowDraggingForTesting seam

// ---------------------------------------------------------------------------
// Testability seams — allow unit tests to inject mock implementations without
// requiring a running Electron process.
// Same pattern as setConfinementEnabled() in confinement-manager.ts.
// ---------------------------------------------------------------------------

interface ScreenImpl {
  getCursorScreenPoint(): { x: number; y: number };
  getDisplayNearestPoint(point: { x: number; y: number }): { workArea: { x: number; y: number; width: number; height: number } };
}
type IsPetWindowDraggingFn = (win: BrowserWindow) => boolean;

// createRequire restores a working `require` in this ESM module so the lazy
// electron / pet-window loads below succeed at runtime (the production bundle
// runs as ESM where the CommonJS `require` global is not defined).
const require = createRequire(import.meta.url);

// Lazily loaded — avoids a hard electron import at module-load time so that
// unit tests can call _setScreenForTesting() without requiring Electron.
let _screen: ScreenImpl | null = null;
// Lazily loaded — same rationale as _screen above.
let _isPetWindowDragging: IsPetWindowDraggingFn | null = null;

function getIsPetWindowDragging(): IsPetWindowDraggingFn {
  if (!_isPetWindowDragging) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isPetWindowDragging } = require("./pet-window.js") as { isPetWindowDragging: IsPetWindowDraggingFn };
    _isPetWindowDragging = isPetWindowDragging;
  }
  return _isPetWindowDragging;
}

function getScreen(): ScreenImpl {
  if (!_screen) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { screen } = require("electron") as { screen: ScreenImpl };
    _screen = screen;
  }
  return _screen;
}

/** ONLY call from unit tests. Pass null to restore the real electron screen. */
export function _setScreenForTesting(impl: ScreenImpl | null): void {
  _screen = impl;
}

/** ONLY call from unit tests. Pass null to restore the real implementation. */
export function _setIsPetWindowDraggingForTesting(fn: IsPetWindowDraggingFn | null): void {
  _isPetWindowDragging = fn;
}

/** ONLY call from unit tests. Returns whether the shared ticker is currently running. */
export function _sharedTickerActiveForTesting(): boolean {
  return sharedTicker !== null;
}

/** ONLY call from unit tests. Resets the motionStates map (for test isolation). */
export function _resetMotionStatesForTesting(): void {
  motionStates.clear();
  stopSharedTicker();
}

/** ONLY call from unit tests. Returns the pet's current physics state, or null if the pet is
 *  unknown or has no physics active (gravity false / motionSetPhysics({gravity:false})). */
export function _getPhysicsForTesting(petHandleId: string): { gravity: boolean; bounce: number; vy: number } | null {
  return motionStates.get(petHandleId)?.state.physics ?? null;
}

/**
 * Liveness motion primitives (§13.6): animated absolute moves, continuous
 * cursor following with lag, and lightweight gravity/bounce physics. Operates
 * on any pet window through an accessor (windows can be recreated), one loop
 * per surface, paused while hidden or being dragged.
 */

export type WindowAccessor = () => BrowserWindow | null;

type MotionState = {
  follow: { lag: number } | null;
  physics: { gravity: boolean; bounce: number; vy: number } | null;
  loop: NodeJS.Timeout | null;
  moveGeneration: number;
  /** Active move-to interpolation target. Null when idle. */
  moveTarget: { x: number; y: number; startX: number; startY: number; elapsed: number; durationMs: number; easing: string } | null;
  /** Sub-pixel fractional accumulator to prevent rounding-induced stall. */
  fracX: number;
  fracY: number;
};

const motionStates = new Map<string, { accessor: WindowAccessor; state: MotionState }>();
const loopIntervalMs = 16;

// Shared ticker — one interval for all pets
let sharedTicker: NodeJS.Timeout | null = null;

function startSharedTicker(): void {
  if (sharedTicker) return;
  sharedTicker = setInterval(tickAll, loopIntervalMs);
  sharedTicker.unref?.();
}

function stopSharedTicker(): void {
  if (sharedTicker) { clearInterval(sharedTicker); sharedTicker = null; }
}

function needsSharedTicker(state: MotionState): boolean {
  return state.follow !== null || state.physics !== null || state.moveTarget !== null;
}

function tickAll(): void {
  for (const [petHandleId, { accessor, state }] of motionStates) {
    if (!needsSharedTicker(state)) continue;
    tickPet(petHandleId, accessor, state);
  }
  // Stop ticker when no pet needs continuous or delegated move-to motion.
  if ([...motionStates.values()].every(({ state }) => !needsSharedTicker(state))) {
    stopSharedTicker();
  }
}

function stateFor(petHandleId: string, accessor: WindowAccessor): MotionState {
  let entry = motionStates.get(petHandleId);
  if (!entry) {
    entry = { accessor, state: { follow: null, physics: null, loop: null, moveGeneration: 0, moveTarget: null, fracX: 0, fracY: 0 } };
    motionStates.set(petHandleId, entry);
  }
  entry.accessor = accessor;
  return entry.state;
}

function easeProgress(t: number, easing: string): number {
  if (easing === "linear") return t;
  if (easing === "ease-in") return t * t;
  if (easing === "ease-out") return 1 - (1 - t) * (1 - t);
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out
}

/**
 * Register a pet window accessor with the motion engine.
 * Call when a new pet window is shown/created (before starting motion).
 */
export function registerPet(petHandleId: string, accessor: WindowAccessor): void {
  stateFor(petHandleId, accessor); // ensures entry exists, updates accessor
}

/**
 * Unregister a pet and stop its motion. Call before destroying the pet window.
 * Safe to call if petHandleId is not registered.
 */
export function unregisterPet(petHandleId: string): void {
  motionStop(petHandleId);
  motionStates.delete(petHandleId);
  // Eagerly stop ticker if no remaining pets need motion
  if ([...motionStates.values()].every(({ state }) => !needsSharedTicker(state))) {
    stopSharedTicker();
  }
}

export async function motionMoveTo(petHandleId: string, accessor: WindowAccessor, target: Point, opts: { durationMs?: number; easing?: string } = {}): Promise<void> {
  const state = stateFor(petHandleId, accessor);
  const window = accessor();
  if (!window || window.isDestroyed()) return;
  const generation = ++state.moveGeneration;
  const durationMs = Math.min(Math.max(opts.durationMs ?? 700, 100), 10_000);
  const easing = opts.easing ?? "ease-in-out";

  // If a continuous loop is running (follow or physics), store the target
  // in MotionState and let syncLoop handle interpolation. This avoids the
  // competing-writer race that causes jitter.
  if (state.follow !== null || state.physics !== null) {
    const [reportedStartX, reportedStartY] = window.getPosition();
    const clamped = clampPosition(petHandleId, target);
    // Native coordinates can be transiently unavailable during display changes.
    // Falling back to the already-clamped target keeps the delegated move finite;
    // the next valid tick can then settle it without ever writing NaN.
    const startX = Number.isFinite(reportedStartX) ? reportedStartX : clamped.x;
    const startY = Number.isFinite(reportedStartY) ? reportedStartY : clamped.y;
    state.moveTarget = { x: clamped.x, y: clamped.y, startX, startY, elapsed: 0, durationMs, easing };
    // A move that was delegated while follow/physics was active remains shared-
    // ticker work even if that continuous mode is disabled before it completes.
    startSharedTicker();
    // Return a promise that resolves when the generation changes (move completes or is superseded).
    return new Promise<void>((resolve) => {
      const check = () => {
        if (state.moveGeneration !== generation || state.moveTarget === null) { resolve(); return; }
        setTimeout(check, loopIntervalMs * 2).unref?.();
      };
      check();
    });
  }

  // No continuous loop — drive it ourselves (legacy step loop).
  const [startX, startY] = window.getPosition();
  const clamped = clampPosition(petHandleId, target);
  const steps = Math.max(4, Math.round(durationMs / 33));
  for (let step = 1; step <= steps; step += 1) {
    const live = accessor();
    if (!live || live.isDestroyed() || state.moveGeneration !== generation || getIsPetWindowDragging()(live)) return;
    const t = easeProgress(step / steps, easing);
    const nextX = Math.round(startX + (clamped.x - startX) * t);
    const nextY = Math.round(startY + (clamped.y - startY) * t);
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) return;  // abort move if NaN (e.g. startX was NaN from mid-destroy getPosition)
    live.setPosition(nextX, nextY, false);
    await delay(durationMs / steps);
  }
}

export function motionSetFollowCursor(petHandleId: string, accessor: WindowAccessor, opts: { enabled: boolean; lag?: number }): void {
  const state = stateFor(petHandleId, accessor);
  state.follow = opts.enabled ? { lag: Math.min(Math.max(opts.lag ?? 0.85, 0), 1) } : null;
  syncLoop(petHandleId, accessor, state);
}

export function motionSetPhysics(petHandleId: string, accessor: WindowAccessor, opts: { gravity?: boolean; bounce?: number }): void {
  const state = stateFor(petHandleId, accessor);
  state.physics = opts.gravity ? { gravity: true, bounce: Math.min(Math.max(opts.bounce ?? 0.4, 0), 1), vy: 0 } : null;
  syncLoop(petHandleId, accessor, state);
}

export function motionStop(petHandleId: string): void {
  const entry = motionStates.get(petHandleId);
  if (!entry) return;
  entry.state.follow = null;
  entry.state.physics = null;
  entry.state.moveGeneration += 1;
  entry.state.moveTarget = null;
  entry.state.fracX = 0;
  entry.state.fracY = 0;
  if (entry.state.loop) { clearInterval(entry.state.loop); entry.state.loop = null; }
}

export function motionStopAll(): void {
  for (const petHandleId of motionStates.keys()) motionStop(petHandleId);
}

function syncLoop(petHandleId: string, _accessor: WindowAccessor, state: MotionState): void {
  const wantsLoop = needsSharedTicker(state);
  if (!wantsLoop) {
    // stop.loop field can be removed from MotionState eventually; keep null for now
    if (state.loop) { clearInterval(state.loop); state.loop = null; }
    return;
  }
  // If per-pet loop was somehow set (shouldn't happen), clear it
  if (state.loop) { clearInterval(state.loop); state.loop = null; }
  startSharedTicker();
}

function tickPet(petHandleId: string, accessor: WindowAccessor, state: MotionState): void {
  const window = accessor();
  if (!window || window.isDestroyed()) { unregisterPet(petHandleId); return; }
  // Settle the move-to clock even while hidden/dragging so an awaited
  // motionMoveTo() always completes (its promise resolves on moveGeneration
  // bump / moveTarget clear). We intentionally do NOT write position or apply
  // gravity here, preserving the single-writer model and the gravity clamp.
  if (!window.isVisible() || getIsPetWindowDragging()(window)) {
    if (state.moveTarget) {
      state.moveTarget.elapsed += loopIntervalMs;
      if (state.moveTarget.elapsed >= state.moveTarget.durationMs) {
        state.moveTarget = null;
        state.moveGeneration += 1;
      }
    }
    return;
  }
  const [x, y] = window.getPosition();
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    // Native position is unavailable/NaN (mid-destroy race or monitor disconnect).
    // We cannot write a position this tick, but we still settle the move-to clock
    // so an awaited motionMoveTo() resolves instead of hanging until coordinates
    // become finite again — mirroring the hidden/dragging guard above.
    if (state.moveTarget) {
      state.moveTarget.elapsed += loopIntervalMs;
      if (state.moveTarget.elapsed >= state.moveTarget.durationMs) {
        state.moveTarget = null;
        state.moveGeneration += 1;
      }
    }
    return;
  }
  let rawX = x + state.fracX;
  let rawY = y + state.fracY;

  if (state.follow) {
    const cursor = getScreen().getCursorScreenPoint();
    const targetX = cursor.x - Math.round(defaultPetWindowSize.width / 2);
    const targetY = cursor.y - Math.round(defaultPetWindowSize.height * 0.7);
    const smoothing = 1 - state.follow.lag;
    const factor = Math.max(0.02, smoothing * 0.35);
    rawX += (targetX - rawX) * factor;
    rawY += (targetY - rawY) * factor;
  }

  // moveTarget overrides X (and Y when no physics) — single writer for wander/patrol
  if (state.moveTarget) {
    state.moveTarget.elapsed += loopIntervalMs;
    const progress = Math.min(state.moveTarget.elapsed / state.moveTarget.durationMs, 1);
    const t = easeProgress(progress, state.moveTarget.easing);
    rawX = state.moveTarget.startX + (state.moveTarget.x - state.moveTarget.startX) * t;
    if (!state.physics) {
      rawY = state.moveTarget.startY + (state.moveTarget.y - state.moveTarget.startY) * t;
    }
    if (progress >= 1) {
      state.moveTarget = null;
      state.moveGeneration += 1;
    }
  }

  if (state.physics?.gravity) {
    // Use the geometric center of the pet window for display lookup. This keeps the
    // anchor well inside the work area even when the pet is resting on the floor, so
    // getDisplayNearestPoint returns a stable display. The previous bottom-center anchor
    // (y + petHeight) landed exactly on workArea.y + workArea.height — 1px outside the
    // half-open work area — which triggered an unstable Euclidean nearest-display
    // tie-break at monitor seams and caused rapid floor oscillation between
    // mismatched-height displays. Using the geometric center also aligns with
    // clampToVisibleWorkArea, which already uses the center for display selection.
    const centerX = x + Math.round(defaultPetWindowSize.width / 2);
    const centerY = y + Math.round(defaultPetWindowSize.height / 2);
    const display = getScreen().getDisplayNearestPoint({ x: centerX, y: centerY });
    const confinementBounds = getEffectiveConfinementBounds(petHandleId);
    const floor = computeGravityFloor(confinementBounds, display.workArea.y, display.workArea.height, defaultPetWindowSize.height);
    state.physics.vy = Math.min(state.physics.vy + 2.2, 48);
    rawY = y + state.physics.vy;
    if (rawY >= floor) {
      rawY = floor;
      if (Math.abs(state.physics.vy) > 6 && state.physics.bounce > 0) state.physics.vy = -state.physics.vy * state.physics.bounce;
      else state.physics.vy = 0;
    }
  }

  // Fractional accumulator: carry sub-pixel remainder to next tick
  const nextXFull = rawX;
  const nextYFull = rawY;
  const nextX = Math.round(nextXFull);
  const nextY = Math.round(nextYFull);
  state.fracX = nextXFull - nextX;
  state.fracY = nextYFull - nextY;

  if (nextX !== x || nextY !== y) {
    const clamped = clampPosition(petHandleId, { x: nextX, y: nextY });
    if (!Number.isFinite(clamped.x) || !Number.isFinite(clamped.y)) return;  // skip write when clamp produces NaN (e.g. from NaN workArea on monitor disconnect)
    window.setPosition(clamped.x, clamped.y, false);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clamp a position to the appropriate bounds:
 * - If the pet has active terminal confinement, clamp to terminal bounds.
 * - Otherwise clamp to visible work area (free-roam).
 */
function clampPosition(petHandleId: string, pos: Point): Point {
  const terminalBounds = getEffectiveConfinementBounds(petHandleId);
  if (terminalBounds) return clampToTerminalBounds(pos, defaultPetWindowSize, terminalBounds);
  if (isCrossDisplayRoamingEnabled()) return clampToNearestDisplayIfOffscreen(pos, defaultPetWindowSize);
  return clampToVisibleWorkArea(pos, defaultPetWindowSize);
}

/** Exported for unit testing only — do not call from production code. */
export function _clampPositionForTesting(petHandleId: string, pos: Point): Point {
  return clampPosition(petHandleId, pos);
}

/**
 * Compute the gravity floor y-coordinate for a pet.
 *
 * When the pet is confined to a terminal window (confinementBounds != null), the
 * floor is the bottom interior edge of that terminal (terminal.y + terminal.height
 * - petHeight).  When unconfined the floor falls back to the display work-area
 * bottom (workAreaY + workAreaHeight - petHeight).
 *
 * Exported for unit testing.
 */
export function computeGravityFloor(
  confinementBounds: { y: number; height: number } | null,
  workAreaY: number,
  workAreaHeight: number,
  petHeight: number,
): number {
  if (confinementBounds) {
    return confinementBounds.y + confinementBounds.height - petHeight;
  }
  return workAreaY + workAreaHeight - petHeight;
}
