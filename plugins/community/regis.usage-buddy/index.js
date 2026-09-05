const DEFAULT_MESSAGE = "Usage Buddy is watching your quota.";
const MAX_MESSAGE_LENGTH = 120;
const FETCH_TIMEOUT_MS = 4000;
export const DEFAULT_PORT = 45455;
const MIN_PORT = 1;
const MAX_PORT = 65535;

// Ordered band names, low -> high. Index is the count of thresholds a
// utilization percent has met or exceeded (see bandFor).
const BAND_NAMES = ["chill", "steady", "toasty", "low", "empty"];

const NUMBER_WORDS = {
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  fifteen: "15", thirty: "30", sixty: "60",
};
const UNIT_WORDS = {
  hour: "h", hours: "h", day: "d", days: "d",
  week: "w", weeks: "w", month: "mo", months: "mo",
  minute: "m", minutes: "m", min: "m",
};

function cleanMessage(value) {
  if (typeof value !== "string") return DEFAULT_MESSAGE;

  const cleaned = value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH)
    .trim();

  return cleaned || DEFAULT_MESSAGE;
}

export function normalizeConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  const pollSeconds = Number(config.pollSeconds);
  const port = Number(config.port);
  const filter = config.providerFilter;
  return {
    pollSeconds: Number.isFinite(pollSeconds) ? Math.max(15, pollSeconds) : 60,
    port: Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT ? port : DEFAULT_PORT,
    providerFilter: filter === "claude" || filter === "codex" ? filter : "both",
    thresholds: typeof config.thresholds === "string" ? config.thresholds : "50,75,90,100",
    quietStatus: config.quietStatus === true,
    hiddenWindows: parseHiddenWindows(
      typeof config.hiddenWindows === "string" ? config.hiddenWindows : "nimbus_quill",
    ),
  };
}

export function parseThresholds(value) {
  const parsed = String(value ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((num) => Number.isFinite(num))
    .sort((a, b) => a - b);
  return parsed.length > 0 ? parsed : [50, 75, 90, 100];
}

// Window keys (or a window's limit_name) to hide from the pet entirely: not
// shown in the summary/status and never used to drive mood or threshold speech.
export function parseHiddenWindows(value) {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function isHiddenWindow(key, window, hidden) {
  if (!hidden || hidden.length === 0) return false;
  if (hidden.includes(String(key).toLowerCase())) return true;
  const limitName = window && typeof window.limit_name === "string" ? window.limit_name.toLowerCase() : "";
  return limitName !== "" && hidden.includes(limitName);
}

export function selectedProviders(providerFilter) {
  if (providerFilter === "claude") return ["claude"];
  if (providerFilter === "codex") return ["codex"];
  return ["claude", "codex"];
}

// five_hour -> 5h, seven_day -> 7d, seven_day_sonnet -> 7d Sonnet, foo_bar -> Foo Bar.
export function prettyWindow(key) {
  const tokens = String(key ?? "").split("_").filter(Boolean);
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i].toLowerCase();
    const next = i + 1 < tokens.length ? tokens[i + 1].toLowerCase() : null;
    if (token in NUMBER_WORDS && next && next in UNIT_WORDS) {
      out.push(NUMBER_WORDS[token] + UNIT_WORDS[next]);
      i += 1;
    } else if (token in NUMBER_WORDS) {
      out.push(NUMBER_WORDS[token]);
    } else if (token in UNIT_WORDS) {
      out.push(UNIT_WORDS[token]);
    } else {
      out.push(token.charAt(0).toUpperCase() + token.slice(1));
    }
  }
  return out.join(" ") || String(key ?? "");
}

function providerWindows(provider) {
  return provider && provider.windows && typeof provider.windows === "object"
    ? provider.windows
    : {};
}

function displayName(providerId, provider) {
  const name = provider && typeof provider.display_name === "string" ? provider.display_name : "";
  return name || providerId;
}

function usageEntries(snapshot, providerFilter, hidden = []) {
  const providers = snapshot && snapshot.providers ? snapshot.providers : {};
  const entries = [];
  for (const id of selectedProviders(providerFilter)) {
    const provider = providers[id];
    if (!provider || provider.stale === true || provider.error) continue;
    for (const [key, window] of Object.entries(providerWindows(provider))) {
      if (isHiddenWindow(key, window, hidden)) continue;
      const pct = window && Number.isFinite(Number(window.utilization)) ? Number(window.utilization) : null;
      if (pct === null) continue;
      entries.push({
        providerId: id,
        name: displayName(id, provider),
        key,
        pct,
        resets_at: window && window.resets_at ? window.resets_at : null,
      });
    }
  }
  return entries;
}

// Informative roll-up of every window for the selected providers, each group
// led by its provider display_name. Providers without windows are omitted.
export function summaryLine(snapshot, providerFilter, hidden = []) {
  const providers = snapshot && snapshot.providers ? snapshot.providers : {};
  const groups = [];
  for (const id of selectedProviders(providerFilter)) {
    const provider = providers[id];
    if (!provider || provider.stale === true || provider.error) continue;
    const windows = providerWindows(provider);
    const parts = [];
    for (const [key, window] of Object.entries(windows)) {
      if (isHiddenWindow(key, window, hidden)) continue;
      const pct = window && Number.isFinite(Number(window.utilization)) ? Number(window.utilization) : null;
      if (pct === null) continue;
      parts.push(`${prettyWindow(key)}: ${pct}%`);
    }
    if (parts.length === 0) continue;
    groups.push(`${displayName(id, provider)} ${parts.join(" ")}`);
  }
  return groups.join(" ");
}

// Highest utilization across selected, usable providers/windows, or null.
export function maxEntry(snapshot, providerFilter, hidden = []) {
  return usageEntries(snapshot, providerFilter, hidden).reduce(
    (best, entry) => (!best || entry.pct > best.pct ? entry : best),
    null,
  );
}

// A provider is usable when present, fresh, error-free, and has at least one
// window. If none of the selected providers is usable, the monitor is offline.
export function isOffline(snapshot, providerFilter) {
  if (!snapshot || typeof snapshot !== "object") return true;
  const providers = snapshot.providers || {};
  for (const id of selectedProviders(providerFilter)) {
    const provider = providers[id];
    if (!provider || provider.stale === true || provider.error) continue;
    if (Object.keys(providerWindows(provider)).length > 0) return false;
  }
  return true;
}

export function bandFor(pct, thresholds) {
  const value = Number(pct);
  if (!Number.isFinite(value)) return 0;
  let band = 0;
  for (const threshold of parseThresholds(thresholds)) {
    if (value >= threshold) band += 1;
  }
  return band;
}

export function bandName(band) {
  return BAND_NAMES[Math.min(Math.max(band, 0), BAND_NAMES.length - 1)];
}

export function toneFor(pct) {
  const value = Number(pct);
  if (value >= 100) return "error";
  if (value >= 75) return "warning";
  if (value >= 50) return "info";
  return "success";
}

export function reactionFor(pct) {
  const value = Number(pct);
  if (value >= 100) return "error";
  if (value >= 90) return "waiting";
  if (value >= 75) return "working";
  if (value >= 50) return "thinking";
  return "idle";
}

export function pokemonLine(ctx, entry, thresholds) {
  const key = "line." + bandName(bandFor(entry.pct, thresholds));
  return ctx.t(key, {
    name: entry.name,
    pct: entry.pct,
    window: prettyWindow(entry.key),
  });
}

function storageKey(providerId, windowKey) {
  return `band:${providerId}:${windowKey}`;
}

async function fetchSnapshot(ctx, port) {
  const url = "http://127.0.0.1:" + port + "/usage";
  try {
    const res = await ctx.net.fetch(url, { method: "GET", timeoutMs: FETCH_TIMEOUT_MS });
    if (!res || !res.ok) return null;
    const body = res.json !== undefined ? res.json : JSON.parse(res.text);
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

// Persist the current band for every selected provider/window. Used to seed on
// the greeting run and to keep every window's stored band fresh on later ticks.
async function persistBands(ctx, snapshot, providerFilter, thresholds, hidden = [], excluded = new Set()) {
  for (const entry of usageEntries(snapshot, providerFilter, hidden)) {
    const key = storageKey(entry.providerId, entry.key);
    if (excluded.has(key)) continue;
    await ctx.storage.set(key, bandFor(entry.pct, thresholds));
  }
}

// Utilization at or above this is worth an unprompted alert on sight (the
// warning/error bands), even on the greeting tick.
const ALERT_PCT = 75;

// Best-effort warning diagnostics for failures that should not stop polling.
async function logFailure(ctx, event, data) {
  try {
    await ctx.log?.warn?.(`usage-buddy ${event}`, data);
  } catch {
    // failure diagnostics must never break polling
  }
}

// Speak the personality/threshold line for an entry and animate by level.
// Speech is the delivery boundary; a decorative reaction cannot replay it.
async function announce(ctx, entry, thresholds) {
  await ctx.pet.speak(cleanMessage(pokemonLine(ctx, entry, thresholds)));
  try {
    await ctx.pet.react(reactionFor(entry.pct));
  } catch (error) {
    await logFailure(ctx, "reaction-error", {
      providerId: entry.providerId,
      window: entry.key,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

// Best-effort diagnostics into the desktop app log (plugin scope). Never throws.
async function log(ctx, event, data) {
  try {
    await ctx.log?.info?.(`usage-buddy ${event}`, data);
  } catch {
    // logging must never break a tick
  }
}

// Returns true when a usable snapshot was read (so the caller knows the greeting
// happened), false when the monitor is offline.
export async function tick(ctx, { first = false } = {}) {
  const config = normalizeConfig(await ctx.config.get());
  lastPollDelayMs = config.pollSeconds * 1000;
  const snapshot = await fetchSnapshot(ctx, config.port);

  if (!snapshot || isOffline(snapshot, config.providerFilter)) {
    await ctx.status.set({ text: ctx.t("status.offline"), tone: "warning" });
    await log(ctx, "offline", { first });
    return false;
  }

  const hidden = config.hiddenWindows;
  const summary = cleanMessage(summaryLine(snapshot, config.providerFilter, hidden));
  const top = maxEntry(snapshot, config.providerFilter, hidden);
  const entries = usageEntries(snapshot, config.providerFilter, hidden);
  const maxPct = top ? top.pct : 0;
  const tone = toneFor(maxPct);
  const thresholds = parseThresholds(config.thresholds);

  if (!config.quietStatus || tone === "warning" || tone === "error") {
    await ctx.status.set({ text: summary, tone });
  }

  const nextBand = top ? bandFor(top.pct, thresholds) : 0;

  if (first) {
    await ctx.pet.speak(summary);
    // If usage is already elevated at enable, warn right away. The greeting
    // seeds bands, so a steady-high reading would otherwise never cross upward
    // and never alert.
    const alerted = !!(top && top.pct >= ALERT_PCT);
    if (alerted) {
      await announce(ctx, top, thresholds);
    }
    await persistBands(ctx, snapshot, config.providerFilter, thresholds, hidden);
    await log(ctx, "greeting", { top: top && top.key, pct: maxPct, band: nextBand, alerted });
    return true;
  }

  const crossedEntries = [];
  for (const entry of entries) {
    const previous = await ctx.storage.get(storageKey(entry.providerId, entry.key));
    if (typeof previous === "number" && bandFor(entry.pct, thresholds) > previous) {
      crossedEntries.push(entry);
    }
  }
  crossedEntries.sort((left, right) => right.pct - left.pct);
  const crossedKeys = new Set(crossedEntries.map((entry) => storageKey(entry.providerId, entry.key)));
  for (const entry of crossedEntries) {
    const key = storageKey(entry.providerId, entry.key);
    try {
      await announce(ctx, entry, thresholds);
      await ctx.storage.set(key, bandFor(entry.pct, thresholds));
    } catch (error) {
      await logFailure(ctx, "alert-error", {
        providerId: entry.providerId,
        window: entry.key,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const crossed = crossedEntries.length > 0;

  await persistBands(ctx, snapshot, config.providerFilter, thresholds, hidden, crossedKeys);
  await log(ctx, "tick", { top: top && top.key, pct: maxPct, band: nextBand, crossed });
  return true;
}

const POLL_ID = "poll";
const DEFAULT_POLL_DELAY_MS = 60_000;
const SCHEDULE_RETRY_DELAY_MS = 1_000;
// Module-scoped run flag shared by start/stop so the self-rescheduling loop
// stops re-arming after the plugin is disabled. One plugin instance per host.
let pollActive = false;
let pollGeneration = 0;
let retryTimer = null;
let retryToken = 0;
let scheduleInFlightGeneration = null;
let lastPollDelayMs = DEFAULT_POLL_DELAY_MS;

function isPollActive(generation) {
  return pollActive && generation === pollGeneration;
}

function clearRetryTimer() {
  retryToken += 1;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function armRetry(ctx, greeted, generation) {
  if (!isPollActive(generation) || retryTimer !== null) return;
  const token = ++retryToken;
  const timer = setTimeout(() => {
    if (retryTimer !== timer) return;
    retryTimer = null;
    if (!isPollActive(generation) || token !== retryToken) return;
    void schedulePoll(ctx, greeted, generation);
  }, SCHEDULE_RETRY_DELAY_MS);
  retryTimer = timer;
}

async function schedulePoll(ctx, greeted, generation) {
  if (!isPollActive(generation) || scheduleInFlightGeneration === generation) return;
  scheduleInFlightGeneration = generation;
  try {
    let delayMs = lastPollDelayMs;
    try {
      const config = normalizeConfig(await ctx.config.get());
      delayMs = config.pollSeconds * 1000;
      lastPollDelayMs = delayMs;
    } catch (error) {
      await logFailure(ctx, "config-error", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (!isPollActive(generation)) return;
    try {
      await ctx.schedule.once(POLL_ID, delayMs, () => pollLoop(ctx, greeted, generation));
      if (isPollActive(generation)) clearRetryTimer();
    } catch (error) {
      await logFailure(ctx, "schedule-error", {
        reason: error instanceof Error ? error.message : String(error),
      });
      armRetry(ctx, greeted, generation);
    }
  } finally {
    if (scheduleInFlightGeneration === generation) scheduleInFlightGeneration = null;
  }
}

// The host caps ctx.schedule.every() at a 10-minute minimum interval, so we run
// our own faster loop with ctx.schedule.once() (min 1ms), re-arming each cycle.
// `greeted` tracks whether the informative summary has been spoken yet; until it
// has (e.g. the monitor was offline at enable), every tick runs as the greeting.
async function pollLoop(ctx, greeted, generation) {
  if (!isPollActive(generation)) return;
  let greetedNow = greeted;
  try {
    greetedNow = ((await tick(ctx, { first: !greeted })) === true) || greeted;
  } catch (error) {
    await logFailure(ctx, "poll-error", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  await schedulePoll(ctx, greetedNow, generation);
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      const generation = ++pollGeneration;
      pollActive = true;
      clearRetryTimer();

      await ctx.commands.register(
        {
          id: "usage-now",
          title: ctx.t("commands.usageNow.title"),
          description: ctx.t("commands.usageNow.description"),
        },
        async () => {
          const current = normalizeConfig(await ctx.config.get());
          const snapshot = await fetchSnapshot(ctx, current.port);
          if (!snapshot || isOffline(snapshot, current.providerFilter)) {
            await ctx.status.set({ text: ctx.t("status.offline"), tone: "warning" });
            return;
          }
          await ctx.pet.speak(cleanMessage(summaryLine(snapshot, current.providerFilter, current.hiddenWindows)));
        },
      );

      await ctx.commands.register(
        {
          id: "usage-mood",
          title: ctx.t("commands.usageMood.title"),
          description: ctx.t("commands.usageMood.description"),
        },
        async () => {
          const current = normalizeConfig(await ctx.config.get());
          const snapshot = await fetchSnapshot(ctx, current.port);
          if (!snapshot || isOffline(snapshot, current.providerFilter)) {
            await ctx.status.set({ text: ctx.t("status.offline"), tone: "warning" });
            return;
          }
          const top = maxEntry(snapshot, current.providerFilter, current.hiddenWindows);
          if (!top) {
            await ctx.pet.speak(cleanMessage(summaryLine(snapshot, current.providerFilter, current.hiddenWindows)));
            return;
          }
          await announce(ctx, top, parseThresholds(current.thresholds));
        },
      );

      let greeted = false;
      try {
        greeted = (await tick(ctx, { first: true })) === true;
      } catch (error) {
        await logFailure(ctx, "poll-error", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      await schedulePoll(ctx, greeted, generation);
    },

    async stop(ctx) {
      pollActive = false;
      pollGeneration += 1;
      clearRetryTimer();
      await ctx?.schedule?.cancelAll?.();
      await ctx?.status?.clear?.();
    },
  });
}

if (typeof globalThis.OpenPetsPlugin !== "undefined") {
  register(globalThis.OpenPetsPlugin);
}
