// Golden test for openpets.focus-buddy.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  LONG_BREAK_MS,
  SHORT_BREAK_MS,
  DISPLAY_REFRESH_SCHEDULE_ID,
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

const PERMISSIONS = ["pet:speak", "pet:interact", "pet:pin", "audio", "schedule", "storage", "commands", "status"];
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
  assert.equal(h.calls.schedules.size, 2, "expected focus end and display refresh schedules");
  assert.ok(h.calls.schedules.has(DISPLAY_REFRESH_SCHEDULE_ID), "expected distinct display refresh schedule");
  h.expectBubble({ textMatch: /Focus · 25 min left/, sticky: true });
  assert.equal(h.calls.alerts.length, 0, "start should not duplicate feedback with an alert");
  h.expectNoErrors();
}

// 1b) Host stop is invoked without a context; the host owns schedule cleanup.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { focusLength: "25", breakStyle: "normal" }, nowMs: 1_500_000 });
  await h.start();
  await h.runCommand("start-focus");
  await h.stop();
  assert.equal(h.calls.schedules.size, 0, "host stop should clean up schedules");
  h.expectNoErrors();
}

// 1c) The harness follows the host's zero-argument stop contract.
{
  let stopArgumentCount = -1;
  const h = createTestHarness({
    async start() {},
    stop() { stopArgumentCount = arguments.length; },
  }, { permissions: [] });
  await h.start();
  await h.stop();
  assert.equal(stopArgumentCount, 0, "plugin stop must receive no context argument");
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
  assert.equal(h.calls.schedules.size, 2, "resumed timer should have both schedules");
  await h.runCommand("end-session");
  h.expectStored("session", null);
  assert.equal(h.calls.schedules.size, 0, "ended session should cancel schedule");
  h.expectNoErrors();
}

// 3) A running timer refreshes the visible bubble and status after one minute without an action.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { focusLength: "25", breakStyle: "normal" }, nowMs: 2_500_000 });
  await h.start();
  await h.runCommand("start-focus");
  const bubble = h.calls.bubbles[h.calls.bubbles.length - 1];
  const statusCount = h.calls.status.length;
  assert.equal(bubble.updates.length, 0, "start should not need a display refresh yet");
  await h.clock.advance("1m");
  assert.equal(bubble.updates.length, 1, "running timer should refresh its visible bubble after one minute");
  assert.equal(h.calls.status.length, statusCount + 1, "running timer should refresh status after one minute");
  assert.equal(h.calls.schedules.get(DISPLAY_REFRESH_SCHEDULE_ID)?.type, "once", "display refresh should re-arm as one one-shot schedule");
  assert.match(bubble.spec.text, /Focus · \d+ min left/);
  assert.match(h.calls.status.at(-1)?.text ?? "", /Focus · \d+ min left/);
  h.expectNoErrors();
}

// 3b) A stale refresh that is already reading storage cannot replace the resumed refresh.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { focusLength: "25", breakStyle: "normal" }, nowMs: 2_750_000 });
  await h.start();
  await h.runCommand("start-focus");
  const bubble = h.calls.bubbles.at(-1);
  const refreshHandler = h.calls.schedules.get(DISPLAY_REFRESH_SCHEDULE_ID)?.handler;
  assert.ok(refreshHandler, "expected a display refresh handler");

  let beginRead;
  let releaseRead;
  const readStarted = new Promise((resolve) => { beginRead = resolve; });
  const blockedRead = new Promise((resolve) => { releaseRead = resolve; });
  const originalGet = h.ctx.storage.get;
  let blockNextRead = true;
  h.ctx.storage.get = async (key) => {
    if (key === "session" && blockNextRead) {
      blockNextRead = false;
      beginRead();
      await blockedRead;
    }
    return originalGet(key);
  };

  const staleRefresh = refreshHandler();
  await readStarted;
  await h.runCommand("pause-resume");
  await h.runCommand("pause-resume");
  const resumedSchedule = h.calls.schedules.get(DISPLAY_REFRESH_SCHEDULE_ID);
  assert.ok(resumedSchedule, "resume should create a fresh display refresh schedule");
  assert.match(bubble.spec.text, /Focus · \d+ min left/, "resume should restore the active timer UI");

  releaseRead();
  await staleRefresh;
  assert.equal(h.calls.schedules.get(DISPLAY_REFRESH_SCHEDULE_ID), resumedSchedule, "stale refresh must not replace the resumed schedule");
  assert.match(bubble.spec.text, /Focus · \d+ min left/, "stale refresh must not restore stale UI");
  h.expectNoErrors();
}

// 4) Focus completion alerts once, with break actions and optional normal sound.
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

// 5) Break completion alerts, gentle style stays silent, action can start focus.
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

// 6) Reconcile future and overdue sessions.
{
  const future = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 5_000_000 });
  const futureNow = Date.now();
  await future.ctx.storage.set("session", { mode: "focus", startedAt: futureNow, endsAt: futureNow + 60_000, pausedRemainingMs: null, completedFocusCount: 0 });
  await future.start();
  assert.equal(future.calls.schedules.size, 2, "future session should reschedule end and display refresh");

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
