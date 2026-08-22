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

// 1a) Assistant capabilities expose the focus lifecycle and use state-only feedback.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { focusLength: "25", breakStyle: "normal" }, nowMs: 1_250_000 });
  await h.start();
  assert.deepEqual([...h.calls.assistantCapabilities.keys()], ["focus.start", "focus.status", "focus.pause", "focus.resume", "focus.end"]);
  assert.deepEqual(h.calls.assistantCapabilities.get("focus.start")?.capability.inputSchema, {
    type: "object",
    properties: { minutes: { type: "integer", minimum: 1, maximum: 120 } },
    required: ["minutes"],
    additionalProperties: false,
  });
  assert.deepEqual(await h.runCapability("focus.start", { minutes: 10 }), {
    ok: true,
    state: "active",
    mode: "focus",
    minutes: 10,
    paused: false,
    completedFocusCount: 0,
  });
  h.expectStored("session", (v) => v.mode === "focus" && v.endsAt - v.startedAt === 10 * 60_000);
  assert.equal(h.calls.bubbles.length, 0, "assistant actions must not emit command speech or bubbles");
  assert.equal(h.calls.speak.length, 0, "assistant actions must not emit command speech or bubbles");
  assert.equal(h.calls.schedules.size, 2, "assistant start should use the normal timer schedules");
  h.expectNoErrors();
}

// 1b) Assistant lifecycle operations reject invalid states without changing the session.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 1_500_000 });
  await h.start();
  assert.deepEqual(await h.runCapability("focus.pause", {}), {
    ok: false,
    error: "no_active_session",
    state: "idle",
    mode: null,
    minutes: 0,
    paused: false,
    completedFocusCount: 0,
  });
  assert.deepEqual(await h.runCapability("focus.start", { minutes: 12.5 }), {
    ok: false,
    error: "invalid_duration",
    state: "idle",
    mode: null,
    minutes: 0,
    paused: false,
    completedFocusCount: 0,
  });
  assert.equal(h.calls.storage.has("session"), false, "invalid assistant input must not create a session");
  await h.runCapability("focus.start", { minutes: 12 });
  assert.deepEqual(await h.runCapability("focus.pause", {}), {
    ok: true,
    state: "paused",
    mode: "focus",
    minutes: 12,
    paused: true,
    completedFocusCount: 0,
  });
  assert.deepEqual(await h.runCapability("focus.pause", {}), {
    ok: false,
    error: "already_paused",
    state: "paused",
    mode: "focus",
    minutes: 12,
    paused: true,
    completedFocusCount: 0,
  });
  assert.deepEqual(await h.runCapability("focus.resume", {}), {
    ok: true,
    state: "active",
    mode: "focus",
    minutes: 12,
    paused: false,
    completedFocusCount: 0,
  });
  assert.deepEqual(await h.runCapability("focus.resume", {}), {
    ok: false,
    error: "not_paused",
    state: "active",
    mode: "focus",
    minutes: 12,
    paused: false,
    completedFocusCount: 0,
  });
  assert.deepEqual(await h.runCapability("focus.end", {}), {
    ok: true,
    state: "idle",
    mode: null,
    minutes: 0,
    paused: false,
    completedFocusCount: 0,
  });
  assert.deepEqual(await h.runCapability("focus.end", {}), {
    ok: false,
    error: "no_active_session",
    state: "idle",
    mode: null,
    minutes: 0,
    paused: false,
    completedFocusCount: 0,
  });
  assert.equal(h.calls.bubbles.length, 0, "assistant invalid states must not emit command bubbles");
  h.expectNoErrors();
}

// 1c) Assistant capabilities are restored with a persisted session after restart.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 1_750_000 });
  const now = Date.now();
  await h.ctx.storage.set("session", { mode: "focus", startedAt: now, endsAt: now + 10 * 60_000, pausedRemainingMs: null, completedFocusCount: 2 });
  await h.start();
  assert.equal(h.calls.assistantCapabilities.size, 5);
  assert.deepEqual(await h.runCapability("focus.status", {}), {
    ok: true,
    state: "active",
    mode: "focus",
    minutes: 10,
    paused: false,
    completedFocusCount: 2,
  });
  await h.stop();
  assert.equal(h.calls.assistantCapabilities.size, 0, "host stop should revoke assistant capabilities");
  await h.start();
  assert.equal(h.calls.assistantCapabilities.size, 5, "plugin restart should rediscover assistant capabilities");
  assert.deepEqual(await h.runCapability("focus.status", {}), {
    ok: true,
    state: "active",
    mode: "focus",
    minutes: 10,
    paused: false,
    completedFocusCount: 2,
  });
  h.expectNoErrors();
}

// 1d) Host stop is invoked without a context; the host owns schedule cleanup.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { focusLength: "25", breakStyle: "normal" }, nowMs: 1_500_000 });
  await h.start();
  await h.runCommand("start-focus");
  await h.stop();
  assert.equal(h.calls.schedules.size, 0, "host stop should clean up schedules");
  h.expectNoErrors();
}

// 1e) Assistant actions reconcile an existing direct-control bubble without creating speech or duplicates.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { focusLength: "25", breakStyle: "normal" }, nowMs: 1_900_000 });
  await h.start();
  await h.runCommand("start-focus");
  const bubble = h.calls.bubbles.at(-1);
  const speechCount = h.calls.speak.length;
  assert.ok(bubble, "direct start should create a pinned bubble");
  assert.equal(bubble.updates.length, 0);

  await h.runCapability("focus.start", { minutes: 10 });
  assert.equal(h.calls.bubbles.length, 1, "assistant start must reuse the existing pinned bubble");
  assert.equal(h.calls.speak.length, speechCount, "assistant start must not speak");
  assert.match(bubble.spec.text, /Focus · 10 min left/);
  assert.equal(bubble.updates.length, 1);

  await h.runCapability("focus.pause", {});
  assert.equal(h.calls.bubbles.length, 1, "assistant pause must not create a second bubble");
  assert.equal(h.calls.speak.length, speechCount, "assistant pause must not speak");
  assert.match(bubble.spec.text, /Focus paused · 10 min left/);
  assert.equal(bubble.updates.length, 2);

  await h.runCapability("focus.resume", {});
  assert.equal(h.calls.bubbles.length, 1, "assistant resume must not create a second bubble");
  assert.equal(h.calls.speak.length, speechCount, "assistant resume must not speak");
  assert.match(bubble.spec.text, /Focus · 10 min left/);
  assert.equal(bubble.updates.length, 3);

  await h.runCapability("focus.end", {});
  assert.equal(h.calls.bubbles.length, 1, "assistant end must not create a replacement bubble");
  assert.equal(h.calls.speak.length, speechCount, "assistant end must not speak");
  assert.equal(bubble.dismissed, true, "assistant end must dismiss the existing pinned bubble");
  assert.ok(h.calls.dismissedBubbles.includes(bubble.handle.id));
  h.expectStored("session", null);
  h.expectNoErrors();
}

// 1f) The harness follows the host's zero-argument stop contract.
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
