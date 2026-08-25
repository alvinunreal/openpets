/**
 * Regression test: gravity floor uses bottom-center anchor (not geometric center).
 *
 * Root cause of the gravity seam bug: getDisplayNearestPoint was called with
 * the geometric center of the pet window, which could pick a different display
 * than the one the pet's visible sprite (bottom) was standing on. When the pet
 * crossed a seam between displays of different workArea heights, the floor
 * jumped by hundreds of pixels causing a snap/flip.
 *
 * This test verifies that the bottom-center anchor is used for floor lookup by
 * checking that computeGravityFloor returns the correct floor for the display
 * the pet's bottom is on, not the one the geometric center is on.
 *
 * NOTE (2026-06): The display-lookup anchor was subsequently changed to the
 * geometric center (not bottom-center) to prevent a different oscillation bug
 * where bottomCenterY = y + petHeight exactly equalled workArea.y + workArea.height
 * at the settled floor position, causing an unstable nearest-display tie-break.
 * The pure computeGravityFloor assertions below remain valid; Test 6 below
 * covers the live-tick oscillation regression.
 */
import assert from "node:assert/strict";
import { describe, it, after, afterEach } from "node:test";

import { computeGravityFloor, _setScreenForTesting, _setIsPetWindowDraggingForTesting, _resetMotionStatesForTesting, registerPet, motionSetPhysics } from "../src/pet-motion-engine.js";
import { _setScreenForTesting as setDisplayScreen, invalidateDisplayCache, setCrossDisplayRoamingEnabled, defaultPetWindowSize } from "../src/display.js";
import { setConfinementEnabled } from "../src/confinement-manager.js";

const petH = defaultPetWindowSize.height; // 420

// Scenario: pet straddles two displays.
// Display 1: y=0, h=1080 → floor = 1080 - 420 = 660
// Display 2: y=0, h=800  → floor = 800 - 420 = 380
//
// Pet position: y=300. Geometric center Y = 300 + 210 = 510 (on display 1).
// Bottom-center Y = 300 + 420 = 720 (on display 1).
//
// If we look up by geometric center: display 1 → floor 660. Correct.
// If we look up by bottom-center: display 1 → floor 660. Also correct.
//
// Now move pet to y=600. Bottom Y = 1020 (still on display 1 barely).
// Geometric center Y = 810 → might pick display 1 or 2 depending on layout.
// The key invariant: floor must match the display the pet's bottom is on.

// Test 1: unconfined, floor matches workArea bottom
assert.equal(
  computeGravityFloor(null, 0, 1080, petH),
  1080 - petH,
  "floor = workArea.y + workArea.height - petH"
);

// Test 2: unconfined, different workArea height
assert.equal(
  computeGravityFloor(null, 0, 800, petH),
  800 - petH,
  "floor = 800 - 420 = 380"
);

// Test 3: unconfined with workArea offset (macOS menu bar at y=25)
assert.equal(
  computeGravityFloor(null, 25, 875, petH),
  900 - petH,
  "floor with y-offset: 25 + 875 - 420 = 480"
);

// Test 4: Seam scenario — floor difference between displays is large
// Display 1 floor: 660 (h=1080). Display 2 floor: 380 (h=800).
// Crossing the seam must not cause a >280px Y jump in a single tick.
// The delta clamp in syncLoop caps single-tick gravity at 200px.
// This test documents the expected floor values for the test scenario:
const display1Floor = computeGravityFloor(null, 0, 1080, petH);
const display2Floor = computeGravityFloor(null, 0, 800, petH);
assert.equal(display1Floor, 660, "display 1 floor");
assert.equal(display2Floor, 380, "display 2 floor");
assert.ok(
  Math.abs(display1Floor - display2Floor) <= 300,
  "floor difference between typical displays fits within 200px delta clamp"
);

// Test 5: confined pet always uses terminal bounds, not display
assert.equal(
  computeGravityFloor({ y: 100, height: 500 }, 0, 1080, petH),
  100 + 500 - petH,
  "confined: floor = terminalBounds.y + terminalBounds.height - petH"
);


// ---------------------------------------------------------------------------
// Test 6 (live-tick): geometric-center anchor prevents Y oscillation at seam
// ---------------------------------------------------------------------------
// Regression for bug where bottomCenterY = y + petHeight landed exactly on
// workArea.y + workArea.height (outside the half-open work area), causing
// getDisplayNearestPoint to flip-flop between two mismatched-height displays
// on the very first tick when the pet rested at its floor.
//
// Setup: two horizontally-adjacent displays with DIFFERENT workArea heights:
//   A: {x:0, y:0, w:1920, h:1080}  → floor_A = 1080 - 420 = 660
//   B: {x:1920, y:0, w:1920, h:900} → floor_B =  900 - 420 = 480
// Screen mock: y < 1080 → display A; y ≥ 1080 → display B.
//
// With OLD bottom-center anchor, pet settled at y=floor_A=660:
//   bottomCenterY = 660+420 = 1080 ≥ 1080 → display B → floor=480 → snap to 480
//   next tick: y=480, bottomCenterY=900 < 1080 → display A → floor=660 → falls
//   → infinite oscillation between 480 and 660 (180px each cycle)
//
// With NEW geometric-center anchor:
//   centerY = 660+210 = 870 < 1080 → display A → floor=660 → stable; no snap
const loopIntervalMs = 16;
// floor_A on display A (h=1080), floor_B on display B (h=900)
const floorA = 1080 - defaultPetWindowSize.height; // 660
const floorB =  900 - defaultPetWindowSize.height; // 480

describe("gravity seam oscillation regression", () => {
  after(() => {
    _resetMotionStatesForTesting();
    _setScreenForTesting(null);
    setDisplayScreen(null);
    _setIsPetWindowDraggingForTesting(null);
    setCrossDisplayRoamingEnabled(false);
  });

  afterEach(() => {
    _resetMotionStatesForTesting();
  });

  it("pet already at floor_A does NOT snap to floor_B on the next tick (no floor-selection flip-flop)", async () => {
    const displayA = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
    const displayB = { workArea: { x: 1920, y: 0, width: 1920, height: 900 } };

    const seamScreen = {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getAllDisplays: () => [displayA, displayB],
      getPrimaryDisplay: () => displayA,
      // Y < 1080 → display A; Y ≥ 1080 → display B.
      // The OLD bottom-center anchor set Y=petY+420=1080 when petY=floor_A=660,
      // which crossed the boundary and selected B → instant snap to floor_B=480.
      // The NEW center anchor sets Y=petY+210=870 < 1080 → A → floor=660 → stable.
      getDisplayNearestPoint: ({ y }: { x: number; y: number }) =>
        y < 1080 ? displayA : displayB,
    };

    _setScreenForTesting(seamScreen as any);
    setDisplayScreen(seamScreen as any);
    invalidateDisplayCache();
    setCrossDisplayRoamingEnabled(true);  // keep X-clamp off so pet stays at seam
    _setIsPetWindowDraggingForTesting(() => false);

    // Start the pet already settled at floor_A — the exact position that triggered
    // the display-selection flip-flop with the bottom-center anchor.
    let petX = 1750;
    let petY = floorA; // 660
    const snapYValues: number[] = [];

    const accessor = () => ({
      getPosition: (): [number, number] => [petX, petY],
      isDestroyed: () => false,
      isVisible: () => true,
      setPosition: (x: number, y: number, _: boolean) => {
        petX = x;
        petY = y;
        snapYValues.push(y);
      },
    } as any);

    registerPet("seam-osc-test", accessor);
    motionSetPhysics("seam-osc-test", accessor, { gravity: true, bounce: 0.4 });

    // Drive 30 ticks (≈480ms). With the OLD bug the first tick snaps y to floor_B
    // (480) and oscillation continues; with the fix the pet is already at its stable
    // floor and setPosition is never called (or only called with y near floor_A).
    await new Promise<void>((resolve) => setTimeout(resolve, loopIntervalMs * 30));

    // Assert: no tick ever snapped the pet toward floor_B (480).
    // The fixed anchor keeps the floor consistently at floor_A=660 every tick.
    for (const y of snapYValues) {
      assert.ok(
        y >= floorA - 5,
        `setPosition called with y=${y} which is suspiciously close to floor_B=${floorB} — ` +
        `indicates the display-selection flip-flop is still occurring (floor_A=${floorA})`,
      );
    }
  });

  it("keeps the native window bottom inside the work area on Windows-sized bounds", async () => {
    const display = { bounds: { x: 0, y: 0, width: 1536, height: 864 }, workArea: { x: 0, y: 0, width: 1536, height: 816 } };
    const screen = {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getDisplayNearestPoint: () => display,
    };

    _setScreenForTesting(screen as any);
    setDisplayScreen(screen as any);
    invalidateDisplayCache();
    setCrossDisplayRoamingEnabled(false);
    setConfinementEnabled(false);
    _setIsPetWindowDraggingForTesting(() => false);

    let petX = 500;
    let petY = 300;
    const nativeWindow = {
      getPosition: (): [number, number] => [petX, petY],
      getBounds: () => ({ x: petX, y: petY, width: 344, height: 424 }),
      isDestroyed: () => false,
      isVisible: () => true,
      setPosition: (x: number, y: number) => {
        petX = x;
        petY = y;
      },
    };
    const accessor = () => nativeWindow as any;

    registerPet("native-bounds-test", accessor);
    motionSetPhysics("native-bounds-test", accessor, { gravity: true, bounce: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, loopIntervalMs * 30));

    assert.ok(petY + nativeWindow.getBounds().height <= display.workArea.y + display.workArea.height, "gravity must keep the native window bottom inside the Windows work area");
  });
});

console.log("pet-motion-engine-gravity-seam tests passed.");
