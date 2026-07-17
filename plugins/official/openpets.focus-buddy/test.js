// Golden test for openpets.focus-buddy.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  LONG_BREAK_MS,
  SHORT_BREAK_MS,
  breakMs,
  focusMs,
  minutesLeft,
  register,
} from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(new URL("../../../packages/sdk/dist/testing.js", import.meta.url)));
}

assert.equal(focusMs({ focusLength: "25" }), 25 * 60_000);
assert.equal(focusMs({ focusLength: "45" }), 45 * 60_000);
assert.equal(focusMs({ focusLength: "bad" }), 25 * 60_000);
assert.equal(breakMs(1), SHORT_BREAK_MS);
assert.equal(breakMs(4), LONG_BREAK_MS);
assert.equal(minutesLeft({ endsAt: 61_000 }, 1_000), 1);
assert.equal(minutesLeft({ pausedRemainingMs: 121_000 }, 1_000), 3);

const PERMISSIONS = ["pet:speak", "pet:interact", "pet:pin", "audio", "schedule", "storage", "commands", "status", "companion:context"];
const LOCALES = { en: JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8")) };

// 1) Start schedules/stores and shows one pinned bubble.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { focusLength: "25", breakStyle: "normal" }, nowMs: 1_000_000 });
  await h.start();
  assert.deepEqual(h.calls.commands.get("start-focus")?.meta.icon, { kind: "icon", name: "focus" });
  await h.runCommand("start-focus");
  h.expectStored(
    "session",
    (v) => v.mode === "focus" && v.endsAt - v.startedAt === 25 * 60_000,
  );
  assert.equal(h.calls.schedules.size, 1, "expected focus end schedule");
  const opportunity = h.calls.companionContributions.find((entry) => entry.kind === "opportunity");
  assert.ok(opportunity, "an active focus session should offer one host-owned check-in opportunity");
  assert.equal(opportunity.spec.urgency, "low");
  assert.ok(opportunity.spec.earliestAt > h.calls.storage.get("session").startedAt, "the opportunity should not be eligible at session start");
  assert.ok(opportunity.spec.expiresAt < h.calls.storage.get("session").endsAt, "the opportunity should expire before deterministic focus completion");
  h.expectBubble({ textMatch: /Focus · 25 min left/, sticky: true });
  assert.equal(h.calls.alerts.length, 0, "start should not duplicate feedback with an alert");
  h.expectNoErrors();
}

// 2) Pause, resume, and end keep storage/schedule coherent.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 2_000_000 });
  await h.start();
  await h.runCommand("start-focus");
  await h.clock.advance("5m");
  await h.runCommand("pause-resume");
  h.expectStored("session", (v) => v.mode === "focus" && v.pausedRemainingMs > 0);
  assert.equal(h.calls.schedules.size, 0, "paused timer should not stay scheduled");
  await h.runCommand("pause-resume");
  h.expectStored("session", (v) => v.mode === "focus" && !v.pausedRemainingMs);
  assert.equal(h.calls.schedules.size, 1, "resumed timer should be scheduled");
  await h.runCommand("end-session");
  h.expectStored("session", null);
  assert.equal(h.calls.schedules.size, 0, "ended session should cancel schedule");
  h.expectNoErrors();
}

// 3) An optional Companion offer failure does not break the core focus session.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { focusLength: "25" }, nowMs: 2_500_000 });
  const warnings = [];
  h.ctx.log.warn = async (message, fields) => warnings.push({ message, fields });
  h.ctx.companion.offerOpportunity = async () => {
    throw new Error("quota exceeded");
  };
  await h.start();
  await h.runCommand("start-focus");
  h.expectStored(
    "session",
    (v) => v.mode === "focus" && v.endsAt - v.startedAt === 25 * 60_000,
  );
  assert.equal(h.calls.schedules.size, 1, "focus end should still be scheduled when the optional offer is rejected");
  h.expectBubble({ textMatch: /Focus · 25 min left/, sticky: true });
  assert.deepEqual(warnings.at(-1), {
    message: "focus buddy companion contribution skipped",
    fields: { operation: "offer-opportunity" },
  });
  h.expectNoErrors();
}

// 4) An optional Companion removal failure does not block ending a session.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 2_750_000 });
  const warnings = [];
  h.ctx.log.warn = async (message, fields) => warnings.push({ message, fields });
  await h.start();
  await h.runCommand("start-focus");
  h.ctx.companion.remove = async () => {
    throw new Error("runtime unavailable");
  };
  await h.runCommand("end-session");
  h.expectStored("session", null);
  assert.equal(h.calls.schedules.size, 0, "ending should still cancel the focus schedule when optional removal is rejected");
  assert.deepEqual(warnings.at(-1), {
    message: "focus buddy companion contribution skipped",
    fields: { operation: "remove" },
  });
  h.expectNoErrors();
}

// 5) Focus completion alerts once, with break actions and optional normal sound.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { focusLength: "25", breakStyle: "normal", sound: "gong" }, nowMs: 3_000_000 });
  await h.start();
  await h.runCommand("start-focus");
  await h.clock.advance("26m");
  h.expectBubble({ textMatch: /Nice focus session/ });
  assert.equal(h.calls.alerts.length, 1, "focus end should create one alert");
  const bubble = h.calls.bubbles[h.calls.bubbles.length - 1];
  assert.deepEqual(bubble.spec.actions.map((a) => a.id), ["start-break", "skip-break"]);
  assert.ok(h.calls.sounds.some((s) => s.sound === "gong"), "normal style should play configured sound");
  assert.equal(h.calls.reactions?.length ?? 0, 0, "no duplicate success reaction expected");
  await h.fireBubbleAction(bubble.handle.id, "start-break");
  h.expectStored("session", (v) => v.mode === "break" && v.completedFocusCount === 1);
  h.expectNoErrors();
}

// 6) Break completion alerts, gentle style stays silent, action can start focus.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { breakStyle: "gentle", sound: "gong" }, nowMs: 4_000_000 });
  const now = Date.now();
  await h.ctx.storage.set("session", { mode: "break", startedAt: now, endsAt: now + SHORT_BREAK_MS, pausedRemainingMs: null, completedFocusCount: 1 });
  await h.start();
  await h.clock.advance("6m");
  h.expectBubble({ textMatch: /Break is done/ });
  assert.equal(h.calls.alerts.length, 1, "break end should create one alert");
  assert.equal(h.calls.sounds.length, 0, "gentle style should stay silent");
  const bubble = h.calls.bubbles[h.calls.bubbles.length - 1];
  assert.deepEqual(bubble.spec.actions.map((a) => a.id), ["start-focus", "done"]);
  await h.fireBubbleAction(bubble.handle.id, "start-focus");
  h.expectStored("session", (v) => v.mode === "focus");
  h.expectNoErrors();
}

// 7) Reconcile future and overdue sessions.
{
  const future = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 5_000_000 });
  const futureNow = Date.now();
  await future.ctx.storage.set("session", { mode: "focus", startedAt: futureNow, endsAt: futureNow + 60_000, pausedRemainingMs: null, completedFocusCount: 0 });
  await future.start();
  assert.equal(future.calls.schedules.size, 1, "future session should reschedule on start");

  const overdueFocus = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 6_000_000 });
  await overdueFocus.ctx.storage.set("session", { mode: "focus", startedAt: Date.now() - 30 * 60_000, endsAt: Date.now() - 60_000, pausedRemainingMs: null, completedFocusCount: 0 });
  await overdueFocus.start();
  overdueFocus.expectBubble({ textMatch: /Nice focus session/ });

  const overdueBreak = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 7_000_000 });
  await overdueBreak.ctx.storage.set("session", { mode: "break", startedAt: Date.now() - 10 * 60_000, endsAt: Date.now() - 60_000, pausedRemainingMs: null, completedFocusCount: 1 });
  await overdueBreak.start();
  overdueBreak.expectStored("session", null);
  overdueBreak.expectSpoke(/Welcome back/);
}

console.log("openpets.focus-buddy: all checks passed.");
