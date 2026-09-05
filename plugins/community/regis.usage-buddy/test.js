import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  register,
  summaryLine,
  maxEntry,
  bandFor,
  prettyWindow,
  parseThresholds,
  normalizeConfig,
} from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(new URL("../../../packages/sdk/dist/testing.js", import.meta.url)));
}

const permissions = [
  "pet:speak",
  "pet:reaction",
  "commands",
  "status",
  "schedule",
  "network",
  "network:local",
  "storage",
];
const locales = {
  en: JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("./locales/en.json", import.meta.url),
      "utf8",
    ),
  ),
};

const config = {
  pollSeconds: 60,
  port: 45455,
  providerFilter: "both",
  thresholds: "50,75,90,100",
  quietStatus: false,
};

const USAGE_URL = "http://127.0.0.1:45455/usage";

function contract({ claude5h, claude7d, codex7d }) {
  return {
    schema: 1,
    generated_at: "2026-08-25T12:34:56Z",
    providers: {
      claude: {
        display_name: "Claude",
        stale: false,
        error: null,
        windows: {
          five_hour: { utilization: claude5h, resets_at: "2026-08-25T17:00:00Z" },
          seven_day: { utilization: claude7d, resets_at: "2026-09-01T00:00:00Z" },
        },
      },
      codex: {
        display_name: "Codex",
        stale: false,
        error: null,
        windows: {
          seven_day: { utilization: codex7d, resets_at: "2026-09-01T00:00:00Z" },
        },
      },
    },
  };
}

function fakeTimers() {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (handler, delayMs, ...args) => {
    const timer = {
      handler: () => handler(...args),
      delayMs,
      cleared: false,
      fired: false,
    };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };
  return {
    timers,
    async fire(index) {
      const timer = timers[index];
      assert.ok(timer, `expected fake timer ${index}`);
      timer.fired = true;
      await timer.handler();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    },
    restore() {
      globalThis.setTimeout = nativeSetTimeout;
      globalThis.clearTimeout = nativeClearTimeout;
    },
  };
}

// --- Pure helper unit tests -------------------------------------------------

const snapshot = contract({ claude5h: 12, claude7d: 1, codex7d: 3 });
assert.equal(
  summaryLine(snapshot, "both"),
  "Claude 5h: 12% 7d: 1% Codex 7d: 3%",
  "summaryLine rolls up every window led by display_name",
);
assert.equal(summaryLine(snapshot, "codex"), "Codex 7d: 3%", "summaryLine honors provider filter");
const staleSnapshot = contract({ claude5h: 12, claude7d: 1, codex7d: 3 });
staleSnapshot.providers.codex.stale = true;
assert.equal(
  summaryLine(staleSnapshot, "both"),
  "Claude 5h: 12% 7d: 1%",
  "summaryLine skips stale providers",
);
const hiddenSnapshot = contract({ claude5h: 12, claude7d: 1, codex7d: 3 });
hiddenSnapshot.providers.claude.windows.nimbus_quill = { utilization: 99, resets_at: "2026-08-25T17:00:00Z" };
assert.equal(maxEntry(hiddenSnapshot, "both").pct, 99, "without a hidden list, nimbus_quill would dominate");
assert.equal(
  summaryLine(hiddenSnapshot, "both", ["nimbus_quill"]),
  "Claude 5h: 12% 7d: 1% Codex 7d: 3%",
  "summaryLine suppresses hidden windows",
);
assert.equal(maxEntry(hiddenSnapshot, "both", ["nimbus_quill"]).pct, 12, "maxEntry ignores hidden windows");
assert.equal(prettyWindow("seven_day_sonnet"), "7d Sonnet", "prettyWindow prettifies unknown suffixes");
assert.equal(maxEntry(snapshot, "both").pct, 12, "maxEntry finds the highest utilization");
assert.equal(maxEntry(snapshot, "both").name, "Claude", "maxEntry reports the provider display_name");
assert.deepEqual(parseThresholds("90, 50 ,75,100"), [50, 75, 90, 100], "parseThresholds sorts");
assert.equal(bandFor(12, "50,75,90,100"), 0, "12% is band 0 (chill)");
assert.equal(bandFor(80, "50,75,90,100"), 2, "80% is band 2 (toasty)");
assert.equal(bandFor(100, "50,75,90,100"), 4, "100% is band 4 (empty)");
assert.equal(normalizeConfig({ port: 45456 }).port, 45456, "valid custom ports remain configurable");
assert.equal(normalizeConfig({ port: 0 }).port, 45455, "zero falls back to the companion port");
assert.equal(normalizeConfig({ port: 65536 }).port, 45455, "out-of-range ports fall back safely");
assert.equal(normalizeConfig({ port: 45455.5 }).port, 45455, "fractional ports fall back safely");
const manifest = JSON.parse(await readFile(new URL("./openpets.plugin.json", import.meta.url), "utf8"));
assert.deepEqual(manifest.network?.hosts, ["127.0.0.1:45455"], "the manifest keeps one exact loopback host:port");

// --- (a) First tick: informative summary + status, no band personality line -

const h = createTestHarness(register, { permissions, locales, config });
h.net.mock(USAGE_URL, { json: contract({ claude5h: 12, claude7d: 1, codex7d: 3 }) });

await h.start();

assert.ok(h.calls.commands.has("usage-now"), "registers the Usage Now command");
assert.ok(h.calls.commands.has("usage-mood"), "registers the Usage Alert command");
assert.ok(h.calls.schedules.has("poll"), "schedules the poll loop");
assert.equal(h.calls.speak.length, 1, "first run speaks exactly once");
assert.equal(
  h.calls.speak[0],
  "Claude 5h: 12% 7d: 1% Codex 7d: 3%",
  "first run speaks the informative summary (no band line)",
);
assert.ok(
  h.calls.status.some((status) => status.text === "Claude 5h: 12% 7d: 1% Codex 7d: 3%" && status.tone === "success"),
  "first run sets the summary status",
);
assert.equal(h.calls.react.length, 0, "first run does not react on a crossing");
assert.ok(h.calls.storage.has("band:claude:five_hour"), "first run seeds bands");

// --- (b) Upward crossings for every window push speaks and reactions ---------

h.net.mock(USAGE_URL, { json: contract({ claude5h: 80, claude7d: 1, codex7d: 3 }) });
await h.clock.advance("60s");

assert.equal(h.calls.speak.length, 2, "upward crossing adds one spoken line");
assert.match(h.calls.speak[1], /^Claude/, "band line starts with the provider display name");
assert.match(h.calls.speak[1], /toasty/i, "band line uses the toasty template");
assert.match(h.calls.speak[1], /80% 5h/, "band line includes pct and window tokens");
assert.ok(h.calls.react.includes("working"), "upward crossing triggers a reaction");

// The lower Codex window crosses 50% while Claude remains the highest window.
// Tracking only maxEntry would miss this alert.
h.net.mock(USAGE_URL, { json: contract({ claude5h: 80, claude7d: 1, codex7d: 60 }) });
await h.clock.advance("60s");
assert.equal(h.calls.speak.length, 3, "a non-top window crossing also speaks");
assert.match(h.calls.speak[2], /^Codex/, "the non-top crossing names its provider");
assert.match(h.calls.speak[2], /60% 7d/, "the non-top crossing cites its window");
assert.ok(h.calls.react.includes("thinking"), "the non-top crossing triggers its reaction");

// --- (c) No upward crossing stays quiet -------------------------------------

const speakCountAfterCrossing = h.calls.speak.length;
h.net.mock(USAGE_URL, { json: contract({ claude5h: 80, claude7d: 1, codex7d: 3 }) });
await h.clock.advance("60s");
assert.equal(h.calls.speak.length, speakCountAfterCrossing, "no new speak without an upward crossing");

h.expectNoErrors();
await h.stop();

// A failed crossing must not stop the poll loop or prevent later crossings.
// The failed speech remains uncheckpointed so it can retry on the next poll.
{
  const crossing = createTestHarness(register, { permissions, locales, config });
  crossing.net.mock(USAGE_URL, { json: contract({ claude5h: 12, claude7d: 1, codex7d: 3 }) });
  await crossing.start();
  const originalSpeak = crossing.ctx.pet.speak;
  let failClaudeSpeech = true;
  crossing.ctx.pet.speak = async (text) => {
    if (failClaudeSpeech && /^Claude/.test(String(text))) throw new Error("Claude alert speech failed");
    return originalSpeak(text);
  };
  crossing.net.mock(USAGE_URL, { json: contract({ claude5h: 80, claude7d: 1, codex7d: 60 }) });
  await crossing.clock.advance("60s");
  assert.ok(crossing.calls.speak.some((message) => /^Codex/.test(message)), "a later crossing is still handled after an earlier speech failure");
  assert.equal(crossing.calls.storage.get("band:claude:five_hour"), 0, "failed speech is not checkpointed");
  assert.equal(crossing.calls.storage.get("band:codex:seven_day"), 1, "the successful later crossing is checkpointed");
  assert.ok(crossing.calls.schedules.has("poll"), "a failed crossing leaves future polling active");

  failClaudeSpeech = false;
  await crossing.clock.advance("60s");
  assert.equal(crossing.calls.storage.get("band:claude:five_hour"), 2, "the failed crossing retries and is checkpointed after successful speech");
  crossing.expectNoErrors();
  await crossing.stop();
}

// Speech is the delivery boundary: a decorative reaction failure must not
// replay the spoken alert on the next poll.
{
  const reactionFailure = createTestHarness(register, { permissions, locales, config });
  reactionFailure.net.mock(USAGE_URL, { json: contract({ claude5h: 12, claude7d: 1, codex7d: 3 }) });
  await reactionFailure.start();
  const reactionLogs = [];
  reactionFailure.ctx.log.warn = async (message) => reactionLogs.push(message);
  reactionFailure.ctx.pet.react = async () => {
    throw new Error("decorative reaction failed");
  };
  reactionFailure.net.mock(USAGE_URL, { json: contract({ claude5h: 80, claude7d: 1, codex7d: 3 }) });
  await reactionFailure.clock.advance("60s");
  assert.ok(reactionFailure.calls.speak.some((message) => /80% 5h/.test(message)), "the alert is spoken");
  assert.equal(reactionFailure.calls.storage.get("band:claude:five_hour"), 2, "spoken alert is checkpointed despite reaction failure");
  assert.deepEqual(reactionLogs, ["usage-buddy reaction-error"], "reaction failure is logged separately");
  reactionFailure.expectNoErrors();
  await reactionFailure.stop();
}

// A transient tick rejection still schedules the next poll, while stop keeps
// an already-fired stale callback from rearming itself.
{
  const pollFailure = createTestHarness(register, { permissions, locales, config });
  const onceHandlers = [];
  const once = pollFailure.ctx.schedule.once;
  pollFailure.ctx.schedule.once = async (id, delayMs, handler) => {
    onceHandlers.push({ id, delayMs, handler });
    return once(id, delayMs, handler);
  };
  pollFailure.net.mock(USAGE_URL, { json: contract({ claude5h: 12, claude7d: 1, codex7d: 3 }) });
  await pollFailure.start();
  const statusSet = pollFailure.ctx.status.set;
  let failNextStatus = true;
  pollFailure.ctx.status.set = async (status) => {
    if (failNextStatus) {
      failNextStatus = false;
      throw new Error("transient tick rejection");
    }
    return statusSet(status);
  };
  await pollFailure.clock.advance("60s");
  assert.equal(onceHandlers.length, 2, "poll loop re-arms after a transient tick rejection");
  assert.equal(pollFailure.calls.schedules.size, 1);
  assert.deepEqual(pollFailure.calls.errors, [], "poll-loop failure is tolerated");
  const staleHandler = onceHandlers.at(-1).handler;
  await pollFailure.stop();
  await staleHandler();
  assert.equal(onceHandlers.length, 2, "stop prevents a stale poll callback from rearming");
}

// A temporary config read failure keeps the last valid interval and does not
// leave the monitor without a next poll.
{
  const timers = fakeTimers();
  try {
    const configFailure = createTestHarness(register, { permissions, locales, config: { ...config, pollSeconds: 30 } });
    configFailure.net.mock(USAGE_URL, { json: contract({ claude5h: 12, claude7d: 1, codex7d: 3 }) });
    const originalGet = configFailure.ctx.config.get;
    let configReads = 0;
    configFailure.ctx.config.get = async () => {
      configReads += 1;
      if (configReads === 2) throw new Error("transient config read failure");
      return originalGet();
    };
    await configFailure.start();
    assert.equal(configReads, 2);
    assert.ok(configFailure.calls.schedules.has("poll"), "a config read failure keeps polling scheduled");
    assert.equal(configFailure.calls.schedules.get("poll").intervalMs, 30_000, "the last valid interval is retained");
    assert.equal(timers.timers.length, 0, "config recovery does not create a fallback retry when schedule.once succeeds");

    await configFailure.clock.advance("30s");
    assert.ok(configReads >= 4, "the next poll retries the config read");
    assert.ok(configFailure.calls.schedules.has("poll"), "polling recovers after the config read failure");
    configFailure.expectNoErrors();
    await configFailure.stop();
  } finally {
    timers.restore();
  }
}

// A temporary schedule.once failure uses one cancellable fallback retry and
// leaves exactly one scheduled poll after recovery.
{
  const timers = fakeTimers();
  try {
    const scheduleFailure = createTestHarness(register, { permissions, locales, config });
    scheduleFailure.net.mock(USAGE_URL, { json: contract({ claude5h: 12, claude7d: 1, codex7d: 3 }) });
    const originalOnce = scheduleFailure.ctx.schedule.once;
    let attempts = 0;
    scheduleFailure.ctx.schedule.once = async (...args) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient schedule failure");
      return originalOnce(...args);
    };
    await scheduleFailure.start();
    assert.equal(attempts, 1);
    assert.equal(scheduleFailure.calls.schedules.size, 0);
    assert.equal(timers.timers.length, 1, "one fallback retry is arranged");
    assert.ok(timers.timers[0].delayMs >= 1_000, "fallback retry is not a tight loop");
    await timers.fire(0);
    assert.equal(attempts, 2, "the fallback retries schedule.once");
    assert.equal(scheduleFailure.calls.schedules.size, 1, "recovery leaves exactly one scheduled poll");
    assert.equal(timers.timers.filter((timer) => !timer.cleared && !timer.fired).length, 0, "successful recovery clears fallback state");
    scheduleFailure.expectNoErrors();
    await scheduleFailure.stop();
  } finally {
    timers.restore();
  }
}

// Repeated schedule failures do not accumulate concurrent fallback retries.
{
  const timers = fakeTimers();
  try {
    const repeatedFailure = createTestHarness(register, { permissions, locales, config });
    repeatedFailure.net.mock(USAGE_URL, { json: contract({ claude5h: 12, claude7d: 1, codex7d: 3 }) });
    repeatedFailure.ctx.schedule.once = async () => {
      throw new Error("schedule remains unavailable");
    };
    await repeatedFailure.start();
    assert.equal(timers.timers.length, 1);
    await timers.fire(0);
    assert.equal(timers.timers.length, 2, "one replacement retry follows the failed retry attempt");
    assert.equal(timers.timers.filter((timer) => !timer.cleared && !timer.fired).length, 1, "only one fallback retry is active");
    await timers.fire(1);
    assert.equal(timers.timers.length, 3);
    assert.equal(timers.timers.filter((timer) => !timer.cleared && !timer.fired).length, 1, "repeated failures still keep one fallback retry active");
    await repeatedFailure.stop();
  } finally {
    timers.restore();
  }
}

// Stopping during a fallback retry cancels it and prevents stale callbacks
// from scheduling a poll later.
{
  const timers = fakeTimers();
  try {
    const stopped = createTestHarness(register, { permissions, locales, config });
    stopped.net.mock(USAGE_URL, { json: contract({ claude5h: 12, claude7d: 1, codex7d: 3 }) });
    let attempts = 0;
    stopped.ctx.schedule.once = async () => {
      attempts += 1;
      throw new Error("schedule unavailable");
    };
    await stopped.start();
    assert.equal(timers.timers.length, 1);
    await stopped.stop();
    assert.equal(timers.timers[0].cleared, true, "stop cancels the fallback retry timer");
    await timers.fire(0);
    assert.equal(attempts, 1, "a stale fallback callback does not schedule after stop");
    assert.equal(stopped.calls.schedules.size, 0);
  } finally {
    timers.restore();
  }
}

// A custom port changes only the requested URL. The desktop bridge still
// applies the manifest's exact host:port approval to the real request.
{
  const custom = createTestHarness(register, {
    permissions,
    locales,
    config: { ...config, port: 45456 },
  });
  const customUrl = "http://127.0.0.1:45456/usage";
  custom.net.mock(customUrl, { json: contract({ claude5h: 12, claude7d: 1, codex7d: 3 }) });
  await custom.start();
  assert.equal(custom.calls.netCalls[0]?.url, customUrl, "custom port is used verbatim in the loopback URL");
  custom.expectNoErrors();
  await custom.stop();
}

// --- (d) Offline / thrown fetch sets warning status and does not speak -------

const offline = createTestHarness(register, { permissions, locales, config });
// No net mock registered -> ctx.net.fetch throws -> treated as offline.
await offline.start();

assert.equal(offline.calls.speak.length, 0, "offline monitor never speaks");
assert.ok(
  offline.calls.status.some((status) => status.text === "Usage monitor offline" && status.tone === "warning"),
  "offline monitor sets a warning status",
);
offline.expectNoErrors();
await offline.stop();

// --- (e) Offline at enable, then greets on the first successful snapshot ------

const late = createTestHarness(register, { permissions, locales, config });
await late.start();
assert.equal(late.calls.speak.length, 0, "no greeting while the monitor is offline");

late.net.mock(USAGE_URL, { json: contract({ claude5h: 12, claude7d: 1, codex7d: 3 }) });
await late.clock.advance("60s");

assert.equal(late.calls.speak.length, 1, "greets once the monitor comes online");
assert.equal(
  late.calls.speak[0],
  "Claude 5h: 12% 7d: 1% Codex 7d: 3%",
  "the late greeting is the informative summary",
);
assert.ok(late.calls.storage.has("band:claude:five_hour"), "the late greeting seeds bands");
late.expectNoErrors();
await late.stop();

// --- (f) Already elevated at enable: greet AND warn immediately --------------

const hot = createTestHarness(register, { permissions, locales, config });
hot.net.mock(USAGE_URL, { json: contract({ claude5h: 91, claude7d: 61, codex7d: 2 }) });
await hot.start();

assert.equal(hot.calls.speak.length, 2, "elevated enable speaks the summary and an immediate alert");
assert.match(hot.calls.speak[1], /^Claude/, "the immediate alert names the provider");
assert.match(hot.calls.speak[1], /91% 5h/, "the immediate alert cites the hot window");
assert.ok(hot.calls.react.length >= 1, "the immediate alert animates by level");
hot.expectNoErrors();
await hot.stop();

console.log("Usage Buddy tests passed.");
