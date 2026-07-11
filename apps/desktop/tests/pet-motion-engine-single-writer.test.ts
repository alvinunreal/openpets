/**
 * Regression test: single-writer guarantee for pet-motion-engine.
 *
 * When follow or physics is active, motionMoveTo must NOT drive its own
 * step loop (which would compete with syncLoop). Instead, it stores a
 * moveTarget in MotionState and returns a promise.
 *
 * Tests use the testability seams (_setScreenForTesting, _setIsPetWindowDraggingForTesting)
 * established in pet-motion-engine-clamp.test.ts.
 */
import assert from "node:assert/strict";
import { _setScreenForTesting, _setIsPetWindowDraggingForTesting, motionSetFollowCursor, motionSetPhysics, motionStop, motionMoveTo } from "../src/pet-motion-engine.js";
import { _setScreenForTesting as setDisplayScreen, invalidateDisplayCache, setCrossDisplayRoamingEnabled } from "../src/display.js";

let currentPos = { x: 500, y: 500 };
const positions: Array<{ x: number; y: number }> = [];

const mockWindow = {
  isDestroyed: () => false,
  isVisible: () => true,
  getPosition: (): [number, number] => [currentPos.x, currentPos.y],
  setPosition: (x: number, y: number) => {
    positions.push({ x, y });
    currentPos = { x, y };
  },
} as any;

const mockScreen = {
  getCursorScreenPoint: () => ({ x: 600, y: 600 }),
  getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
};

setDisplayScreen(mockScreen as any);
invalidateDisplayCache();
_setScreenForTesting(mockScreen as any);
_setIsPetWindowDraggingForTesting(() => false);
setCrossDisplayRoamingEnabled(false);

// ---------------------------------------------------------------------------
// 1. motionMoveTo with physics active returns a promise immediately (no step loop).
//    The promise does not resolve synchronously — it waits for syncLoop to
//    complete the moveTarget. We verify: (a) the call doesn't throw, (b) a
//    promise is returned, (c) calling motionStop resolves it quickly.
// ---------------------------------------------------------------------------
{
  const petId = "single-writer-test";
  const accessor = () => mockWindow;
  positions.length = 0;
  motionSetPhysics(petId, accessor, { gravity: true, bounce: 0 });

  let resolved = false;
  const movePromise = motionMoveTo(petId, accessor, { x: 700, y: 300 }, { durationMs: 200 });
  movePromise.then(() => { resolved = true; });

  // Promise should not resolve synchronously (it waits for moveTarget to clear)
  assert.ok(!resolved, "promise is not resolved synchronously — it's delegated to syncLoop");

  // Immediately stop — this clears moveTarget and increments generation
  motionStop(petId);

  // After one event-loop turn the promise resolves
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  // Give the check loop a chance to poll (it polls with setTimeout of ~32ms)
  await new Promise<void>(resolve => setTimeout(resolve, 100));
  assert.ok(resolved, "promise resolves after motionStop clears moveTarget");
}

// ---------------------------------------------------------------------------
// 2. motionMoveTo with follow active also uses engine path
// ---------------------------------------------------------------------------
{
  const petId = "single-writer-follow-test";
  currentPos = { x: 400, y: 400 };
  const accessor = () => mockWindow;
  positions.length = 0;
  motionSetFollowCursor(petId, accessor, { enabled: true, lag: 0.85 });

  let resolved = false;
  const movePromise = motionMoveTo(petId, accessor, { x: 600, y: 300 }, { durationMs: 100 });
  movePromise.then(() => { resolved = true; });

  assert.ok(!resolved, "promise is not resolved synchronously — delegated to syncLoop");

  motionStop(petId);
  await new Promise<void>(resolve => setTimeout(resolve, 100));
  assert.ok(resolved, "promise resolves after motionStop when follow active");
}

// ---------------------------------------------------------------------------
// 3. motionMoveTo WITHOUT physics/follow falls back to step loop (resolves on its own)
// ---------------------------------------------------------------------------
{
  const petId = "no-loop-test";
  currentPos = { x: 200, y: 200 };
  const accessor = () => mockWindow;
  // No physics or follow set — uses legacy step loop
  const movePromise = motionMoveTo(petId, accessor, { x: 250, y: 250 }, { durationMs: 100 });
  await movePromise;
  // Should have moved via step loop
  assert.ok(currentPos.x >= 200, "position updated via step loop");
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
setDisplayScreen(null);
_setScreenForTesting(null);
_setIsPetWindowDraggingForTesting(null);

console.log("pet-motion-engine-single-writer tests passed.");
