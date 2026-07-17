// Golden test for openpets.launch-buddy.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  cleanMessage,
  dayKey,
  deterministicIndex,
  normalizeConfig,
  parseMessageList,
  register,
  selectMessage,
  shouldGreet,
} from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(new URL("../../../packages/sdk/dist/testing.js", import.meta.url)));
}

assert.equal(cleanMessage("  hi\nthere  "), "hi there");
assert.equal(cleanMessage("", "fallback"), "fallback");
assert.equal(cleanMessage("x".repeat(500)).length, 180);
assert.deepEqual(parseMessageList("One\n\nTwo"), ["One", "Two"]);
assert.equal(normalizeConfig({ delaySeconds: 999, awayHours: 0, reaction: "nope" }).delaySeconds, 60);
assert.equal(normalizeConfig({ delaySeconds: 999, awayHours: 0, reaction: "nope" }).awayHours, 1);
assert.equal(normalizeConfig({ delaySeconds: 999, awayHours: 0, reaction: "nope" }).reaction, "waving");
assert.equal(normalizeConfig({}).greetingMode, "custom");
assert.equal(normalizeConfig({}).frequency, "everyLaunch");
assert.equal(normalizeConfig({}).delaySeconds, 3);
assert.equal(deterministicIndex(3, 180_000), 0);
assert.equal(shouldGreet({ enabled: false, frequency: "everyLaunch", awayHours: 6 }, {}, 0), false);
assert.equal(shouldGreet({ enabled: false, frequency: "everyLaunch", awayHours: 6 }, {}, 0, true), true);
assert.equal(shouldGreet({ enabled: true, frequency: "oncePerDay", awayHours: 6 }, { lastGreetingDate: "1970-01-01" }, 1_000), false);
assert.equal(shouldGreet({ enabled: true, frequency: "afterAwayHours", awayHours: 6 }, { lastGreetingAt: 0 }, 1_000), true);

const PERMISSIONS = ["pet:speak", "pet:reaction", "audio", "schedule", "storage", "commands"];
const LOCALES = { en: JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8")) };

// 1) Default startup greeting is a filled custom message and runs every launch.
{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    locales: LOCALES,
    nowMs: Date.UTC(2026, 0, 1, 9, 0, 0),
  });
  await h.start();
  assert.equal(h.calls.schedules.size, 1, "expected delayed launch greeting");
  await h.clock.advance("4s");
  h.expectSpoke(/Welcome back! I’m ready when you are\./);
  assert.equal(h.calls.bubbles.at(-1)?.spec.indicator, undefined, "launch greeting should not show an indicator header");
  h.expectReacted("waving");
  assert.deepEqual(h.calls.reactions[0], { reaction: "waving", options: { showMessage: false } }, "default launch reaction should be silent");
  h.expectNoErrors();
}

// 2) Startup greeting can still use once-per-day smart mode and configured sound/reaction.
{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    config: { enabled: true, greetingMode: "smart", frequency: "oncePerDay", delaySeconds: 2, reaction: "celebrating", soundEnabled: true, soundChoice: "success" },
    locales: LOCALES,
    nowMs: Date.UTC(2026, 0, 1, 9, 0, 0),
  });
  await h.start();
  assert.equal(h.calls.schedules.size, 1, "expected delayed launch greeting");
  await h.clock.advance("3s");
  h.expectSpoke(/Good (morning|afternoon|evening)|late/);
  h.expectReacted("celebrating");
  assert.deepEqual(h.calls.reactions[0], { reaction: "celebrating", options: { showMessage: false } }, "launch greeting reaction should be silent");
  assert.ok(h.calls.sounds.some((s) => s.sound === "success"), "expected selected sound");
  h.expectStored("lastGreetingDate", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
  h.expectNoErrors();
}

// 3) Once-per-day suppresses normal startup but greet-now forces a greeting.
{
  const nowMs = Date.UTC(2026, 0, 2, 13, 0, 0);
  const h = createTestHarness(register, { permissions: PERMISSIONS, config: { greetingMode: "smart", frequency: "oncePerDay", delaySeconds: 0, soundEnabled: false }, locales: LOCALES, nowMs });
  await h.start();
  await h.ctx.storage.set("lastGreetingDate", dayKey(Date.now()));
  await h.clock.advance("1s");
  assert.equal(h.calls.speak.length, 0, "normal launch should be gated");
  await h.runCommand("greet-now");
  h.expectSpoke(/Good (morning|afternoon|evening)|late/);
  assert.equal(h.calls.sounds.length, 0, "sound disabled — no audio");
  h.expectNoErrors();
}

// 4) Custom message mode and custom sound are honored.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, config: { greetingMode: "custom", customMessage: "Welcome, Captain.", frequency: "everyLaunch", delaySeconds: 0, reaction: "none", soundEnabled: true, soundChoice: "custom", customSound: "soft-pop" }, locales: LOCALES, nowMs: 10_000 });
  await h.start();
  await h.clock.advance("1s");
  h.expectSpoke(/Welcome, Captain\./);
  h.expectBubble({ durationMs: 6500 });
  assert.equal(h.calls.react.length, 0, "reaction none should not react");
  assert.equal(h.calls.reactions.length, 0, "reaction none should not record reaction options");
  assert.ok(h.calls.sounds.some((s) => s.sound === "soft-pop"), "expected custom sound");
  h.expectNoErrors();
}

// 5) Random mode uses the configured list deterministically.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, config: { greetingMode: "random", messageList: "Alpha\nBeta\nGamma", frequency: "everyLaunch", delaySeconds: 0, soundEnabled: false }, locales: LOCALES, nowMs: 120_000 });
  await h.start();
  await h.clock.advance("1s");
  h.expectSpoke(/Alpha|Beta|Gamma/);
  h.expectNoErrors();
}

// 6) Away-hours gate waits until enough time has passed, then reset clears state.
{
  const nowMs = 10 * 60 * 60_000;
  assert.equal(shouldGreet({ enabled: true, frequency: "afterAwayHours", awayHours: 6 }, { lastGreetingAt: nowMs - 5 * 60 * 60_000 }, nowMs), false);
  assert.equal(shouldGreet({ enabled: true, frequency: "afterAwayHours", awayHours: 6 }, { lastGreetingAt: nowMs - 7 * 60 * 60_000 }, nowMs), true);
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs });
  await h.start();
  await h.ctx.storage.set("lastGreetingAt", nowMs);
  await h.ctx.storage.set("lastGreetingDate", "1970-01-01");
  await h.runCommand("reset-launch-buddy");
  h.expectStored("lastGreetingAt", undefined);
  h.expectStored("lastGreetingDate", undefined);
  h.expectSpoke(/reset/i);
  h.expectNoErrors();
}

// Keep selectMessage covered without harness side effects.
assert.equal(selectMessage({ t: (k) => k }, normalizeConfig({ greetingMode: "smart" }), new Date(2026, 0, 1, 23).getTime()), "message.smart.night");
