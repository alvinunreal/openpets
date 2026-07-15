import assert from "node:assert/strict";

import { LanCoordinator, countLanTopologyLinks, normalizeLanEdge, normalizeLanHost, normalizeLanPetId, normalizeLanPoint, normalizeLanTopology, validateLanTopology } from "../src/lan-state.js";

const coordinator = new LanCoordinator({ staleClientMs: 1_000 });

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
