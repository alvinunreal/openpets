import assert from "node:assert/strict";

import {
  companionProactiveDeliveryFromMemoryEntry,
  companionProactivityPolicies,
  evaluateCompanionProactivity,
  type CompanionProactiveDelivery,
} from "../src/companion-proactivity.js";
import {
  getCompanionLocalDateKey,
  resolveCompanionDayPart,
  resolveCompanionTimeState,
} from "../src/companion-time.js";

const at = (hour: number, minute = 0): Date => new Date(2026, 6, 17, hour, minute, 0, 0);

// Contract: time-boundary regressions cannot make a pet hungry overnight or
// sleepy at lunch; the five local day parts meet at explicit hour boundaries.
assert.equal(resolveCompanionDayPart(at(5, 59)), "night");
assert.equal(resolveCompanionDayPart(at(6)), "morning");
assert.equal(resolveCompanionDayPart(at(11)), "midday");
assert.equal(resolveCompanionDayPart(at(14)), "afternoon");
assert.equal(resolveCompanionDayPart(at(18)), "evening");
assert.equal(resolveCompanionDayPart(at(22)), "night");
assert.equal(resolveCompanionTimeState(at(12)).expressionHint, "hungry");
assert.equal(resolveCompanionTimeState(at(23)).expressionHint, "sleepy");
assert.equal(resolveCompanionTimeState(at(12), at(11, 59).getTime()).reactionHint, "working");
assert.equal(getCompanionLocalDateKey(at(12)), "2026-07-17");

// Contract: the labels have strictly ordered frequency semantics and every
// preset keeps a small daily ceiling plus non-zero interruption spacing.
assert.ok(companionProactivityPolicies.rarely.maxPerLocalDay < companionProactivityPolicies.sometimes.maxPerLocalDay);
assert.ok(companionProactivityPolicies.sometimes.maxPerLocalDay < companionProactivityPolicies.often.maxPerLocalDay);
assert.ok(companionProactivityPolicies.rarely.minimumSpacingMs > companionProactivityPolicies.sometimes.minimumSpacingMs);
assert.ok(companionProactivityPolicies.sometimes.minimumSpacingMs > companionProactivityPolicies.often.minimumSpacingMs);
assert.ok(companionProactivityPolicies.often.maxPerLocalDay <= 5);
assert.ok(companionProactivityPolicies.often.minimumSpacingMs > 0);

const now = at(15).getTime();
type EvaluationInput = Parameters<typeof evaluateCompanionProactivity>[0];
const base: EvaluationInput = {
  now,
  frequency: "sometimes",
  companionEnabled: true,
  proactivityEnabled: true,
  inQuietHours: false,
  targetReady: true,
  activity: { listening: false, thinking: false, speaking: false },
  candidate: { id: "lunch", dedupeKey: "time:lunch", source: "time", expiresAt: now + 60 * 60 * 1_000 },
  history: [],
};
assert.deepEqual(evaluateCompanionProactivity(base).eligible, true);

// Contract: disabling either feature cancels pending candidates, and quiet
// hours, active interaction, target health, scheduling, and expiry always win.
assert.equal(evaluateCompanionProactivity({ ...base, companionEnabled: false }).reason, "companion-disabled");
assert.equal(evaluateCompanionProactivity({ ...base, proactivityEnabled: false }).reason, "proactivity-disabled");
assert.equal(evaluateCompanionProactivity({ ...base, inQuietHours: true }).reason, "quiet-hours");
assert.equal(evaluateCompanionProactivity({ ...base, activity: { ...base.activity, speaking: true } }).reason, "interaction-active");
assert.equal(evaluateCompanionProactivity({ ...base, targetReady: false }).reason, "target-not-ready");
assert.equal(evaluateCompanionProactivity({ ...base, candidate: { ...base.candidate, earliestAt: now + 1 } }).reason, "candidate-not-ready");
assert.equal(evaluateCompanionProactivity({ ...base, candidate: { ...base.candidate, expiresAt: now } }).reason, "candidate-expired");

const delivered = (input: Partial<CompanionProactiveDelivery> & Pick<CompanionProactiveDelivery, "dedupeKey" | "displayedAt">): CompanionProactiveDelivery => ({
  candidateId: input.candidateId ?? input.dedupeKey,
  dedupeKey: input.dedupeKey,
  source: input.source ?? "time",
  pluginId: input.pluginId,
  displayedAt: input.displayedAt,
});

// Contract: the same opportunity cannot repeat inside its cooldown, global
// daily/spacing caps apply, and plugins also have a per-plugin hard ceiling.
assert.equal(evaluateCompanionProactivity({
  ...base,
  history: [delivered({ dedupeKey: "time:lunch", displayedAt: now - 10 * 60 * 1_000 })],
}).reason, "duplicate");

assert.equal(evaluateCompanionProactivity({
  ...base,
  frequency: "rarely",
  history: [delivered({ dedupeKey: "different", displayedAt: now - 8 * 60 * 60 * 1_000 })],
}).reason, "daily-limit");

assert.equal(evaluateCompanionProactivity({
  ...base,
  frequency: "often",
  history: [delivered({ dedupeKey: "different", displayedAt: now - 10 * 60 * 1_000 })],
}).reason, "minimum-spacing");

const pluginHistory = [
  delivered({ dedupeKey: "focus:one", source: "plugin", pluginId: "focus-buddy", displayedAt: now - 8 * 60 * 60 * 1_000 }),
  delivered({ dedupeKey: "focus:two", source: "plugin", pluginId: "focus-buddy", displayedAt: now - 5 * 60 * 60 * 1_000 }),
];
assert.equal(evaluateCompanionProactivity({
  ...base,
  frequency: "often",
  candidate: { id: "focus-three", dedupeKey: "focus:three", source: "plugin", pluginId: "focus-buddy", expiresAt: now + 60_000 },
  history: pluginHistory,
}).reason, "plugin-daily-limit");

assert.equal(evaluateCompanionProactivity({
  ...base,
  frequency: "often",
  candidate: { id: "water-check", dedupeKey: "daily", source: "plugin", pluginId: "habit-buddy", expiresAt: now + 60_000 },
  history: [delivered({ dedupeKey: "daily", source: "plugin", pluginId: "focus-buddy", displayedAt: now - 4 * 60 * 60_000 })],
}).reason, "eligible", "plugin dedupe keys are scoped to their source plugin");

// Contract: restart hydration retains exact dedupe/source/plugin accounting,
// while legacy proactive memory continues to count toward general spacing.
assert.deepEqual(companionProactiveDeliveryFromMemoryEntry({
  id: "persisted-plugin",
  petId: "pedra",
  role: "proactive",
  text: "Still focused?",
  createdAt: now - 60_000,
  proactive: {
    candidateId: "focus-three",
    dedupeKey: "focus.daily",
    source: "plugin",
    pluginId: "focus-buddy",
  },
}), {
  candidateId: "focus-three",
  dedupeKey: "focus.daily",
  source: "plugin",
  pluginId: "focus-buddy",
  displayedAt: now - 60_000,
});
assert.deepEqual(companionProactiveDeliveryFromMemoryEntry({
  id: "legacy",
  petId: "pedra",
  role: "proactive",
  text: "Hello",
  createdAt: now - 120_000,
}), {
  candidateId: "memory:legacy",
  dedupeKey: "memory:legacy",
  source: "time",
  displayedAt: now - 120_000,
});

console.log("Companion time and proactivity validation passed.");
