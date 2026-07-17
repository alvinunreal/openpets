import assert from "node:assert/strict";

import { defaultPetScale, deriveDisplayKey, markOnboardingCompleted, normalizeOnboardingCompleted, normalizePetScale, normalizeReadSpeechBubblesAloud, petScaleOptions } from "../src/app-state-core.js";

assert.equal(normalizeOnboardingCompleted({}), false);
assert.equal(normalizeOnboardingCompleted({ onboardingCompleted: true }), true);
assert.equal(normalizeOnboardingCompleted({ onboardingCompleted: false }), false);
assert.equal(normalizeOnboardingCompleted({ onboardingCompleted: "true" }), false);
assert.equal(normalizeReadSpeechBubblesAloud(undefined), false);
assert.equal(normalizeReadSpeechBubblesAloud(false), false);
assert.equal(normalizeReadSpeechBubblesAloud(true), true);
assert.equal(normalizeReadSpeechBubblesAloud("true"), false);

const state = {
  version: 1,
  preferences: {
    defaultPetId: "built-in",
    openDefaultPetOnLaunch: true,
    speechBubblesEnabled: true,
    petScale: 1,
    onboardingCompleted: false,
  },
  pets: {
    installed: [{ id: "built-in", displayName: "Built-in Pet" }],
  },
};

const completed = markOnboardingCompleted(state);
assert.equal(completed.preferences.onboardingCompleted, true);
assert.equal(completed.preferences.defaultPetId, "built-in");
assert.equal(completed.preferences.openDefaultPetOnLaunch, true);
assert.equal(completed.preferences.speechBubblesEnabled, true);
assert.equal(completed.preferences.petScale, 1);
assert.deepEqual(completed.pets, state.pets);
assert.equal(state.preferences.onboardingCompleted, false);

const preferencePatch = {
  ...completed.preferences,
  speechBubblesEnabled: true,
};
assert.equal(normalizeOnboardingCompleted(preferencePatch), true);
assert.equal(preferencePatch.defaultPetId, "built-in");
assert.equal(preferencePatch.openDefaultPetOnLaunch, true);
assert.equal(preferencePatch.speechBubblesEnabled, true);

assert.equal(defaultPetScale, 1);
assert.deepEqual(petScaleOptions.map((option) => option.value), [0.5, 0.75, 1, 1.25, 1.5]);
assert.equal(normalizePetScale(0.5), 0.5);
assert.equal(normalizePetScale(0.75), 0.75);
assert.equal(normalizePetScale(1), 1);
assert.equal(normalizePetScale(1.25), 1.25);
assert.equal(normalizePetScale(1.5), 1.5);
assert.equal(normalizePetScale(0.56), defaultPetScale);
assert.equal(normalizePetScale("1"), defaultPetScale);
assert.equal(normalizePetScale(Number.NaN), defaultPetScale);
assert.equal(normalizePetScale(Number.POSITIVE_INFINITY), defaultPetScale);
assert.equal(normalizePetScale(undefined), defaultPetScale);

// Per-monitor display key derivation
assert.equal(deriveDisplayKey({ x: 0, y: 0, width: 2560, height: 1440 }), "0,0,2560x1440");
assert.equal(deriveDisplayKey({ x: 2560, y: 0, width: 1080, height: 1920 }), "2560,0,1080x1920");
// Negative coordinates (display to the left or above the primary)
assert.equal(deriveDisplayKey({ x: -2560, y: -100, width: 2560, height: 1440 }), "-2560,-100,2560x1440");
// Same display always produces the same key (stability)
const boundsA = { x: 0, y: 0, width: 1920, height: 1080 };
const boundsB = { x: 0, y: 0, width: 1920, height: 1080 };
assert.equal(deriveDisplayKey(boundsA), deriveDisplayKey(boundsB));
// Different displays produce different keys
const boundsC = { x: 1920, y: 0, width: 1920, height: 1080 };
assert.notEqual(deriveDisplayKey(boundsA), deriveDisplayKey(boundsC));

console.error("Onboarding state validation passed.");
