import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearCompanionMemory,
  commitCompanionAssistantTurn,
  commitCompanionProactiveTurn,
  commitCompanionUserTurn,
  companionMemoryFileName,
  companionMemoryRetentionMs,
  getCompanionMemorySnapshot,
  initializeCompanionMemory,
  maxCompanionMemoryContextEntries,
  maxCompanionMemoryEntries,
  maxCompanionMemoryEntriesPerPet,
  maxCompanionMemoryFileBytes,
  maxCompanionMemoryTextCharacters,
  normalizeCompanionMemory,
  removeCompanionMemoryForPet,
  selectRecentCompanionMemory,
} from "../src/companion-memory.js";

const root = mkdtempSync(join(tmpdir(), "openpets-companion-memory-"));
const now = Date.now();
try {
  initializeCompanionMemory(root, now);

  // Contract: the orchestrator has explicit commit operations for accepted user
  // turns and only-displayed assistant/proactive turns, with durable role labels.
  assert.equal(commitCompanionUserTurn({ petId: "pedra", text: "Hello", now: now - 2_000, id: "user-1" }).persisted, true);
  assert.equal(commitCompanionAssistantTurn({ petId: "pedra", text: "Hi Thomas", now: now - 1_000, id: "assistant-1" }).persisted, true);
  const proactiveMetadata = {
    candidateId: "focus-checkin-1",
    dedupeKey: "focus.daily",
    source: "plugin" as const,
    pluginId: "focus-buddy",
  };
  assert.equal(commitCompanionProactiveTurn({ petId: "pedra", text: "How is lunch going?", now, id: "proactive-1", proactive: proactiveMetadata }).persisted, true);
  assert.deepEqual(getCompanionMemorySnapshot(now).entries.map((entry) => entry.role), ["user", "assistant", "proactive"]);
  assert.deepEqual(getCompanionMemorySnapshot(now).entries[2]?.proactive, proactiveMetadata);

  // Contract: proactive policy identity survives a process restart so the same
  // candidate and plugin cannot bypass dedupe or daily accounting.
  assert.deepEqual(initializeCompanionMemory(root, now).entries[2]?.proactive, proactiveMetadata);

  // Contract: older proactive entries remain readable, while malformed or
  // over-broad metadata is discarded instead of becoming policy authority.
  const legacyAndUnsafe = normalizeCompanionMemory({
    version: 1,
    entries: [
      { id: "legacy-proactive", petId: "pedra", role: "proactive", text: "Legacy", createdAt: now - 1 },
      {
        id: "unsafe-proactive",
        petId: "pedra",
        role: "proactive",
        text: "Unsafe metadata",
        createdAt: now,
        proactive: { candidateId: "../../outside", dedupeKey: "unsafe", source: "plugin", pluginId: "focus-buddy" },
      },
    ],
  }, now);
  assert.equal(legacyAndUnsafe.entries.length, 2);
  assert.equal(legacyAndUnsafe.entries[0]?.proactive, undefined);
  assert.equal(legacyAndUnsafe.entries[1]?.proactive, undefined);

  // Contract: removing a pet and the user-facing clear operation remove entries
  // from both the runtime snapshot and the persisted file.
  commitCompanionUserTurn({ petId: "milo", text: "Hello Milo", now, id: "milo-1" });
  assert.equal(removeCompanionMemoryForPet("milo", now).persisted, true);
  assert.equal(getCompanionMemorySnapshot(now).entries.some((entry) => entry.petId === "milo"), false);
  const cleared = clearCompanionMemory();
  assert.equal(cleared.persisted, true);
  assert.deepEqual(cleared.snapshot.entries, []);
  assert.deepEqual((JSON.parse(readFileSync(join(root, companionMemoryFileName), "utf8")) as { entries: unknown[] }).entries, []);

  // Contract: stale, future-skewed, malformed, and oversized entries are pruned
  // at startup and normalized text cannot exceed the privacy ceiling.
  writeFileSync(join(root, companionMemoryFileName), JSON.stringify({
    version: 1,
    entries: [
      { id: "stale", petId: "pedra", role: "user", text: "old", createdAt: now - companionMemoryRetentionMs - 1 },
      { id: "fresh", petId: "pedra", role: "assistant", text: ` ${"x".repeat(maxCompanionMemoryTextCharacters + 50)} `, createdAt: now - 1 },
      { id: "future", petId: "pedra", role: "user", text: "future", createdAt: now + 60 * 60 * 1_000 },
      { id: "bad-role", petId: "pedra", role: "system", text: "ignore", createdAt: now },
    ],
  }));
  const pruned = initializeCompanionMemory(root, now);
  assert.deepEqual(pruned.entries.map((entry) => entry.id), ["fresh"]);
  assert.equal(pruned.entries[0]?.text.length, maxCompanionMemoryTextCharacters);

  const manyEntries = Array.from({ length: 320 }, (_, index) => ({
    id: `entry-${index}`,
    petId: `pet-${Math.floor(index / 80)}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `entry ${index}`,
    createdAt: now - 320 + index,
  }));
  const bounded = normalizeCompanionMemory({ version: 1, entries: manyEntries }, now);
  assert.equal(bounded.entries.length, maxCompanionMemoryEntries);
  for (const petId of new Set(bounded.entries.map((entry) => entry.petId))) {
    assert.ok(bounded.entries.filter((entry) => entry.petId === petId).length <= maxCompanionMemoryEntriesPerPet);
  }
  const multibyteBounded = normalizeCompanionMemory({
    version: 1,
    entries: Array.from({ length: maxCompanionMemoryEntries }, (_, index) => ({
      id: `emoji-${index}`,
      petId: `pet-${index % 4}`,
      role: "user",
      text: "🙂".repeat(maxCompanionMemoryTextCharacters),
      createdAt: now - maxCompanionMemoryEntries + index,
    })),
  }, now);
  assert.ok(Buffer.byteLength(`${JSON.stringify(multibyteBounded, null, 2)}\n`, "utf8") <= maxCompanionMemoryFileBytes);
  initializeCompanionMemory(root, now);
  for (let index = 0; index < maxCompanionMemoryContextEntries + 10; index += 1) {
    commitCompanionUserTurn({ petId: "pedra", text: `turn ${index}`, now: now + index, id: `turn-${index}` });
  }
  assert.equal(selectRecentCompanionMemory({ petId: "pedra", now: now + 100 }).length, maxCompanionMemoryContextEntries);

  // Contract: an unexpectedly oversized/corrupt file is replaced by a bounded
  // empty snapshot instead of being parsed into process memory indefinitely.
  writeFileSync(join(root, companionMemoryFileName), "x".repeat(maxCompanionMemoryFileBytes + 1));
  assert.deepEqual(initializeCompanionMemory(root, now).entries, []);
  assert.ok(statSync(join(root, companionMemoryFileName)).size < maxCompanionMemoryFileBytes);

  // Contract: a disk failure never blocks the live conversation; the mutation
  // is retained in runtime and explicitly reports that it was not persisted.
  const blockedPath = join(root, "not-a-directory");
  writeFileSync(blockedPath, "blocked");
  initializeCompanionMemory(blockedPath, now);
  const degraded = commitCompanionUserTurn({ petId: "pedra", text: "Still continue", now, id: "runtime-only" });
  assert.equal(degraded.persisted, false);
  assert.equal(getCompanionMemorySnapshot(now).entries[0]?.id, "runtime-only");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("Companion memory validation passed.");
