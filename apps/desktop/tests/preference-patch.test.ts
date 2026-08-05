/**
 * Unit tests for validatePreferencePatch (preference-patch.ts).
 *
 * Covers:
 *   - The waitingAnimationDurationMs preference accepts only 1010 and 2200.
 *   - All four boolean preference keys: petPoolEnabled, petConfinementEnabled,
 *     petGravityEnabled, petCrossDisplayEnabled (the key added in FIX H1).
 *   - Each accepts true and false and lands in the returned patch.
 *   - Each throws on a non-boolean value.
 *   - Non-object input throws.
 *   - Unknown keys are silently ignored.
 */
import assert from "node:assert/strict";

import { validatePreferencePatch } from "../src/preference-patch.js";

// ---------------------------------------------------------------------------
// Non-object input → throws
// ---------------------------------------------------------------------------
{
  assert.throws(
    () => validatePreferencePatch(null),
    /Invalid preferences patch/,
    "null should throw",
  );
  assert.throws(
    () => validatePreferencePatch("string"),
    /Invalid preferences patch/,
    "string should throw",
  );
  assert.throws(
    () => validatePreferencePatch(42),
    /Invalid preferences patch/,
    "number should throw",
  );
  console.log("validatePreferencePatch: non-object input throws — PASS");
}

// ---------------------------------------------------------------------------
// Unknown keys → silently ignored, patch is empty
// ---------------------------------------------------------------------------
{
  const patch = validatePreferencePatch({ unknownKey: true, anotherKey: 123 });
  assert.deepEqual(patch, {}, "unknown keys must be silently ignored");
  console.log("validatePreferencePatch: unknown keys ignored — PASS");
}

// ---------------------------------------------------------------------------
// Boolean preference keys — each tested for true, false, and non-boolean error
// ---------------------------------------------------------------------------

const booleanKeys = [
  { key: "petPoolEnabled", errMsg: "Invalid pet-pool-enabled value." },
  { key: "petConfinementEnabled", errMsg: "Invalid pet-confinement-enabled value." },
  { key: "petGravityEnabled", errMsg: "Invalid pet-gravity-enabled value." },
  { key: "petCrossDisplayEnabled", errMsg: "Invalid pet-cross-display-enabled value." },
] as const;

for (const { key, errMsg } of booleanKeys) {
  // accepts true
  {
    const patch = validatePreferencePatch({ [key]: true });
    assert.equal(patch[key], true, `${key}: true must land in patch`);
  }

  // accepts false
  {
    const patch = validatePreferencePatch({ [key]: false });
    assert.equal(patch[key], false, `${key}: false must land in patch`);
  }

  // rejects non-boolean
  {
    assert.throws(
      () => validatePreferencePatch({ [key]: "yes" }),
      new RegExp(errMsg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${key}: string must throw '${errMsg}'`,
    );
    assert.throws(
      () => validatePreferencePatch({ [key]: 1 }),
      new RegExp(errMsg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${key}: number must throw '${errMsg}'`,
    );
  }

  console.log(`validatePreferencePatch: ${key} — PASS`);
}

// ---------------------------------------------------------------------------
// petCrossDisplayEnabled explicit round-trip (FIX H1 regression guard)
// ---------------------------------------------------------------------------
{
  const on = validatePreferencePatch({ petCrossDisplayEnabled: true });
  assert.equal(on.petCrossDisplayEnabled, true, "petCrossDisplayEnabled: enable round-trip");

  const off = validatePreferencePatch({ petCrossDisplayEnabled: false });
  assert.equal(off.petCrossDisplayEnabled, false, "petCrossDisplayEnabled: disable round-trip");

  // The key must NOT be dropped — this was the exact bug
  assert.ok("petCrossDisplayEnabled" in on, "petCrossDisplayEnabled must be present in patch (not dropped)");
  assert.ok("petCrossDisplayEnabled" in off, "petCrossDisplayEnabled must be present in patch when false");

  console.log("validatePreferencePatch: petCrossDisplayEnabled round-trip (FIX H1 regression guard) — PASS");
}

// ---------------------------------------------------------------------------
// Multiple keys at once — only provided keys appear in patch
// ---------------------------------------------------------------------------
{
  const patch = validatePreferencePatch({
    petPoolEnabled: true,
    petGravityEnabled: false,
  });
  assert.equal(patch.petPoolEnabled, true, "petPoolEnabled present");
  assert.equal(patch.petGravityEnabled, false, "petGravityEnabled present");
  assert.equal("petConfinementEnabled" in patch, false, "petConfinementEnabled must be absent");
  assert.equal("petCrossDisplayEnabled" in patch, false, "petCrossDisplayEnabled must be absent");
  console.log("validatePreferencePatch: multi-key patch — PASS");
}

// ---------------------------------------------------------------------------
// waitingAnimationDurationMs — only the supported durations are accepted
// ---------------------------------------------------------------------------
{
  assert.equal(validatePreferencePatch({ waitingAnimationDurationMs: 1010 }).waitingAnimationDurationMs, 1010);
  assert.equal(validatePreferencePatch({ waitingAnimationDurationMs: 2200 }).waitingAnimationDurationMs, 2200);

  for (const value of [undefined, null, "2200", true, 0, 1011, Number.NaN]) {
    assert.throws(
      () => validatePreferencePatch({ waitingAnimationDurationMs: value }),
      /Invalid waiting animation duration value\./,
      `waitingAnimationDurationMs must reject ${String(value)}`,
    );
  }

  const patch = validatePreferencePatch({ waitingAnimationDurationMs: 2200, petGravityEnabled: true });
  assert.deepEqual(patch, { waitingAnimationDurationMs: 2200, petGravityEnabled: true }, "duration patches must not alter unrelated values");
  console.log("validatePreferencePatch: waitingAnimationDurationMs validation — PASS");
}

console.log("\nAll preference-patch tests passed.");
