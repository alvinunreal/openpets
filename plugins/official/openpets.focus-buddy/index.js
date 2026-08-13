// Focus Buddy (openpets.focus-buddy) — SDK v3 Pomodoro-style timer.

export const SCHEDULE_ID = "focus-buddy-session-end";
export const DISPLAY_REFRESH_SCHEDULE_ID = "focus-buddy-display-refresh";
export const STORAGE_KEY = "session";
export const SHORT_BREAK_MS = 5 * 60_000;
export const LONG_BREAK_MS = 15 * 60_000;
const DISPLAY_REFRESH_INTERVAL_MS = 60_000;

const pinnedBubbles = new WeakMap();

function getPinnedBubble(ctx) {
  return pinnedBubbles.get(ctx) ?? null;
}

function setPinnedBubble(ctx, handle) {
  if (handle) pinnedBubbles.set(ctx, handle);
  else pinnedBubbles.delete(ctx);
}

export function focusMs(config = {}) {
  const minutes = [25, 45, 60].includes(Number(config.focusLength)) ? Number(config.focusLength) : 25;
  return minutes * 60_000;
}

export function breakMs(completedFocusCount = 0) {
  return completedFocusCount > 0 && completedFocusCount % 4 === 0 ? LONG_BREAK_MS : SHORT_BREAK_MS;
}

export function minutesLeft(session, now = Date.now()) {
  const ms = session?.pausedRemainingMs ?? Math.max(0, (session?.endsAt ?? now) - now);
  return Math.max(1, Math.ceil(ms / 60_000));
}

function active(session) {
  return session && (session.mode === "focus" || session.mode === "break") && !session.ended;
}

async function getSession(ctx) {
  const session = await ctx.storage.get(STORAGE_KEY);
  return session && typeof session === "object" ? session : null;
}

async function saveSession(ctx, session) {
  if (session) await ctx.storage.set(STORAGE_KEY, session);
  else await ctx.storage.set(STORAGE_KEY, null);
  await updateStatus(ctx, session);
  return session;
}

async function config(ctx) {
  return (await ctx.config.get()) ?? {};
}

function shouldSound(cfg) {
  return cfg.breakStyle !== "gentle" && Boolean(cfg.sound);
}

async function updateStatus(ctx, session) {
  if (!active(session)) {
    await ctx.status.set({ text: ctx.t("status.idle"), tone: "info" });
    return;
  }
  const mode = session.mode === "focus" ? ctx.t("mode.focus") : ctx.t("mode.break");
  await ctx.status.set({ text: ctx.t("status.active", { mode, minutes: minutesLeft(session) }), tone: "info" });
}

async function scheduleEnd(ctx, session) {
  await ctx.schedule.cancel(SCHEDULE_ID);
  if (active(session) && !session.pausedRemainingMs) {
    await ctx.schedule.once(SCHEDULE_ID, Math.max(1, session.endsAt - Date.now()), () => completeSession(ctx));
  }
}

async function refreshDisplay(ctx) {
  const session = await getSession(ctx);
  if (!active(session) || session.pausedRemainingMs) {
    await ctx.schedule.cancel(DISPLAY_REFRESH_SCHEDULE_ID);
    await updateStatus(ctx, session);
    await updatePinned(ctx, session);
    return;
  }
  await updateStatus(ctx, session);
  await updatePinned(ctx, session);
  await scheduleDisplayRefresh(ctx, session);
}

async function scheduleDisplayRefresh(ctx, session) {
  await ctx.schedule.cancel(DISPLAY_REFRESH_SCHEDULE_ID);
  if (active(session) && !session.pausedRemainingMs) {
    await ctx.schedule.once(DISPLAY_REFRESH_SCHEDULE_ID, DISPLAY_REFRESH_INTERVAL_MS, () => refreshDisplay(ctx));
  }
}

async function updatePinned(ctx, session) {
  const pinnedBubble = getPinnedBubble(ctx);
  if (!active(session)) {
    if (pinnedBubble) {
      try {
        await pinnedBubble.dismiss();
      } catch {}
    }
    setPinnedBubble(ctx, null);
    return;
  }
  const text = ctx.t(session.pausedRemainingMs ? "bubble.paused" : "bubble.active", {
    mode: session.mode === "focus" ? ctx.t("mode.focus") : ctx.t("mode.break"),
    minutes: minutesLeft(session),
  });
  const actions = session.pausedRemainingMs
    ? [{ id: "resume", label: ctx.t("action.resume"), style: "primary" }, { id: "end", label: ctx.t("action.end") }]
    : [
        { id: "pause", label: ctx.t("action.pause"), style: "primary" },
        { id: "end", label: ctx.t("action.end") },
        ...(session.mode === "focus" ? [{ id: "skip-break", label: ctx.t("action.skipToBreak") }] : []),
      ];
  const spec = { text, tone: "info", sticky: true, pin: true, priority: "normal", actions };
  if (pinnedBubble) {
    try {
      await pinnedBubble.update(spec);
      return;
    } catch {
      setPinnedBubble(ctx, null);
    }
  }
  const nextBubble = await ctx.ui.bubble(spec);
  nextBubble.onAction((id) => handleAction(ctx, id));
  nextBubble.onDismiss(() => {
    if (getPinnedBubble(ctx)?.id === nextBubble.id) setPinnedBubble(ctx, null);
  });
  setPinnedBubble(ctx, nextBubble);
}

async function startMode(ctx, mode, durationMs, completedFocusCount) {
  const now = Date.now();
  const session = await saveSession(ctx, { mode, startedAt: now, endsAt: now + durationMs, pausedRemainingMs: null, completedFocusCount });
  await scheduleEnd(ctx, session);
  await updatePinned(ctx, session);
  await scheduleDisplayRefresh(ctx, session);
  return session;
}

export async function startFocus(ctx) {
  const current = await getSession(ctx);
  return startMode(ctx, "focus", focusMs(await config(ctx)), current?.completedFocusCount ?? 0);
}

export async function startBreak(ctx, completedFocusCount) {
  return startMode(ctx, "break", breakMs(completedFocusCount), completedFocusCount);
}

export async function pauseOrResume(ctx) {
  const session = await getSession(ctx);
  if (!active(session)) return startFocus(ctx);
  await ctx.schedule.cancel(DISPLAY_REFRESH_SCHEDULE_ID);
  if (session.pausedRemainingMs) {
    session.endsAt = Date.now() + session.pausedRemainingMs;
    session.pausedRemainingMs = null;
  } else {
    session.pausedRemainingMs = Math.max(1, session.endsAt - Date.now());
    await ctx.schedule.cancel(SCHEDULE_ID);
  }
  await saveSession(ctx, session);
  await scheduleEnd(ctx, session);
  await updatePinned(ctx, session);
  await scheduleDisplayRefresh(ctx, session);
  return session;
}

export async function endSession(ctx) {
  await ctx.schedule.cancel(SCHEDULE_ID);
  await ctx.schedule.cancel(DISPLAY_REFRESH_SCHEDULE_ID);
  await saveSession(ctx, null);
  await updatePinned(ctx, null);
}

export async function skipToBreak(ctx) {
  const session = await getSession(ctx);
  const count = (session?.completedFocusCount ?? 0) + (session?.mode === "focus" ? 1 : 0);
  return startBreak(ctx, count);
}

async function focusComplete(ctx, session) {
  const completedFocusCount = (session?.completedFocusCount ?? 0) + 1;
  await saveSession(ctx, { ...session, mode: "complete", completedFocusCount });
  await updatePinned(ctx, null);
  const cfg = await config(ctx);
  const alert = await ctx.ui.alert({
    text: ctx.t("alert.focusComplete.text"),
    indicator: { icon: ctx.assets.icon("focus"), label: ctx.t("alert.focusComplete.title"), tone: "success", color: "#059669", background: "#D1FAE5", borderColor: "#6EE7B7" },
    tone: "success",
    sound: shouldSound(cfg) ? cfg.sound : undefined,
    dismissOn: ["action", "petClick", "click"],
    actions: [{ id: "start-break", label: ctx.t("action.startBreak"), style: "primary" }, { id: "skip-break", label: ctx.t("action.skipBreak") }],
  });
  alert.onAction((id) => (id === "start-break" ? startBreak(ctx, completedFocusCount) : endSession(ctx)));
}

async function breakComplete(ctx, session) {
  await saveSession(ctx, { ...session, mode: "complete" });
  await updatePinned(ctx, null);
  const cfg = await config(ctx);
  const alert = await ctx.ui.alert({
    text: ctx.t("alert.breakComplete.text"),
    indicator: { icon: ctx.assets.icon("focus"), label: ctx.t("alert.breakComplete.title"), tone: "info", color: "#4F46E5", background: "#E0E7FF", borderColor: "#A5B4FC" },
    tone: "info",
    sound: shouldSound(cfg) ? cfg.sound : undefined,
    dismissOn: ["action", "petClick", "click"],
    actions: [{ id: "start-focus", label: ctx.t("action.startFocus"), style: "primary" }, { id: "done", label: ctx.t("action.done") }],
  });
  alert.onAction((id) => (id === "start-focus" ? startFocus(ctx) : endSession(ctx)));
}

export async function completeSession(ctx) {
  await ctx.schedule.cancel(SCHEDULE_ID);
  await ctx.schedule.cancel(DISPLAY_REFRESH_SCHEDULE_ID);
  const session = await getSession(ctx);
  if (!active(session)) return;
  if (session.mode === "focus") await focusComplete(ctx, session);
  else await breakComplete(ctx, session);
}

export async function reconcile(ctx) {
  await ctx.schedule.cancel(SCHEDULE_ID);
  await ctx.schedule.cancel(DISPLAY_REFRESH_SCHEDULE_ID);
  const session = await getSession(ctx);
  if (!active(session)) return updateStatus(ctx, null);
  if (session.pausedRemainingMs || session.endsAt > Date.now()) {
    await scheduleEnd(ctx, session);
    await updatePinned(ctx, session);
    await scheduleDisplayRefresh(ctx, session);
    return;
  }
  if (session.mode === "focus") await focusComplete(ctx, session);
  else {
    await saveSession(ctx, null);
    await updatePinned(ctx, null);
    await ctx.pet.speak(ctx.t("speech.breakOver"));
  }
}

async function showStatus(ctx) {
  const session = await getSession(ctx);
  if (!active(session)) return ctx.pet.speak(ctx.t("speech.idle"));
  await updatePinned(ctx, session);
}

async function handleAction(ctx, id) {
  if (id === "pause" || id === "resume") return pauseOrResume(ctx);
  if (id === "end") return endSession(ctx);
  if (id === "skip-break") return skipToBreak(ctx);
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      await reconcile(ctx);
      const focusIcon = ctx.assets.icon("focus");
      await ctx.commands.register({ id: "start-focus", title: "$t:command.startFocus.title", description: "$t:command.startFocus.description", icon: focusIcon }, () => startFocus(ctx));
      await ctx.commands.register({ id: "pause-resume", title: "$t:command.pauseResume.title", description: "$t:command.pauseResume.description", icon: focusIcon }, () => pauseOrResume(ctx));
      await ctx.commands.register({ id: "end-session", title: "$t:command.endSession.title", description: "$t:command.endSession.description", icon: focusIcon }, () => endSession(ctx));
      await ctx.commands.register({ id: "skip-to-break", title: "$t:command.skipToBreak.title", description: "$t:command.skipToBreak.description", icon: focusIcon }, () => skipToBreak(ctx));
      await ctx.commands.register({ id: "show-status", title: "$t:command.showStatus.title", description: "$t:command.showStatus.description", icon: focusIcon }, () => showStatus(ctx));
    },
    async stop(ctx) {
      await ctx.schedule.cancel(SCHEDULE_ID);
      await ctx.schedule.cancel(DISPLAY_REFRESH_SCHEDULE_ID);
    },
  });
}
