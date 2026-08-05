import assert from "node:assert/strict";
import {
  allowedReactions,
  type OpenPetsReaction,
} from "../src/local-ipc-protocol.js";
import { defaultWaitingAnimationDurationMs, normalizeWaitingAnimationDurationMs } from "../src/app-state-core.js";
import {
  defaultPetSprite,
  defaultReactionToSpriteState,
  getConfiguredSpriteCacheKey,
  getConfiguredSpriteStates,
  normalizeReactionAnimationOverrides,
  reactionAnimationMetadata,
  resolveReactionSpriteState,
  selectableAnimationMetadata,
  waitingAnimationDurationOptions,
  validateReactionAnimationOverrides,
  type SpriteStateDefinition,
  type UniversalSpriteState,
  type UserSelectableAnimationState,
} from "../src/reaction-animation-mapping.js";

// Expected contract values for runtime assertions.
const EXPECTED_SPRITE_STATE_IDS: UniversalSpriteState[] = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
];

const EXPECTED_SELECTABLE_ANIMATION_IDS: UserSelectableAnimationState[] = [
  "idle",
  "review",
  "running",
  "waiting",
  "waving",
  "jumping",
  "failed",
];

const DRAG_ONLY_STATES = ["running-left", "running-right"] as const;

// Tiny helpers
function ids<T extends { id: string }>(arr: readonly T[]): string[] {
  return arr.map((x) => x.id);
}

function assertSameMembers<T>(actual: T[], expected: T[], message: string): void {
  assert.deepEqual(actual.slice().sort(), expected.slice().sort(), message);
}

// Sprite fixed metadata
assert.equal(defaultPetSprite.fileName, "default-pet-spritesheet.webp", "sprite filename must match bundled asset");
assert.equal(defaultPetSprite.frameWidth, 192, "sprite frame width must be 192");
assert.equal(defaultPetSprite.frameHeight, 208, "sprite frame height must be 208");
assert.equal(defaultPetSprite.columns, 8, "sprite columns must be 8");
assert.equal(defaultPetSprite.rows, 9, "sprite rows must be 9");

// Waiting duration preference normalization and supported values.
assert.equal(defaultWaitingAnimationDurationMs, 1010, "waiting animation default must remain 1010 ms");
assert.deepEqual(waitingAnimationDurationOptions.map((option) => option.value), [1010, 2200], "only normal and relaxed waiting durations are supported");
assert.equal(normalizeWaitingAnimationDurationMs(1010), 1010);
assert.equal(normalizeWaitingAnimationDurationMs(2200), 2200);
for (const invalid of [undefined, null, "1010", 0, 1011, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.equal(normalizeWaitingAnimationDurationMs(invalid), 1010, `invalid saved waiting duration ${String(invalid)} must use the default`);
}

// Configured state tables must be derived without changing canonical metadata.
const canonicalStates = defaultPetSprite.states;
const canonicalWaiting = defaultPetSprite.states.waiting;
const normalStates = getConfiguredSpriteStates(1010);
const relaxedStates = getConfiguredSpriteStates(2200);
assert.notEqual(normalStates, canonicalStates, "configured states must be a fresh object");
assert.notEqual(relaxedStates.waiting, canonicalWaiting, "configured waiting state must be a fresh object");
assert.equal(normalStates.waiting.durationMs, 1010);
assert.equal(relaxedStates.waiting.durationMs, 2200);
for (const state of EXPECTED_SPRITE_STATE_IDS) {
  if (state === "waiting") continue;
  assert.deepEqual(normalStates[state], canonicalStates[state], `${state}: normal configuration must preserve canonical metadata`);
  assert.deepEqual(relaxedStates[state], canonicalStates[state], `${state}: relaxed configuration must preserve canonical metadata`);
}
assert.strictEqual(defaultPetSprite.states, canonicalStates, "canonical state object identity must remain unchanged");
assert.strictEqual(defaultPetSprite.states.waiting, canonicalWaiting, "canonical waiting state identity must remain unchanged");
assert.equal(getConfiguredSpriteCacheKey(1010), "waiting-animation-duration:1010");
assert.notEqual(getConfiguredSpriteCacheKey(1010), getConfiguredSpriteCacheKey(2200), "render/cache identity must change with waiting duration");

// Exact sprite state ids
const actualStateIds = Object.keys(defaultPetSprite.states) as UniversalSpriteState[];
assertSameMembers(actualStateIds, EXPECTED_SPRITE_STATE_IDS, "sprite state ids must match expected states");

// State shape/value validity
for (const [stateId, def] of Object.entries(defaultPetSprite.states) as [UniversalSpriteState, SpriteStateDefinition][]) {
  assert.ok(Number.isInteger(def.row) && def.row >= 0, `${stateId}: row must be non-negative integer`);
  assert.ok(def.row < defaultPetSprite.rows, `${stateId}: row must be within sprite rows`);
  assert.ok(Number.isInteger(def.frames) && def.frames > 0, `${stateId}: frames must be positive integer`);
  assert.ok(def.frames <= defaultPetSprite.columns, `${stateId}: frames must not exceed sprite columns`);
  assert.ok(Number.isFinite(def.durationMs) && def.durationMs > 0, `${stateId}: durationMs must be positive number`);
}

// Reaction mapping keys match allowedReactions
const reactionMappingKeys = Object.keys(defaultReactionToSpriteState) as OpenPetsReaction[];
assertSameMembers(reactionMappingKeys, [...allowedReactions] as OpenPetsReaction[], "reaction mapping keys must match allowedReactions");
assert.deepEqual(defaultReactionToSpriteState, {
  idle: "idle",
  thinking: "review",
  working: "running",
  editing: "running",
  running: "running",
  testing: "waiting",
  waiting: "waiting",
  waving: "waving",
  success: "jumping",
  error: "failed",
  celebrating: "jumping",
}, "existing reaction mappings must remain unchanged");

// Every mapped value is selectable and exists in sprite states
const selectableSet = new Set(EXPECTED_SELECTABLE_ANIMATION_IDS);
const spriteStateSet = new Set(EXPECTED_SPRITE_STATE_IDS);
for (const [reaction, state] of Object.entries(defaultReactionToSpriteState) as [OpenPetsReaction, UserSelectableAnimationState][]) {
  assert.ok(selectableSet.has(state), `${reaction}: mapped state ${state} must be user-selectable`);
  assert.ok(spriteStateSet.has(state), `${reaction}: mapped state ${state} must exist in sprite states`);
}

// Metadata ids match allowedReactions
const allowedReactionsArray: string[] = [...allowedReactions];
assert.deepEqual(ids(reactionAnimationMetadata), allowedReactionsArray, "reactionAnimationMetadata ids must match allowedReactions");

// Each metadata defaultAnimation equals defaultReactionToSpriteState
for (const row of reactionAnimationMetadata) {
  const expectedDefault = defaultReactionToSpriteState[row.id];
  assert.equal(row.defaultAnimation, expectedDefault, `${row.id}: metadata defaultAnimation must match defaultReactionToSpriteState`);
  assert.ok(selectableSet.has(row.defaultAnimation), `${row.id}: defaultAnimation must be user-selectable`);
}

// Selectable animation metadata exact ids excluding drag-only states
assert.deepEqual(ids(selectableAnimationMetadata), EXPECTED_SELECTABLE_ANIMATION_IDS, "selectableAnimationMetadata ids must match expected");

// Verify drag-only states are excluded from selectable metadata
for (const dragState of DRAG_ONLY_STATES as readonly string[]) {
  assert.ok(
    !selectableAnimationMetadata.some((m) => m.id === dragState),
    `drag-only state ${dragState} must not be in selectableAnimationMetadata`
  );
}

// Override behavior: both drag-only states rejected
for (const dragState of DRAG_ONLY_STATES) {
  assert.throws(
    () => validateReactionAnimationOverrides({ thinking: dragState }),
    /Invalid reaction animation state/,
    `must reject drag-only state ${dragState} in overrides`
  );
}

// Override behavior: default-equivalent normalization
assert.equal(
  normalizeReactionAnimationOverrides({ thinking: defaultReactionToSpriteState.thinking }),
  undefined,
  "default-equivalent overrides must normalize to undefined"
);

// Override behavior: invalid saved entries dropped
const withInvalid = normalizeReactionAnimationOverrides({
  thinking: "running",
  nope: "waiting",
  success: "running-right",
} as Record<string, string>);
assert.deepEqual(withInvalid, { thinking: "running" }, "invalid saved entries must be dropped, valid ones kept");

// Override behavior: no-reaction canonical idle
assert.equal(
  resolveReactionSpriteState(undefined, { idle: "waving" }),
  "idle",
  "no-reaction baseline must stay canonical idle even if explicit idle is overridden"
);

console.log("Reaction animation mapping tests passed.");
