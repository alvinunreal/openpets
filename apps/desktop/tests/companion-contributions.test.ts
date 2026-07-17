import assert from "node:assert/strict";

import { CompanionContributionStore } from "../src/companion-contributions.js";

const pluginId = "openpets.test-companion";

// Contract: revoked consent and disabled plugins cannot leave readable context behind.
{
  let now = 1_000_000;
  let normalAllowed = true;
  let sensitiveAllowed = false;
  let enabled = true;
  const store = new CompanionContributionStore({
    now: () => now,
    isPluginEnabled: () => enabled,
    canContribute: ({ sensitivity }) => sensitivity === "normal" ? normalAllowed : sensitiveAllowed,
  });

  assert.equal(store.submitFact(pluginId, { key: "normal", text: "A focus session is active.", expiresAt: now + 60_000 }), true);
  assert.equal(store.submitFact(pluginId, { key: "sensitive", text: "Private context.", sensitivity: "sensitive", expiresAt: now + 60_000 }), false);
  assert.deepEqual(store.snapshot().facts.map((fact) => fact.key), ["normal"]);

  normalAllowed = false;
  assert.equal(store.snapshot().facts.length, 0, "revoking normal plugin consent removes retained normal context");
  normalAllowed = true;
  sensitiveAllowed = true;
  assert.equal(store.submitFact(pluginId, { key: "sensitive", text: "Private context.", sensitivity: "sensitive", expiresAt: now + 60_000 }), true);
  enabled = false;
  assert.equal(store.size, 0, "disabling a plugin removes its retained context");

  enabled = true;
  now += 120_000;
  assert.equal(store.submitFact(pluginId, { key: "expiring", text: "Short-lived context.", expiresAt: now + 1_000 }), true);
  now += 1_001;
  assert.equal(store.snapshot().facts.length, 0, "expired facts are not returned");
}

// Contract: one semantic opportunity is eligible at a time and consumption enforces cooldown.
{
  let now = 2_000_000;
  const store = new CompanionContributionStore({
    now: () => now,
    isPluginEnabled: () => true,
    canContribute: () => true,
  });
  const base = { context: "A focus session is well underway.", urgency: "low" as const, earliestAt: now + 5_000, expiresAt: now + 60_000, dedupeKey: "focus.session.1", cooldownMs: 30_000 };
  assert.equal(store.submitOpportunity(pluginId, { ...base, key: "focus.first" }), true);
  assert.equal(store.submitOpportunity(pluginId, { ...base, key: "focus.updated", context: "The same session remains active." }), true);
  assert.equal(store.snapshot({ includeFutureOpportunities: true }).opportunities.length, 1, "dedupe identity replaces an older active opportunity");
  assert.equal(store.snapshot().opportunities.length, 0, "future opportunities are not eligible early");

  now += 5_000;
  const eligible = store.snapshot().opportunities[0];
  assert.ok(eligible);
  assert.equal(store.consumeOpportunity(eligible.id)?.key, "focus.updated");
  assert.equal(store.submitOpportunity(pluginId, { ...base, key: "focus.retry", earliestAt: now, expiresAt: now + 60_000 }), false, "consumed dedupe identity stays on cooldown");

  now += 30_001;
  assert.equal(store.submitOpportunity(pluginId, { ...base, key: "focus.next", earliestAt: now, expiresAt: now + 60_000 }), true);
  store.clearPlugin(pluginId);
  assert.equal(store.size, 0, "plugin teardown clears all in-memory contributions");
}

// Contract: a noisy plugin cannot grow the process-local store without bound.
{
  const now = 3_000_000;
  const store = new CompanionContributionStore({ now: () => now, isPluginEnabled: () => true, canContribute: () => true, maxPerPlugin: 1 });
  assert.equal(store.submitFact(pluginId, { key: "first", text: "First fact.", expiresAt: now + 60_000 }), true);
  assert.throws(() => store.submitFact(pluginId, { key: "second", text: "Second fact.", expiresAt: now + 60_000 }), /quota exceeded/);
}

console.log("Companion contribution store checks passed.");
