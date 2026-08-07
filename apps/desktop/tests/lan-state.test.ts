import assert from "node:assert/strict";

import { isLanPetAwayForLocalHost, LanCoordinator, countLanTopologyLinks, normalizeLanEdge, normalizeLanHost, normalizeLanPetId, normalizeLanPoint, normalizeLanTopology, validateLanTopology } from "../src/lan-state.js";

const coordinator = new LanCoordinator({ staleClientMs: 1_000 });

assert.equal(isLanPetAwayForLocalHost("off", null, "alpha", false), false, "LAN-disabled mode must preserve local remote actions");
assert.equal(isLanPetAwayForLocalHost("client", null, "alpha", false), true, "LAN ownership must fail closed before the first state is available");
assert.equal(isLanPetAwayForLocalHost("server", { enabled: true, currentHost: null, clients: [], updatedAt: 0 }, "alpha", false), true, "unknown LAN ownership must keep remote actions hidden");
assert.equal(isLanPetAwayForLocalHost("client", { enabled: true, currentHost: "alpha", clients: [], updatedAt: 0 }, "alpha", false), false, "known local LAN ownership should permit remote actions");
assert.equal(isLanPetAwayForLocalHost("server", { enabled: true, currentHost: "beta", clients: [], updatedAt: 0 }, "alpha", false), true, "remote LAN ownership should suppress local remote actions");
assert.equal(isLanPetAwayForLocalHost("client", { enabled: true, currentHost: "beta", clients: [], pets: [{ ownerHost: "alpha", petId: "cat", currentHost: "alpha" }], updatedAt: 0 }, "alpha", true), false, "multi-pet local ownership should permit remote actions for the local pet");
assert.equal(isLanPetAwayForLocalHost("client", { enabled: true, currentHost: "alpha", clients: [], pets: [{ ownerHost: "alpha", petId: "cat", currentHost: "beta" }], updatedAt: 0 }, "alpha", true), true, "multi-pet visiting ownership should suppress local remote actions");

let state = coordinator.register("Akshar", { x: 100, y: 100 }, 1_000);
assert.equal(state.currentHost, "Akshar", "first registered host should own the LAN pet");
assert.deepEqual(state.clients.map((client) => client.host), ["Akshar"]);

state = coordinator.register("aditya", { x: 200, y: 100 }, 1_100);
assert.equal(state.currentHost, "Akshar", "second host should not steal ownership on register");
assert.deepEqual(state.clients.map((client) => client.host), ["aditya", "Akshar"], "clients should be sorted for stable snapshots");

state = coordinator.updatePosition("Akshar", { x: 5, y: 100 }, "right", 1_200);
assert.equal(state.currentHost, "Akshar", "edge migration should not fire until owner has first moved away from an edge");

state = coordinator.updatePosition("Akshar", { x: 80, y: 100 }, null, 1_300);
assert.equal(state.currentHost, "Akshar", "moving away from the edge should arm the next edge crossing");

state = coordinator.updatePosition("Akshar", { x: 999, y: 100 }, "right", 1_400);
assert.equal(state.currentHost, "aditya", "right edge crossing should migrate to the next host");

state = coordinator.updatePosition("aditya", { x: 999, y: 100 }, "right", 1_500);
assert.equal(state.currentHost, "aditya", "new owner should not instantly bounce away while still on an edge");

state = coordinator.claim("Akshar", 1_600) ?? assert.fail("claim should succeed for a connected host");
assert.equal(state.currentHost, "Akshar", "claim should move ownership to the requested connected host");
assert.equal(coordinator.claim("missing", 1_700), null, "claim should reject unknown hosts");

state = coordinator.snapshot(3_000);
assert.equal(state.currentHost, null, "stale owner should be cleared when all clients expire");
assert.deepEqual(state.clients, [], "stale clients should be pruned");

const restoredCoordinator = new LanCoordinator({ staleClientMs: 1_000, initialCurrentHost: "alpha" });
let restoredState = restoredCoordinator.register("beta", { x: 300, y: 100 }, 4_000);
assert.equal(restoredState.currentHost, "beta", "first reconnecting client can temporarily own the pet after restart");
restoredState = restoredCoordinator.register("alpha", { x: 100, y: 100 }, 4_100);
assert.equal(restoredState.currentHost, "alpha", "restored owner should reclaim ownership when it reconnects");
restoredState = restoredCoordinator.updatePosition("beta", { x: 320, y: 120 }, null, 4_200);
assert.equal(restoredState.currentHost, "alpha", "non-owner position updates should not steal from the restored owner");


const topologyCoordinator = new LanCoordinator({
  staleClientMs: 1_000,
  topology: normalizeLanTopology({
    alpha: { right: "charlie", left: "beta" },
    charlie: { left: "alpha" },
  }),
});
let topologyState = topologyCoordinator.register("alpha", { x: 100, y: 100 }, 5_000);
topologyState = topologyCoordinator.register("beta", { x: 200, y: 100 }, 5_100);
topologyState = topologyCoordinator.register("charlie", { x: 300, y: 100 }, 5_200);
topologyState = topologyCoordinator.updatePosition("alpha", { x: 120, y: 100 }, null, 5_300);
topologyState = topologyCoordinator.updatePosition("alpha", { x: 999, y: 100 }, "right", 5_400);
assert.equal(topologyState.currentHost, "charlie", "configured right neighbor should override alphabetical cycling");
topologyState = topologyCoordinator.updatePosition("charlie", { x: 300, y: 100 }, null, 5_500);
topologyState = topologyCoordinator.updatePosition("charlie", { x: 5, y: 100 }, "left", 5_600);
assert.equal(topologyState.currentHost, "alpha", "configured left neighbor should be used when connected");

const offlineNeighborCoordinator = new LanCoordinator({
  staleClientMs: 1_000,
  topology: normalizeLanTopology({ alpha: { right: "missing-host" } }),
});
let offlineState = offlineNeighborCoordinator.register("alpha", { x: 100, y: 100 }, 6_000);
offlineState = offlineNeighborCoordinator.register("beta", { x: 200, y: 100 }, 6_100);
offlineState = offlineNeighborCoordinator.updatePosition("alpha", { x: 120, y: 100 }, null, 6_200);
offlineState = offlineNeighborCoordinator.updatePosition("alpha", { x: 999, y: 100 }, "right", 6_300);
assert.equal(offlineState.currentHost, "beta", "offline configured neighbor should fall back to sorted cycling");

// Multi-pet foundation: each host contributes an independently movable pet,
// allowing two pets to occupy the same host without changing legacy behavior.
const multiPetCoordinator = new LanCoordinator({ staleClientMs: 10_000 });
let multiPetState = multiPetCoordinator.register("alpha", { x: 100, y: 100 }, 7_000, "cat");
multiPetState = multiPetCoordinator.register("beta", { x: 200, y: 100 }, 7_100, "dog");
assert.deepEqual(multiPetState.pets?.map((pet) => [pet.ownerHost, pet.petId, pet.currentHost]), [
  ["alpha", "cat", "alpha"],
  ["beta", "dog", "beta"],
], "each LAN host should register its own independently hosted pet");
multiPetState = multiPetCoordinator.updatePosition("alpha", { x: 120, y: 100 }, null, 7_200, "alpha");
multiPetState = multiPetCoordinator.updatePosition("alpha", { x: 999, y: 100 }, "right", 7_300, "alpha");
assert.deepEqual(multiPetState.pets?.map((pet) => [pet.ownerHost, pet.currentHost]), [
  ["alpha", "beta"],
  ["beta", "beta"],
], "one LAN pet should migrate onto a host that already has another pet");
multiPetState = multiPetCoordinator.publishActivity("alpha", 7_400) ?? assert.fail("a visiting pet in a meeting should accept coarse work activity");
assert.deepEqual(multiPetState.pets?.find((pet) => pet.ownerHost === "alpha")?.activity, { kind: "work", sequence: 7_400, createdAt: 7_400 }, "activity should contain only coarse kind, ordering, and coordinator time");
multiPetState = multiPetCoordinator.returnPet("beta", "alpha", 7_500) ?? assert.fail("the current host should be able to return a visiting pet");
assert.equal(multiPetState.pets?.find((pet) => pet.ownerHost === "alpha")?.currentHost, "alpha", "work return should send the visitor back to its owner");
assert.equal(multiPetState.pets?.find((pet) => pet.ownerHost === "alpha")?.activity, undefined, "return should consume the coarse activity");
assert.equal(multiPetCoordinator.returnPet("beta", "alpha", 7_600), null, "a host that no longer holds the pet cannot return it again");
assert.equal(multiPetCoordinator.publishActivity("missing", 7_700), null, "unknown owners cannot publish activity");
assert.equal(multiPetCoordinator.publishActivity("alpha", 7_800), null, "a pet at home must not publish LAN work activity");
multiPetCoordinator.updatePosition("alpha", { x: 50, y: 20 }, null, 7_900, "alpha");
multiPetState = multiPetCoordinator.updatePosition("alpha", { x: 0, y: 20 }, "left", 8_000, "alpha");
multiPetState = multiPetCoordinator.publishActivity("alpha", 8_100) ?? assert.fail("a pet should publish again during a later meeting");
assert.equal(multiPetState.pets?.find((pet) => pet.ownerHost === "alpha")?.activity?.sequence, 8_100, "later visits must use a sequence newer than the consumed activity");

// Registration is the coordinator trust boundary: unsafe IDs must never enter
// snapshots, and a host that no longer selects a pet must remove its old record.
const registrationCoordinator = new LanCoordinator({ staleClientMs: 10_000 });
let registrationState = registrationCoordinator.register("alpha", { x: 100, y: 100 }, 8_000, "../cat");
assert.equal(registrationState.clients[0]?.petId, undefined, "invalid pet IDs should be discarded at registration");
assert.deepEqual(registrationState.pets, [], "invalid pet IDs should not create coordinator pet records");
registrationState = registrationCoordinator.register("alpha", { x: 100, y: 100 }, 8_100, "cat");
assert.equal(registrationState.pets?.[0]?.petId, "cat", "a valid selection should create the owner's pet record");
registrationState = registrationCoordinator.register("alpha", { x: 100, y: 100 }, 8_200);
assert.equal(registrationState.clients[0]?.petId, undefined, "deselection should clear the client selection");
assert.deepEqual(registrationState.pets, [], "deselection should remove the owner's previous pet record");

// An interrupted crossing consumes the arm. Reconnecting another host while
// the pet remains at the edge must not cause a delayed, surprise handoff.
const interruptedHandoffCoordinator = new LanCoordinator({ staleClientMs: 10_000 });
let interruptedState = interruptedHandoffCoordinator.register("alpha", { x: 100, y: 100 }, 9_000, "cat");
interruptedState = interruptedHandoffCoordinator.updatePosition("alpha", { x: 120, y: 100 }, null, 9_100, "alpha");
interruptedState = interruptedHandoffCoordinator.updatePosition("alpha", undefined, "right", 9_200, "alpha");
interruptedState = interruptedHandoffCoordinator.register("beta", { x: 200, y: 100 }, 9_300, "dog");
interruptedState = interruptedHandoffCoordinator.updatePosition("alpha", { x: 999, y: 100 }, "right", 9_400, "alpha");
assert.equal(interruptedState.pets?.find((pet) => pet.ownerHost === "alpha")?.currentHost, "alpha", "an interrupted handoff should require moving away from the edge before retrying");

// If a destination disappears, recovery returns the pet to its owner and
// clears the old host's arm so a reconnect cannot immediately bounce it away.
const hostLossCoordinator = new LanCoordinator({ staleClientMs: 1_000 });
let hostLossState = hostLossCoordinator.register("alpha", { x: 100, y: 100 }, 10_000, "cat");
hostLossState = hostLossCoordinator.register("beta", { x: 200, y: 100 }, 10_100, "dog");
hostLossState = hostLossCoordinator.updatePosition("alpha", { x: 120, y: 100 }, null, 10_200, "alpha");
hostLossState = hostLossCoordinator.updatePosition("alpha", { x: 999, y: 100 }, "right", 10_300, "alpha");
hostLossState = hostLossCoordinator.updatePosition("beta", { x: 220, y: 100 }, null, 10_400, "alpha");
hostLossState = hostLossCoordinator.updatePosition("alpha", { x: 100, y: 100 }, null, 11_500);
assert.equal(hostLossState.pets?.find((pet) => pet.ownerHost === "alpha")?.currentHost, "alpha", "host loss should return a visiting pet to its connected owner");
hostLossState = hostLossCoordinator.register("beta", { x: 200, y: 100 }, 11_600, "dog");
hostLossState = hostLossCoordinator.updatePosition("alpha", { x: 999, y: 100 }, "right", 11_700, "alpha");
assert.equal(hostLossState.pets?.find((pet) => pet.ownerHost === "alpha")?.currentHost, "alpha", "host-loss recovery should require a fresh interior position before another handoff");


const topologyDiagnostics = normalizeLanTopology({
  alpha: { right: "beta", left: "alpha" },
  beta: { up: "gamma" },
});
assert.equal(countLanTopologyLinks(topologyDiagnostics), 3, "topology link count should include each configured edge");
assert.deepEqual(validateLanTopology(topologyDiagnostics), [
  { code: "self_reference", host: "alpha", edge: "left", neighbor: "alpha" },
  { code: "missing_reverse", host: "alpha", edge: "right", neighbor: "beta" },
  { code: "missing_reverse", host: "beta", edge: "up", neighbor: "gamma" },
]);
assert.deepEqual(validateLanTopology(normalizeLanTopology({ alpha: { right: "beta" }, beta: { left: "alpha" } })), [], "reciprocal topology should not report warnings");

assert.deepEqual(normalizeLanTopology({ " alpha ": { right: " beta ", diagonal: "ignored", left: "" } }), { alpha: { right: "beta" } });
assert.deepEqual(normalizeLanTopology("not-object"), {});

assert.equal(normalizeLanHost("  office-pc  "), "office-pc");
assert.equal(normalizeLanHost(""), null);
assert.deepEqual(normalizeLanPoint({ x: 12.7, y: "9" }), { x: 13, y: 9 });
assert.equal(normalizeLanPoint({ x: Number.NaN, y: 1 }), undefined);
assert.equal(normalizeLanEdge("left"), "left");
assert.equal(normalizeLanEdge("diagonal"), null);
assert.equal(normalizeLanPetId("pixel-cat"), "pixel-cat");
assert.equal(normalizeLanPetId("../cat"), null);

console.log("LAN coordinator validation passed.");
