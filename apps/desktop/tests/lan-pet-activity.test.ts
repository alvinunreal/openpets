import assert from "node:assert/strict";

import { planLanWorkActivities, shouldPublishLanWorkSignal, shouldRetryLanWorkReturn } from "../src/lan-pet-activity.js";
import type { LanState } from "../src/lan-state.js";

const meetingState: LanState = {
  enabled: true,
  currentHost: "alpha",
  clients: [],
  pets: [
    { ownerHost: "alpha", petId: "cat", currentHost: "alpha" },
    { ownerHost: "beta", petId: "dog", currentHost: "alpha", activity: { kind: "work", sequence: 1, createdAt: 1_000 } },
  ],
  updatedAt: 1_100,
};

assert.equal(shouldPublishLanWorkSignal("beta", meetingState, "testing"), true, "work should publish only when the owner's pet is away and meeting another pet");
assert.equal(shouldPublishLanWorkSignal("alpha", meetingState, "testing"), false, "a pet already home should not publish a return signal");
assert.equal(shouldPublishLanWorkSignal("beta", meetingState, "thinking"), false, "non-work reactions must remain local");

const firstPlan = planLanWorkActivities("alpha", meetingState.pets ?? [], new Map(), meetingState.updatedAt, 15_000);
assert.deepEqual(firstPlan.departures, [{ ownerHost: "beta", sequence: 1 }], "a fresh remote work signal should trigger one meeting departure");
assert.deepEqual(firstPlan.observed, [{ ownerHost: "beta", sequence: 1 }], "processed sequences should be recorded even though no message content is present");

const repeatedPlan = planLanWorkActivities("alpha", meetingState.pets ?? [], new Map([["beta", 1]]), meetingState.updatedAt, 15_000);
assert.deepEqual(repeatedPlan.departures, [], "polling the same activity sequence must not replay dialogue or departure");

const stalePets = [
  { ownerHost: "alpha", petId: "cat", currentHost: "alpha" },
  { ownerHost: "beta", petId: "dog", currentHost: "alpha", activity: { kind: "work" as const, sequence: 2, createdAt: 1_000 } },
];
const stalePlan = planLanWorkActivities("alpha", stalePets, new Map(), 20_000, 15_000);
assert.deepEqual(stalePlan.departures, [], "stale work activity should not make a visiting pet leave later");
assert.deepEqual(stalePlan.observed, [{ ownerHost: "beta", sequence: 2 }], "stale activity must still be consumed so it cannot replay");

assert.equal(shouldRetryLanWorkReturn("alpha", "beta", 1, meetingState), true, "a failed return should retry while the same visitor activity is still current");
assert.equal(shouldRetryLanWorkReturn("alpha", "beta", 2, meetingState), false, "a superseded activity must not retry an older return");
assert.equal(shouldRetryLanWorkReturn("beta", "beta", 1, meetingState), false, "a host must not retry returning a pet it does not hold");

console.log("LAN privacy-preserving work activity validation passed.");
