import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  companionSettingsFileName,
  disableCompanion,
  enableCompanion,
  getCompanionSettings,
  initializeCompanionSettings,
  maxCompanionGoals,
  maxCompanionPersonalityCharacters,
  normalizeCompanionSettings,
  removeCompanionPetSettings,
  updateCompanionPetSettings,
  updateCompanionSettings,
} from "../src/companion-settings.js";

// Contract: malformed persisted data cannot bypass the disclosure gate or
// escape the small user-authored profile/personality bounds.
const normalized = normalizeCompanionSettings({
  consentVersion: 0,
  enabled: true,
  target: "arbitrary-provider",
  profile: {
    name: `  ${"n".repeat(200)}  `,
    preferredAddress: 42,
    goals: [" Hydrate ", "hydrate", ...Array.from({ length: 10 }, (_, index) => `Goal ${index}`)],
  },
  pets: {
    pedra: { personality: ` ${"p".repeat(1_000)} ` },
    "../../unsafe": { personality: "ignored" },
  },
  proactivity: { enabled: true, frequency: "constantly" },
  context: { screenEnabled: true },
});
assert.equal(normalized.enabled, false);
assert.equal(normalized.target, "codex");
assert.equal(normalized.profile.name.length, 120);
assert.equal(normalized.profile.preferredAddress, "");
assert.equal(normalized.profile.goals.length, maxCompanionGoals);
assert.equal(normalized.pets.pedra?.personality.length, maxCompanionPersonalityCharacters);
assert.equal(normalized.pets["../../unsafe"], undefined);
assert.equal(normalized.proactivity.frequency, "sometimes");
assert.equal(normalized.context.screenEnabled, false);

const root = mkdtempSync(join(tmpdir(), "openpets-companion-settings-"));
try {
  initializeCompanionSettings(root);
  assert.equal(getCompanionSettings().enabled, false);
  assert.equal(getCompanionSettings().memory.enabled, false);
  assert.equal(getCompanionSettings().proactivity.enabled, false);

  // Contract: generic settings patches cannot grant consent or activate the
  // feature without the disclosure-backed enable operation.
  updateCompanionSettings({ enabled: true, consentVersion: 1, profile: { name: "Thomas" }, target: "host-ai" });
  assert.equal(getCompanionSettings().consentVersion, 0);
  assert.equal(getCompanionSettings().enabled, false);

  updateCompanionPetSettings("pedra", { personality: "Curious, warm, and gently opinionated." });
  const firstEnable = enableCompanion();
  assert.equal(firstEnable.consentVersion, 1);
  assert.equal(firstEnable.enabled, true);
  assert.equal(firstEnable.memory.enabled, true);
  assert.deepEqual(firstEnable.proactivity, { enabled: true, frequency: "sometimes" });
  assert.deepEqual(firstEnable.context, { pluginEnabled: false, sensitivePluginEnabled: false, screenEnabled: false });
  assert.equal(firstEnable.wake.enabled, false);
  assert.equal(firstEnable.profile.name, "Thomas");
  assert.equal(firstEnable.target, "host-ai");
  assert.equal(firstEnable.pets.pedra?.personality, "Curious, warm, and gently opinionated.");

  // Contract: the first-enable defaults are one complete persisted snapshot.
  const persisted = JSON.parse(readFileSync(join(root, companionSettingsFileName), "utf8")) as typeof firstEnable;
  assert.deepEqual(persisted, firstEnable);

  // Contract: independently reversible choices survive later disable/re-enable
  // cycles and are not reset to first-enable defaults again.
  disableCompanion();
  updateCompanionSettings({
    memory: { enabled: false },
    proactivity: { enabled: true, frequency: "rarely" },
    context: { pluginEnabled: true, screenEnabled: true },
    wake: { enabled: true },
  });
  const reenabled = enableCompanion();
  assert.equal(reenabled.memory.enabled, false);
  assert.deepEqual(reenabled.proactivity, { enabled: true, frequency: "rarely" });
  assert.equal(reenabled.context.pluginEnabled, true);
  assert.equal(reenabled.context.screenEnabled, false);
  assert.equal(reenabled.wake.enabled, true);

  removeCompanionPetSettings("pedra");
  assert.equal(getCompanionSettings().pets.pedra, undefined);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("Companion settings validation passed.");
