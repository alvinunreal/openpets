// Golden test for openpets.reminders.
//
// Runs two ways:
//   * `node test.js` (via scripts/test-plugins.mjs) — pure-helper unit checks
//     plus the harness-driven golden test.
//   * authored against `@open-pets/plugin-sdk/testing`; when that bare
//     specifier isn't resolvable from this directory we fall back to the
//     built workspace dist so the test still runs standalone.
import assert from "node:assert/strict";
import {
  cleanMessage,
  durationMs,
  summary,
  parseDueAt,
  register,
  MAX_REMINDERS,
} from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(
    new URL("../../../packages/sdk/dist/testing.js", import.meta.url)
  ));
}

// --- pure helper unit checks --------------------------------------------

assert.equal(cleanMessage("  hello\nthere  "), "hello there");
assert.equal(cleanMessage("", "fallback"), "fallback");
assert.equal(cleanMessage("x".repeat(500)).length, 140);
assert.equal(durationMs({ hours: 1, minutes: 30 }), 90 * 60_000);
assert.equal(durationMs({ minutes: 15 }), 15 * 60_000);
assert.throws(() => durationMs({ hours: 0, minutes: 0 }));
// Out-of-range fields are clamped, not rejected: 25h -> 23h is still valid.
assert.equal(durationMs({ hours: 25, minutes: 0 }), 23 * 60 * 60_000);
assert.equal(summary([]), "No active reminders.");
assert.equal(
  summary([{ id: "a", message: "tea", dueAt: 1_000 + 5 * 60_000 }], 1_000),
  "5 min: tea",
);
assert.equal(parseDueAt("2099-01-01T12:00:00Z", 0), Date.parse("2099-01-01T12:00:00Z"));
assert.throws(() => parseDueAt("2099-01-01T12:00:00"), /timezone|offset/i);

// --- golden harness test -------------------------------------------------

const PERMISSIONS = [
  "pet:speak",
  "pet:interact",
  "audio",
  "schedule",
  "storage",
  "commands",
  "status",
  "notify",
];

const LOCALES = {
  en: JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("./locales/en.json", import.meta.url),
      "utf8",
    ),
  ),
};

// 1) Setting a reminder via the form schedules it and stores it.
{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    config: { soundEnabled: true, osNotification: true, customSound: "gong" },
    locales: LOCALES,
    nowMs: 1_000_000,
  });
  await h.start();

  await h.runCommand("set-reminder", { message: "Drink water", hours: 0, minutes: 30 });
  h.expectStored("reminders", (v) => Array.isArray(v) && v.length === 1 && v[0].message === "Drink water");
  h.expectSpoke(/30 min/);
  assert.equal(h.calls.schedules.size, 1, "expected one scheduled reminder");

  // Advancing past the due time fires the acknowledge-pattern delivery.
  await h.clock.advance("31m");
  h.expectBubble({
    indicator: {
      icon: { kind: "icon", name: "reminder" },
      label: "Reminder",
      tone: "info",
      color: "#7c3aed",
      background: "#ede9fe",
      borderColor: "#c4b5fd",
    },
    tone: "info",
    sticky: true,
    priority: "high",
  });
  h.expectBubble({ textMatch: /Drink water/ });
  h.expectNotified(/Drink water/);
  assert.equal(h.calls.alerts.length, 1, "expected ctx.ui.alert delivery");
  assert.ok(h.calls.sounds.some((s) => s.sound === "gong"), "expected the custom alert sound to play");
  // Fired reminder is removed from storage.
  h.expectStored("reminders", (v) => Array.isArray(v) && v.length === 0);
  h.expectNoErrors();
}

// 2) A preset reminder fires and the Snooze action reschedules +5m.
{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    config: { soundEnabled: false, osNotification: false },
    locales: LOCALES,
    nowMs: 2_000_000,
  });
  await h.start();

  await h.runCommand("reminder-15");
  h.expectStored("reminders", (v) => v.length === 1);
  assert.equal(h.calls.sounds.length, 0, "sound disabled — nothing should play");

  await h.clock.advance("16m");
  const bubble = h.calls.bubbles[h.calls.bubbles.length - 1];
  assert.ok(bubble, "expected a delivery bubble");
  assert.deepEqual(
    bubble.spec.actions?.map((a) => a.id),
    ["done", "snooze"],
    "expected Done + Snooze actions",
  );
  assert.equal(h.calls.alerts.length, 1, "preset delivery should use ctx.ui.alert");
  assert.equal(h.calls.notifications.length, 0, "osNotification disabled — no notification");

  // Snooze: reschedules a fresh reminder ~5 minutes out.
  await h.fireBubbleAction(bubble.handle.id, "snooze");
  h.expectStored("reminders", (v) => v.length === 1 && v[0].dueAt > h.clock.now());
  h.expectNoErrors();
}

// 3) view-reminders lists pending items with a per-item cancel.
{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    locales: LOCALES,
    nowMs: 3_000_000,
  });
  await h.start();
  await h.runCommand("reminder-30");
  await h.runCommand("reminder-60");
  await h.runCommand("view-reminders");
  assert.equal(h.calls.menuItems.length, 2, "expected two pending menu items");

  // Selecting an item's cancel removes that reminder.
  await h.calls.menuItems[0].onSelect();
  h.expectStored("reminders", (v) => v.length === 1);
  h.expectNoErrors();
}

// 4) reconcile() on start fires overdue reminders as "missed".
{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    config: { soundEnabled: true, osNotification: true },
    locales: LOCALES,
    nowMs: 4_000_000,
  });
  // Seed storage with an already-overdue reminder before start().
  await h.ctx.storage.set("reminders", [
    { id: "reminder-old", message: "Stand up", dueAt: 4_000_000 - 60_000 },
  ]);
  await h.start();

  h.expectBubble({ textMatch: /Stand up/ });
  h.expectBubble({
    indicator: {
      icon: { kind: "icon", name: "reminder" },
      label: "Missed reminder",
      tone: "warning",
      color: "#d97706",
      background: "#fef3c7",
      borderColor: "#fbbf24",
    },
  });
  h.expectNotified(/Stand up/);
  h.expectStored("reminders", (v) => Array.isArray(v) && v.length === 0);
  h.expectNoErrors();
}

// 5) clear-reminders cancels everything.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES });
  await h.start();
  await h.runCommand("reminder-15");
  await h.runCommand("clear-reminders");
  h.expectStored("reminders", (v) => Array.isArray(v) && v.length === 0);
  assert.equal(h.calls.schedules.size, 0, "expected no scheduled reminders after clear");
  h.expectSpoke(/cleared/i);
  h.expectNoErrors();
}

// 6) test-reminder previews the alert without storing a reminder.
{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    config: { soundEnabled: false, osNotification: false },
    locales: LOCALES,
    nowMs: 5_000_000,
  });
  await h.start();
  await h.runCommand("test-reminder");
  h.expectBubble({ textMatch: /test reminder/i });
  h.expectBubble({
    indicator: {
      icon: { kind: "icon", name: "reminder" },
      label: "Reminder",
      tone: "info",
      color: "#7c3aed",
      background: "#ede9fe",
      borderColor: "#c4b5fd",
    },
    sticky: true,
    priority: "high",
  });
  h.expectStored("reminders", (v) => Array.isArray(v) && v.length === 0);
  h.expectNoErrors();
}

// 7) MAX_REMINDERS guard.
assert.equal(MAX_REMINDERS, 10);

// 8) Assistant capabilities expose the same reminder domain without direct-control speech.
{
  const now = Date.now();
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    locales: LOCALES,
    nowMs: now,
  });
  await h.start();
  assert.deepEqual(
    [...h.calls.assistantCapabilities.keys()],
    ["reminders.create", "reminders.list", "reminders.complete", "reminders.snooze", "reminders.remove"],
  );
  assert.equal(h.calls.assistantCapabilities.get("reminders.create").capability.inputSchema.properties.dueAt.type, "string");

  const dueAt = new Date(now + 30 * 60_000).toISOString();
  const created = await h.runCapability("reminders.create", { message: "Assistant water", dueAt });
  assert.equal(created.ok, true);
  assert.deepEqual(created.reminder, {
    id: created.reminder.id,
    message: "Assistant water",
    dueAt: Date.parse(dueAt),
  });
  assert.match(created.reminder.id, /^reminder-[A-Za-z0-9]+-[A-Za-z0-9]+$/);
  assert.equal(h.calls.speak.length, 0, "assistant creation must not use command speech");

  const listed = await h.runCapability("reminders.list", {});
  assert.deepEqual(listed.reminders, [created.reminder]);

  const snoozed = await h.runCapability("reminders.snooze", { id: created.reminder.id });
  assert.equal(snoozed.ok, true);
  assert.notEqual(snoozed.reminder.id, created.reminder.id);
  assert.equal(snoozed.reminder.message, created.reminder.message);
  assert.ok(snoozed.reminder.dueAt > now);
  assert.equal(h.calls.speak.length, 0, "assistant snooze must not use command speech");

  const completed = await h.runCapability("reminders.complete", { id: snoozed.reminder.id });
  assert.equal(completed.ok, true);
  assert.equal(completed.reminder.id, snoozed.reminder.id);
  assert.deepEqual((await h.runCapability("reminders.list", {})).reminders, []);

  const removable = await h.runCapability("reminders.create", {
    message: "Assistant remove",
    dueAt: new Date(now + 45 * 60_000).toISOString(),
  });
  const removed = await h.runCapability("reminders.remove", { id: removable.reminder.id });
  assert.equal(removed.ok, true);
  assert.equal(removed.reminder.id, removable.reminder.id);
  assert.deepEqual((await h.runCapability("reminders.list", {})).reminders, []);

  const invalid = await h.runCapability("reminders.complete", { id: "reminder-does-not-exist" });
  assert.deepEqual(invalid, { ok: false, error: "not_found", id: "reminder-does-not-exist" });
  await assert.rejects(
    () => h.runCapability("reminders.create", { message: "No guessing", dueAt: "tomorrow afternoon" }),
    /ISO timestamp|timezone|offset/i,
  );
  h.expectNoErrors();
}

// 9) Restart reconciliation restores schedules and delivers persisted overdue reminders.
{
  const now = Date.now();
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    config: { soundEnabled: false, osNotification: false },
    locales: LOCALES,
    nowMs: now,
  });
  await h.ctx.storage.set("reminders", [
    { id: "reminder-restart-1", message: "Restart check", dueAt: now - 60_000 },
    { id: "reminder-restart-2", message: "Still pending", dueAt: now + 60 * 60_000 },
  ]);
  await h.start();
  h.expectBubble({ textMatch: /Restart check/ });
  assert.equal(h.calls.schedules.size, 1);
  h.expectStored("reminders", (value) => value.length === 1 && value[0].id === "reminder-restart-2");
  const bubblesAfterFirstStart = h.calls.bubbles.length;

  await h.stop();
  await h.start();
  assert.equal(h.calls.bubbles.length, bubblesAfterFirstStart, "restart must not redeliver removed overdue reminders");
  assert.equal(h.calls.schedules.size, 1, "restart must reschedule persisted future reminders");
  h.expectNoErrors();
}

// 10) A scheduled fire and an overlapping assistant removal serialize their
// read/replace transactions instead of resurrecting or losing a reminder.
{
  const now = Date.now();
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    config: { soundEnabled: false, osNotification: false },
    locales: LOCALES,
    nowMs: now,
  });
  await h.start();
  const first = await h.runCapability("reminders.create", {
    message: "Fire me",
    dueAt: new Date(now + 60_000).toISOString(),
  });
  const second = await h.runCapability("reminders.create", {
    message: "Remove me",
    dueAt: new Date(now + 3 * 60_000).toISOString(),
  });

  const originalGet = h.ctx.storage.get;
  let signalFirstRead;
  const firstReadEntered = new Promise((resolve) => { signalFirstRead = resolve; });
  let releaseRead;
  const blockedRead = new Promise((resolve) => { releaseRead = resolve; });
  h.ctx.storage.get = async (key) => {
    if (key === "reminders" && signalFirstRead) {
      const signal = signalFirstRead;
      signalFirstRead = undefined;
      signal();
      await blockedRead;
    }
    return originalGet(key);
  };

  try {
    const fire = h.clock.advance("1m");
    await firstReadEntered;
    const remove = h.runCapability("reminders.remove", { id: second.reminder.id });
    releaseRead();
    await Promise.all([fire, remove]);
  } finally {
    h.ctx.storage.get = originalGet;
  }

  h.expectStored("reminders", (value) => Array.isArray(value) && value.length === 0);
  assert.equal(h.calls.schedules.size, 0, "serialized fire/remove must leave no stale schedules");
  assert.equal(
    h.calls.bubbles.filter((bubble) => bubble.spec.text?.includes(first.reminder.message)).length,
    1,
    "the fired reminder should be delivered exactly once",
  );
  h.expectNoErrors();
}

console.log("openpets.reminders: all checks passed.");
