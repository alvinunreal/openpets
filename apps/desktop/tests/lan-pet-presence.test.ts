import assert from "node:assert/strict";

import { planLanPetPresence, resolveRenderableLanPetId } from "../src/lan-pet-presence.js";

const pets = [
  { ownerHost: "alpha", petId: "cat", currentHost: "beta" },
  { ownerHost: "beta", petId: "dog", currentHost: "beta" },
  { ownerHost: "gamma", petId: "cat", currentHost: "beta" },
];

const plan = planLanPetPresence("beta", pets, ["alpha", "departed"]);
assert.deepEqual(plan.show.map((pet) => pet.ownerHost), ["alpha", "gamma"], "all remote pets hosted locally should render, including duplicate pet IDs");
assert.deepEqual(plan.closeOwnerHosts, ["departed"], "windows whose owners moved away should close");
assert.equal(plan.show.some((pet) => pet.ownerHost === "beta"), false, "the local owner's default pet must not be duplicated as a visiting window");

assert.equal(resolveRenderableLanPetId("cat", [{ id: "cat" }]), "cat", "an installed healthy pet should render");
assert.equal(resolveRenderableLanPetId("cat", [{ id: "cat", broken: true }]), null, "a broken pet should not open a blank visiting window");
assert.equal(resolveRenderableLanPetId("builtin", [{ id: "builtin", builtIn: true }]), "builtin", "the bundled pet should support fresh-profile LAN testing");
assert.equal(resolveRenderableLanPetId("missing", [{ id: "cat" }]), null, "a missing remote asset should degrade safely");

console.log("LAN visiting pet presence validation passed.");
