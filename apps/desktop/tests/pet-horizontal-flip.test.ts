/**
 * Catches flip-map persistence bugs: junk keys surviving restart, toggling one
 * pet flipping others, or a second toggle failing to restore the unflipped default.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { normalizePetHorizontalFlip, togglePetHorizontalFlipMap } from "../src/app-state-core.js";

assert.equal(normalizePetHorizontalFlip(undefined), undefined);
assert.equal(normalizePetHorizontalFlip(null), undefined);
assert.equal(normalizePetHorizontalFlip(["fox"]), undefined);
assert.equal(normalizePetHorizontalFlip("fox"), undefined);
assert.equal(normalizePetHorizontalFlip({}), undefined);
assert.equal(normalizePetHorizontalFlip({ fox: false, azure: 1, "bad/id": true }), undefined);

assert.deepEqual(normalizePetHorizontalFlip({ fox: true, azure: false, builtin: true, "bad/id": true }), {
  fox: true,
  builtin: true,
});

{
  const afterFox = togglePetHorizontalFlipMap(undefined, "fox");
  assert.deepEqual(afterFox, { fox: true }, "first toggle persists only that pet");

  const afterAzure = togglePetHorizontalFlipMap(afterFox, "azure");
  assert.deepEqual(afterAzure, { fox: true, azure: true }, "toggling another pet leaves existing flips");

  const afterFoxOff = togglePetHorizontalFlipMap(afterAzure, "fox");
  assert.deepEqual(afterFoxOff, { azure: true }, "toggling off one pet does not clear others");

  assert.equal(togglePetHorizontalFlipMap(afterFoxOff, "azure"), undefined, "last toggle off omits the map");
}

assert.deepEqual(togglePetHorizontalFlipMap({ fox: true }, "builtin"), { fox: true, builtin: true });
assert.throws(() => togglePetHorizontalFlipMap(undefined, "bad/id"), /Invalid pet id for horizontal flip/);
assert.throws(() => togglePetHorizontalFlipMap(undefined, ""), /Invalid pet id for horizontal flip/);

const userDataPath = mkdtempSync(join(tmpdir(), "openpets-pet-horizontal-flip-"));
const electronMock = `data:text/javascript,${encodeURIComponent(`
  export const app = { getPath: (name) => name === "userData" ? ${JSON.stringify(userDataPath)} : "" };
  export const net = {};
  export const powerMonitor = { on: () => {}, getSystemIdleTime: () => 0 };
  export const screen = { on: () => {}, getAllDisplays: () => [] };
  export const shell = { openPath: async () => "" };
  export default { app, net, powerMonitor, screen, shell };
`)}`;
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "electron") return { url: ${JSON.stringify(electronMock)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

const {
  getAppStateSnapshot,
  getStateFilePath,
  initializeAppState,
  isPetFlippedHorizontally,
  releaseStartupInstallLock,
  togglePetHorizontalFlip,
} = await import("../src/app-state.js");

try {
  initializeAppState();
  assert.equal(togglePetHorizontalFlip("fox"), true, "toggling a valid pet records its flipped state");
  assert.deepEqual(readPersistedFlipMap(getStateFilePath()), { fox: true });

  releaseStartupInstallLock();
  initializeAppState();
  assert.equal(isPetFlippedHorizontally("fox"), true, "a flipped pet remains flipped after state reload");
  assert.equal(isPetFlippedHorizontally("azure"), false, "reloading one pet flip does not flip another pet");

  assert.equal(togglePetHorizontalFlip("fox"), false, "toggling the pet again restores the unflipped default");
  assert.equal(readPersistedFlipMap(getStateFilePath()), undefined);

  releaseStartupInstallLock();
  initializeAppState();
  assert.equal(isPetFlippedHorizontally("fox"), false, "turning the flip off persists across reload");
  assert.equal(isPetFlippedHorizontally("azure"), false);
  assert.equal(getAppStateSnapshot().preferences.petHorizontalFlip, undefined);
} finally {
  releaseStartupInstallLock();
  rmSync(userDataPath, { recursive: true, force: true });
}

console.error("pet horizontal flip normalization and toggle persistence passed.");

function readPersistedFlipMap(statePath: string): unknown {
  return (JSON.parse(readFileSync(statePath, "utf8")) as { preferences?: { petHorizontalFlip?: unknown } }).preferences?.petHorizontalFlip;
}
