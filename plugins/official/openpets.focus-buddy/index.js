// Focus Buddy (openpets.focus-buddy) — SDK v3 Pomodoro-style timer.

export const SCHEDULE_ID = "focus-buddy-session-end";
export const DISPLAY_REFRESH_SCHEDULE_ID = "focus-buddy-display-refresh";
export const STORAGE_KEY = "session";
export const SHORT_BREAK_MS = 5 * 60_000;
export const LONG_BREAK_MS = 15 * 60_000;
const DISPLAY_REFRESH_INTERVAL_MS = 60_000;
const MIN_ASSISTANT_FOCUS_MINUTES = 1;
const MAX_ASSISTANT_FOCUS_MINUTES = 120;

const pinnedBubbles = new WeakMap();
const contextStates = new WeakMap();

function stateFor(ctx) {
  let state = contextStates.get(ctx);
  if (!state) {
    state = { token: 0, queue: Promise.resolve() };
    contextStates.set(ctx, state);
  }
  return state;
}

function isCurrent(ctx, token) {
  return stateFor(ctx).token === token;
}

function enqueue(ctx, operation) {
  const state = stateFor(ctx);
  const previous = state.queue;
  const next = previous.catch(() => {}).then(operation);
  state.queue = next.catch(() => {});
  return next;
}

function lifecycle(ctx, operation, expectedToken) {
  if (expectedToken !== undefined && !isCurrent(ctx, expectedToken)) return Promise.resolve();
  return enqueue(ctx, () => {
    const state = stateFor(ctx);
    if (expectedToken !== undefined && state.token !== expectedToken) return undefined;
    const token = ++state.token;
    return operation(token);
  });
}

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

function assistantSessionStatus(session, now = Date.now()) {
  if (!active(session)) {
    return {
      state: "idle",
      mode: null,
      minutes: 0,
      paused: false,
      completedFocusCount: session?.completedFocusCount ?? 0,
    };
  }
  return {
    state: session.pausedRemainingMs ? "paused" : "active",
    mode: session.mode,
    minutes: minutesLeft(session, now),
    paused: Boolean(session.pausedRemainingMs),
    completedFocusCount: session.completedFocusCount ?? 0,
  };
}

function assistantSuccess(session) {
  return { ok: true, ...assistantSessionStatus(session) };
}

function assistantInvalid(error, session) {
  return { ok: false, error, ...assistantSessionStatus(session) };
}

function assistantFocusMinutes(input) {
  const minutes = input?.minutes;
  if (!Number.isInteger(minutes) || minutes < MIN_ASSISTANT_FOCUS_MINUTES || minutes > MAX_ASSISTANT_FOCUS_MINUTES) return null;
  return minutes;
}

function active(session) {
  return session && (session.mode === "focus" || session.mode === "break") && !session.ended;
}

async function getSession(ctx) {
  const session = await ctx.storage.get(STORAGE_KEY);
  return session && typeof session === "object" ? session : null;
}

async function saveSession(ctx, session, token) {
  if (!isCurrent(ctx, token)) return undefined;
  if (session) await ctx.storage.set(STORAGE_KEY, session);
  else await ctx.storage.set(STORAGE_KEY, null);
  if (!isCurrent(ctx, token)) return undefined;
  await updateStatus(ctx, session, token);
  return session;
}

async function config(ctx) {
  return (await ctx.config.get()) ?? {};
}

function shouldSound(cfg) {
  return cfg.breakStyle !== "gentle" && Boolean(cfg.sound);
}

async function updateStatus(ctx, session, token) {
  if (!isCurrent(ctx, token)) return;
  if (!active(session)) {
    await ctx.status.set({ text: ctx.t("status.idle"), tone: "info" });
    return;
  }
  const mode = session.mode === "focus" ? ctx.t("mode.focus") : ctx.t("mode.break");
  await ctx.status.set({ text: ctx.t("status.active", { mode, minutes: minutesLeft(session) }), tone: "info" });
}

async function scheduleEnd(ctx, session, token) {
  if (!isCurrent(ctx, token)) return;
  await ctx.schedule.cancel(SCHEDULE_ID);
  if (!isCurrent(ctx, token)) return;
  if (active(session) && !session.pausedRemainingMs) {
    await ctx.schedule.once(SCHEDULE_ID, Math.max(1, session.endsAt - Date.now()), () => completeSession(ctx, token));
    if (!isCurrent(ctx, token)) await ctx.schedule.cancel(SCHEDULE_ID);
  }
}

async function refreshDisplay(ctx, token) {
  if (!isCurrent(ctx, token)) return;
  const session = await getSession(ctx);
  await enqueue(ctx, async () => {
    if (!isCurrent(ctx, token)) return;
    if (!active(session) || session.pausedRemainingMs) {
      await ctx.schedule.cancel(DISPLAY_REFRESH_SCHEDULE_ID);
      if (!isCurrent(ctx, token)) return;
      await updateStatus(ctx, session, token);
      if (!isCurrent(ctx, token)) return;
      await updatePinned(ctx, session, token);
      return;
    }
    await updateStatus(ctx, session, token);
    if (!isCurrent(ctx, token)) return;
    await updatePinned(ctx, session, token);
    if (!isCurrent(ctx, token)) return;
    await scheduleDisplayRefresh(ctx, session, token);
  });
}

async function scheduleDisplayRefresh(ctx, session, token) {
  if (!isCurrent(ctx, token)) return;
  await ctx.schedule.cancel(DISPLAY_REFRESH_SCHEDULE_ID);
  if (!isCurrent(ctx, token)) return;
  if (active(session) && !session.pausedRemainingMs) {
    await ctx.schedule.once(DISPLAY_REFRESH_SCHEDULE_ID, DISPLAY_REFRESH_INTERVAL_MS, () => refreshDisplay(ctx, token));
    if (!isCurrent(ctx, token)) await ctx.schedule.cancel(DISPLAY_REFRESH_SCHEDULE_ID);
  }
}

async function updatePinned(ctx, session, token, { create = true } = {}) {
  if (!isCurrent(ctx, token)) return;
  const pinnedBubble = getPinnedBubble(ctx);
  if (!active(session)) {
    if (pinnedBubble) {
      try {
        await pinnedBubble.dismiss();
      } catch {}
      if (!isCurrent(ctx, token)) return;
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
      if (!isCurrent(ctx, token)) return;
      return;
    } catch {
      setPinnedBubble(ctx, null);
    }
  }
  if (!isCurrent(ctx, token)) return;
  if (!create) return;
  const nextBubble = await ctx.ui.bubble(spec);
  if (!isCurrent(ctx, token)) {
    try { await nextBubble.dismiss(); } catch {}
    return;
  }
  nextBubble.onAction((id) => handleAction(ctx, id));
  nextBubble.onDismiss(() => {
    if (getPinnedBubble(ctx)?.id === nextBubble.id) setPinnedBubble(ctx, null);
  });
  setPinnedBubble(ctx, nextBubble);
}

async function updateExistingPinned(ctx, session, token) {
  if (!getPinnedBubble(ctx)) return;
  await updatePinned(ctx, session, token, { create: false });
}

async function startMode(ctx, mode, durationMs, completedFocusCount, token, { showPinned = true, syncExistingPinned = false } = {}) {
  const now = Date.now();
  const session = await saveSession(ctx, { mode, startedAt: now, endsAt: now + durationMs, pausedRemainingMs: null, completedFocusCount }, token);
  if (!session || !isCurrent(ctx, token)) return undefined;
  await scheduleEnd(ctx, session, token);
  if (showPinned) await updatePinned(ctx, session, token);
  else if (syncExistingPinned) await updateExistingPinned(ctx, session, token);
  await scheduleDisplayRefresh(ctx, session, token);
  return session;
}

async function startFocusImpl(ctx, token, options) {
  const current = await getSession(ctx);
  if (!isCurrent(ctx, token)) return;
  const cfg = await config(ctx);
  if (!isCurrent(ctx, token)) return;
  return startMode(ctx, "focus", focusMs(cfg), current?.completedFocusCount ?? 0, token, options);
}

export async function startFocus(ctx) {
  return lifecycle(ctx, (token) => startFocusImpl(ctx, token));
}

async function startBreakImpl(ctx, completedFocusCount, token) {
  return startMode(ctx, "break", breakMs(completedFocusCount), completedFocusCount, token);
}

export async function startBreak(ctx, completedFocusCount) {
  return lifecycle(ctx, (token) => startBreakImpl(ctx, completedFocusCount, token));
}

async function changePauseStateImpl(ctx, action, token, { showPinned = true, syncExistingPinned = false } = {}) {
  const session = await getSession(ctx);
  if (!isCurrent(ctx, token)) return;
  if (!active(session)) return { kind: "invalid", session, error: "no_active_session" };
  if (action === "pause" && session.pausedRemainingMs) return { kind: "invalid", session, error: "already_paused" };
  if (action === "resume" && !session.pausedRemainingMs) return { kind: "invalid", session, error: "not_paused" };
  await ctx.schedule.cancel(DISPLAY_REFRESH_SCHEDULE_ID);
  if (!isCurrent(ctx, token)) return;
  if (session.pausedRemainingMs) {
    session.endsAt = Date.now() + session.pausedRemainingMs;
    session.pausedRemainingMs = null;
  } else {
    session.pausedRemainingMs = Math.max(1, session.endsAt - Date.now());
    await ctx.schedule.cancel(SCHEDULE_ID);
  }
  if (!isCurrent(ctx, token)) return;
  await saveSession(ctx, session, token);
  if (!isCurrent(ctx, token)) return;
  await scheduleEnd(ctx, session, token);
  if (showPinned) await updatePinned(ctx, session, token);
  else if (syncExistingPinned) await updateExistingPinned(ctx, session, token);
  await scheduleDisplayRefresh(ctx, session, token);
  return { kind: "updated", session };
}

async function pauseOrResumeImpl(ctx, token) {
  const result = await changePauseStateImpl(ctx, "toggle", token);
  if (result?.kind === "invalid" && result.error === "no_active_session") return startFocusImpl(ctx, token);
  return result?.session;
}

export async function pauseOrResume(ctx) {
  return lifecycle(ctx, (token) => pauseOrResumeImpl(ctx, token));
}

async function endSessionImpl(ctx, token, { showPinned = true, syncExistingPinned = false } = {}) {
  const session = await getSession(ctx);
  if (!isCurrent(ctx, token)) return;
  await ctx.schedule.cancel(SCHEDULE_ID);
  if (!isCurrent(ctx, token)) return;
  await ctx.schedule.cancel(DISPLAY_REFRESH_SCHEDULE_ID);
  if (!isCurrent(ctx, token)) return;
  const cleared = await saveSession(ctx, null, token);
  if (cleared === undefined || !isCurrent(ctx, token)) return;
  if (showPinned) await updatePinned(ctx, null, token);
  else if (syncExistingPinned) await updateExistingPinned(ctx, null, token);
  return session;
}

export async function endSession(ctx) {
  return lifecycle(ctx, (token) => endSessionImpl(ctx, token));
}

async function skipToBreakImpl(ctx, token) {
  const session = await getSession(ctx);
  const count = (session?.completedFocusCount ?? 0) + (session?.mode === "focus" ? 1 : 0);
  if (!isCurrent(ctx, token)) return;
  return startBreakImpl(ctx, count, token);
}

export async function skipToBreak(ctx) {
  return lifecycle(ctx, (token) => skipToBreakImpl(ctx, token));
}

async function focusComplete(ctx, session, token) {
  const completedFocusCount = (session?.completedFocusCount ?? 0) + 1;
  await saveSession(ctx, { ...session, mode: "complete", completedFocusCount }, token);
  if (!isCurrent(ctx, token)) return;
  await updatePinned(ctx, null, token);
  const cfg = await config(ctx);
  if (!isCurrent(ctx, token)) return;
  const alert = await ctx.ui.alert({
    text: ctx.t("alert.focusComplete.text"),
    indicator: { icon: ctx.assets.icon("focus"), label: ctx.t("alert.focusComplete.title"), tone: "success", color: "#059669", background: "#D1FAE5", borderColor: "#6EE7B7" },
    tone: "success",
    sound: shouldSound(cfg) ? cfg.sound : undefined,
    dismissOn: ["action", "petClick", "click"],
    actions: [{ id: "start-break", label: ctx.t("action.startBreak"), style: "primary" }, { id: "skip-break", label: ctx.t("action.skipBreak") }],
  });
  if (!isCurrent(ctx, token)) {
    try { await alert.dismiss(); } catch {}
    return;
  }
  alert.onAction((id) => (id === "start-break" ? startBreak(ctx, completedFocusCount) : endSession(ctx)));
}

async function breakComplete(ctx, session, token) {
  await saveSession(ctx, { ...session, mode: "complete" }, token);
  if (!isCurrent(ctx, token)) return;
  await updatePinned(ctx, null, token);
  const cfg = await config(ctx);
  if (!isCurrent(ctx, token)) return;
  const alert = await ctx.ui.alert({
    text: ctx.t("alert.breakComplete.text"),
    indicator: { icon: ctx.assets.icon("focus"), label: ctx.t("alert.breakComplete.title"), tone: "info", color: "#4F46E5", background: "#E0E7FF", borderColor: "#A5B4FC" },
    tone: "info",
    sound: shouldSound(cfg) ? cfg.sound : undefined,
    dismissOn: ["action", "petClick", "click"],
    actions: [{ id: "start-focus", label: ctx.t("action.startFocus"), style: "primary" }, { id: "done", label: ctx.t("action.done") }],
  });
  if (!isCurrent(ctx, token)) {
    try { await alert.dismiss(); } catch {}
    return;
  }
  alert.onAction((id) => (id === "start-focus" ? startFocus(ctx) : endSession(ctx)));
}

async function completeSessionImpl(ctx, token) {
  await ctx.schedule.cancel(SCHEDULE_ID);
  if (!isCurrent(ctx, token)) return;
  await ctx.schedule.cancel(DISPLAY_REFRESH_SCHEDULE_ID);
  const session = await getSession(ctx);
  if (!isCurrent(ctx, token)) return;
  if (!active(session)) return;
  if (session.mode === "focus") await focusComplete(ctx, session, token);
  else await breakComplete(ctx, session, token);
}

export async function completeSession(ctx, expectedToken) {
  return lifecycle(ctx, (token) => completeSessionImpl(ctx, token), expectedToken);
}

async function reconcileImpl(ctx, token) {
  await ctx.schedule.cancel(SCHEDULE_ID);
  if (!isCurrent(ctx, token)) return;
  await ctx.schedule.cancel(DISPLAY_REFRESH_SCHEDULE_ID);
  const session = await getSession(ctx);
  if (!isCurrent(ctx, token)) return;
  if (!active(session)) return updateStatus(ctx, null, token);
  if (session.pausedRemainingMs || session.endsAt > Date.now()) {
    await scheduleEnd(ctx, session, token);
    await updatePinned(ctx, session, token);
    await scheduleDisplayRefresh(ctx, session, token);
    return;
  }
  if (session.mode === "focus") await focusComplete(ctx, session, token);
  else {
    await saveSession(ctx, null, token);
    await updatePinned(ctx, null, token);
    await ctx.pet.speak(ctx.t("speech.breakOver"));
  }
}

export async function reconcile(ctx) {
  return lifecycle(ctx, (token) => reconcileImpl(ctx, token));
}

async function readStatusImpl(ctx, token, { showPinned = true, speakWhenIdle = true } = {}) {
  const session = await getSession(ctx);
  if (!isCurrent(ctx, token)) return;
  if (showPinned) {
    if (!active(session) && speakWhenIdle) return ctx.pet.speak(ctx.t("speech.idle"));
    await updatePinned(ctx, session, token);
  }
  return session;
}

async function showStatus(ctx) {
  return enqueue(ctx, async () => readStatusImpl(ctx, stateFor(ctx).token));
}

async function assistantStart(ctx, input) {
  return lifecycle(ctx, async (token) => {
    const current = await getSession(ctx);
    if (!isCurrent(ctx, token)) return;
    const minutes = assistantFocusMinutes(input);
    if (minutes === null) return assistantInvalid("invalid_duration", current);
    const session = await startMode(ctx, "focus", minutes * 60_000, current?.completedFocusCount ?? 0, token, { showPinned: false, syncExistingPinned: true });
    return session ? assistantSuccess(session) : assistantInvalid("session_unavailable", current);
  });
}

async function assistantStatus(ctx) {
  return enqueue(ctx, async () => {
    const session = await readStatusImpl(ctx, stateFor(ctx).token, { showPinned: false, speakWhenIdle: false });
    return assistantSuccess(session);
  });
}

async function assistantPauseOrResume(ctx, action) {
  return lifecycle(ctx, async (token) => {
    const result = await changePauseStateImpl(ctx, action, token, { showPinned: false, syncExistingPinned: true });
    if (!result || result.kind === "invalid") return assistantInvalid(result?.error ?? "session_unavailable", result?.session);
    return assistantSuccess(result.session);
  });
}

async function assistantEnd(ctx) {
  return lifecycle(ctx, async (token) => {
    const current = await getSession(ctx);
    if (!isCurrent(ctx, token)) return;
    if (!active(current)) return assistantInvalid("no_active_session", current);
    const ended = await endSessionImpl(ctx, token, { showPinned: false, syncExistingPinned: true });
    return ended ? assistantSuccess(null) : assistantInvalid("session_unavailable", current);
  });
}

async function registerAssistantCapabilities(ctx) {
  await ctx.assistant.registerCapability({
    id: "focus.start",
    description: "Start a focus session for an explicit duration in minutes.",
    inputSchema: {
      type: "object",
      properties: { minutes: { type: "integer", minimum: MIN_ASSISTANT_FOCUS_MINUTES, maximum: MAX_ASSISTANT_FOCUS_MINUTES } },
      required: ["minutes"],
      additionalProperties: false,
    },
  }, (input) => assistantStart(ctx, input));
  await ctx.assistant.registerCapability({
    id: "focus.status",
    description: "Read the current focus session status.",
    inputSchema: { type: "object", additionalProperties: false },
  }, () => assistantStatus(ctx));
  await ctx.assistant.registerCapability({
    id: "focus.pause",
    description: "Pause the active focus session.",
    inputSchema: { type: "object", additionalProperties: false },
  }, () => assistantPauseOrResume(ctx, "pause"));
  await ctx.assistant.registerCapability({
    id: "focus.resume",
    description: "Resume the paused focus session.",
    inputSchema: { type: "object", additionalProperties: false },
  }, () => assistantPauseOrResume(ctx, "resume"));
  await ctx.assistant.registerCapability({
    id: "focus.end",
    description: "End the active focus session.",
    inputSchema: { type: "object", additionalProperties: false },
  }, () => assistantEnd(ctx));
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
      await registerAssistantCapabilities(ctx);
    },
    async stop() {},
  });
}
