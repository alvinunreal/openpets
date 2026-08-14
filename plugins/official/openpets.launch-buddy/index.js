// Launch Buddy (openpets.launch-buddy) — gentle startup greetings for SDK v3.

export const MAX_MESSAGE_LENGTH = 180;
export const MAX_DELAY_SECONDS = 60;
export const MAX_AWAY_HOURS = 72;
export const STORAGE_LAST_GREETING_AT = "lastGreetingAt";
export const STORAGE_LAST_GREETING_DATE = "lastGreetingDate";

const VALID_REACTIONS = new Set(["waving", "celebrating", "thinking", "success", "none"]);
const VALID_MODES = new Set(["smart", "custom", "random"]);
const VALID_FREQUENCIES = new Set(["everyLaunch", "oncePerDay", "afterAwayHours"]);

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function cleanMessage(value, fallback = "Hello!") {
  const text = typeof value === "string" ? value.trim().replace(/[\r\n]+/g, " ").replace(/\s+/g, " ") : "";
  return (text || fallback).slice(0, MAX_MESSAGE_LENGTH).trim() || fallback;
}

export function parseMessageList(value) {
  if (Array.isArray(value)) return value.map((v) => cleanMessage(v, "")).filter(Boolean).slice(0, 12);
  if (typeof value !== "string") return [];
  return value.split(/[\r\n]+/).map((v) => cleanMessage(v, "")).filter(Boolean).slice(0, 12);
}

export function normalizeConfig(config = {}) {
  const mode = VALID_MODES.has(config.greetingMode) ? config.greetingMode : "custom";
  const frequency = VALID_FREQUENCIES.has(config.frequency) ? config.frequency : "everyLaunch";
  const reaction = VALID_REACTIONS.has(config.reaction) ? config.reaction : "waving";
  return {
    enabled: config.enabled !== false,
    greetingMode: mode,
    customMessage: cleanMessage(config.customMessage, ""),
    messageList: parseMessageList(config.messageList),
    frequency,
    awayHours: clampNumber(config.awayHours, 1, MAX_AWAY_HOURS, 6),
    delaySeconds: clampNumber(config.delaySeconds, 0, MAX_DELAY_SECONDS, 3),
    reaction,
    soundEnabled: config.soundEnabled !== false,
    soundChoice: ["chime", "success", "custom"].includes(config.soundChoice) ? config.soundChoice : "chime",
    customSound: normalizeSoundRef(config.customSound),
  };
}

function normalizeSoundRef(value) {
  if (typeof value === "string") return value.trim() ? value.trim() : undefined;
  if (value && typeof value === "object") return value;
  return undefined;
}

export function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function timeBucket(now = Date.now()) {
  const hour = new Date(now).getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

export function deterministicIndex(length, now = Date.now()) {
  return length > 0 ? Math.abs(Math.floor(now / 60_000)) % length : 0;
}

export function shouldGreet({ enabled, frequency, awayHours }, state = {}, now = Date.now(), force = false) {
  if (force) return true;
  if (!enabled) return false;
  if (frequency === "everyLaunch") return true;
  if (frequency === "oncePerDay") return state.lastGreetingDate !== dayKey(now);
  const last = Number(state.lastGreetingAt || 0);
  return !last || now - last >= awayHours * 60 * 60_000;
}

export function selectMessage(ctx, config, now = Date.now()) {
  if (config.greetingMode === "custom") return resolveMessage(ctx, config.customMessage, "message.defaultCustom");
  if (config.greetingMode === "random") {
    const list = config.messageList.length ? config.messageList : [
      ctx.t("message.random.0"), ctx.t("message.random.1"), ctx.t("message.random.2"), ctx.t("message.random.3"),
    ];
    return cleanMessage(list[deterministicIndex(list.length, now)], ctx.t("message.fallback"));
  }
  return ctx.t(`message.smart.${timeBucket(now)}`);
}

function resolveMessage(ctx, value, fallbackKey) {
  const fallback = ctx.t(fallbackKey);
  const text = cleanMessage(value, fallback);
  return text.startsWith("$t:") ? ctx.t(text.slice(3)) : text;
}

async function readState(ctx) {
  return {
    lastGreetingAt: await ctx.storage.get(STORAGE_LAST_GREETING_AT),
    lastGreetingDate: await ctx.storage.get(STORAGE_LAST_GREETING_DATE),
  };
}

async function writeState(ctx, now) {
  await ctx.storage.set(STORAGE_LAST_GREETING_AT, now);
  await ctx.storage.set(STORAGE_LAST_GREETING_DATE, dayKey(now));
}

export async function greet(ctx, { force = false, now = Date.now() } = {}) {
  const config = normalizeConfig((await ctx.config.get()) ?? {});
  const state = await readState(ctx);
  if (!shouldGreet(config, state, now, force)) return false;

  const text = selectMessage(ctx, config, now);
  if (config.reaction !== "none") await ctx.pet.react(config.reaction, { showMessage: false });
  if (config.soundEnabled) {
    const sound = config.soundChoice === "custom" ? config.customSound : config.soundChoice;
    if (sound) await ctx.audio.play(sound);
  }
  await ctx.pet.speak({
    text,
    tone: "info",
    durationMs: 6500,
    dismissOn: ["petClick", "click"],
    priority: force ? "high" : "normal",
  });
  await writeState(ctx, now);
  return true;
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      await ctx.commands.register({ id: "greet-now", title: "$t:command.greetNow.title", description: "$t:command.greetNow.description", icon: "sparkles" }, () => greet(ctx, { force: true }));
      await ctx.commands.register({ id: "reset-launch-buddy", title: "$t:command.reset.title", description: "$t:command.reset.description", icon: "check" }, async () => {
        await ctx.storage.set(STORAGE_LAST_GREETING_AT, undefined);
        await ctx.storage.set(STORAGE_LAST_GREETING_DATE, undefined);
        await ctx.pet.speak(ctx.t("speech.reset"));
      });
      const config = normalizeConfig((await ctx.config.get()) ?? {});
      if (config.enabled) await ctx.schedule.once("launch-buddy-start", Math.max(1, config.delaySeconds * 1000), () => greet(ctx));
    },
    async stop() {},
  });
}
