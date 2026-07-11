export const GOOGLE_CLIENT_ID = "365943393749-peltgp853ts54b0p9a8gmqo75pq02cp6.apps.googleusercontent.com";
export const GOOGLE_CLIENT_SECRET = "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";
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const SYNC_MS = 10 * 60_000;
export const GRACE_MS = 2 * 60_000;
export const HORIZON_MS = 30 * 24 * 60 * 60_000;
export const LEDGER_CAP = 5000;
export const DELIVERY_EXPIRES_MARGIN_MS = 30_000;
export const DEFAULT_COURIER = "courier-airdog";
const STATE_KEY = "calendar-airmail-state";
const NEXT_SCHEDULE = "calendar-airmail-next";
const SYNC_SCHEDULE = "calendar-airmail-sync";
let session = null;
let stateQueue = Promise.resolve();
const commandManagers = new WeakMap();

const emptyState = () => ({ connected: false, occurrences: [], pending: [], delivered: [] });
const nowIso = (time) => new Date(time).toISOString();
const text = (value, limit) => typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit) : "";
const hash = (value, seed) => { let h = seed; for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); };
export const deliveryKey = (occurrence, offset) => `calendar.${hash(`${occurrence.eventId}\u0000${occurrence.startAt}`, 0x811c9dc5)}.${hash(`${occurrence.key}\u0000${occurrence.endAt}`, 0x9e3779b9)}.${offset}`;

export function normalizeEvents(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).flatMap((event) => {
    if (!event || event.status === "cancelled" || typeof event.id !== "string" || !event.start?.dateTime || !event.end?.dateTime) return [];
    const startAt = Date.parse(event.start.dateTime); const endAt = Date.parse(event.end.dateTime);
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt) return [];
    const key = `${event.id}\u0000${event.start.dateTime}`;
    if (seen.has(key)) return []; seen.add(key);
    return [{ key, eventId: event.id, title: text(event.summary, 160), startAt, endAt }];
  });
}

function validState(value) {
  const state = value && typeof value === "object" ? value : emptyState();
  return { connected: state.connected === true, occurrences: Array.isArray(state.occurrences) ? state.occurrences.filter((x) => x && typeof x.key === "string" && Number.isFinite(x.startAt) && Number.isFinite(x.endAt)) : [], pending: Array.isArray(state.pending) ? state.pending.filter((x) => x && typeof x.key === "string" && Number.isFinite(x.dueAt) && x.occurrence).map((x) => Number.isFinite(x.retryAt) ? x : { ...x, retryAt: undefined }) : [], delivered: Array.isArray(state.delivered) ? state.delivered.filter((x) => x && typeof x.key === "string" && Number.isFinite(x.at)) : [] };
}
async function read(ctx) { return validState(await ctx.storage.get(STATE_KEY)); }
async function write(ctx, state) { await ctx.storage.set(STATE_KEY, state); }
function exclusive(work) { const next = stateQueue.then(work, work); stateQueue = next.catch(() => undefined); return next; }
function prune(state, now) {
  const pendingFloor = now - GRACE_MS; const ceiling = now + HORIZON_MS + GRACE_MS;
  state.occurrences = state.occurrences.filter((item) => item.startAt >= pendingFloor && item.startAt <= ceiling);
  state.pending = state.pending.filter((item) => item.dueAt >= pendingFloor && item.dueAt <= ceiling);
  state.delivered = state.delivered.filter((item) => item.at >= now - HORIZON_MS - GRACE_MS && item.at <= ceiling).sort((a, b) => a.at - b.at).slice(-LEDGER_CAP);
}
function rebuildPending(state, now) {
  const delivered = new Set(state.delivered.map((item) => item.key));
  state.pending = state.occurrences.flatMap((occurrence) => [600_000, 0].map((offset) => ({ key: deliveryKey(occurrence, offset), dueAt: occurrence.startAt - offset, offset, occurrence }))).filter((item) => item.dueAt >= now - GRACE_MS && !delivered.has(item.key)).sort((a, b) => a.dueAt - b.dueAt);
}
async function status(ctx, key, vars, tone = "info") { await ctx.status.set({ text: text(ctx.t(key, vars), 500), tone }); }
async function courier(ctx) { const config = await ctx.config.get(); return typeof config?.courier === "string" && config.courier ? config.courier : DEFAULT_COURIER; }
function localDateTime(ctx, time) { return new Intl.DateTimeFormat(ctx.locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(time)); }
function nextOccurrence(state) { return state.occurrences.reduce((next, occurrence) => !next || occurrence.startAt < next.startAt ? occurrence : next, null); }
async function syncedStatus(ctx, state) {
  const next = nextOccurrence(state);
  if (!next) return status(ctx, "status.syncedEmpty", undefined, "success");
  const reminder = state.pending.filter((item) => item.occurrence?.key === next.key).reduce((earliest, item) => !earliest || item.dueAt < earliest.dueAt ? item : earliest, null);
  return status(ctx, "status.syncedNext", { count: state.occurrences.length, title: text(next.title || next.eventId, 160), startAt: localDateTime(ctx, next.startAt), reminderAt: reminder ? localDateTime(ctx, reminder.dueAt) : ctx.t("status.noReminder") }, "success");
}
function commandManager(ctx) {
  let manager = commandManagers.get(ctx);
  if (!manager) { manager = { queue: Promise.resolve() }; commandManagers.set(ctx, manager); }
  return manager;
}
async function updateCommands(ctx, connected) {
  const manager = commandManager(ctx);
  const task = manager.queue.then(async () => {
    await Promise.all(["connect", "sync-now", "disconnect", "test-delivery"].map((id) => ctx.commands.unregister(id)));
    if (!connected) return ctx.commands.register({ id: "connect", title: "$t:command.connect.title", description: "$t:command.connect.description", icon: "bell", timeoutMs: 5 * 60_000 }, async () => {
      await ctx.log.info("calendar airmail connection requested");
      try {
        const tokens = await ctx.auth.oauth({ provider: "google", clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, scopes: [GOOGLE_SCOPE] });
        session = tokens;
        await exclusive(async () => { const state = await read(ctx); state.connected = true; await write(ctx, state); });
        await updateCommands(ctx, true); await status(ctx, "status.connected", undefined, "success"); await sync(ctx);
      } catch (error) {
        await ctx.log.warn("calendar airmail auth failure", { classification: error?.code === "invalid_grant" ? "invalid_grant" : "oauth_failed" });
        throw error;
      }
    });
    await ctx.commands.register({ id: "sync-now", title: "$t:command.sync.title", description: "$t:command.sync.description", icon: "timer" }, () => sync(ctx));
    await ctx.commands.register({ id: "disconnect", title: "$t:command.disconnect.title", description: "$t:command.disconnect.description", icon: "bell" }, async () => {
      await ctx.auth.signOut("google"); session = null;
      await exclusive(async () => { await ctx.schedule.cancel(NEXT_SCHEDULE); await write(ctx, emptyState()); });
      await updateCommands(ctx, false); await status(ctx, "status.disconnected");
    });
    return ctx.commands.register({ id: "test-delivery", title: "$t:command.test.title", description: "$t:command.test.description", icon: "bell" }, async () => {
      const now = Date.now(); await ctx.ui.delivery({ key: `calendar.test.${hash(String(now), 0x811c9dc5)}`, courier: ctx.assets.sprite(await courier(ctx)), title: text(ctx.t("delivery.testTitle"), 160), detail: text(ctx.t("delivery.testDetail"), 200), expiresAt: now + 60 * 60_000 });
    });
  });
  manager.queue = task.catch(() => undefined);
  return task;
}
async function arm(ctx, state, now = Date.now()) {
  await ctx.schedule.cancel(NEXT_SCHEDULE);
  const next = state.pending.reduce((earliest, item) => !earliest || Math.max(item.dueAt, item.retryAt ?? item.dueAt) < Math.max(earliest.dueAt, earliest.retryAt ?? earliest.dueAt) ? item : earliest, null);
  if (next) await ctx.schedule.once(NEXT_SCHEDULE, Math.max(1, Math.max(next.dueAt, next.retryAt ?? next.dueAt) - now), () => deliverDue(ctx));
}
async function rebuild(ctx) { return exclusive(async () => { const now = Date.now(); const state = await read(ctx); prune(state, now); rebuildPending(state, now); await write(ctx, state); await arm(ctx, state, now); }); }

export async function deliverDue(ctx) {
  return exclusive(async () => {
    const now = Date.now(); const state = await read(ctx); prune(state, now);
    const selectedCourier = await courier(ctx);
    for (const item of [...state.pending]) {
      if (item.dueAt < now - GRACE_MS) { state.pending = state.pending.filter((candidate) => candidate !== item); await write(ctx, state); continue; }
      if (item.dueAt > now) break;
      if (item.retryAt > now) continue;
      if (state.delivered.some((entry) => entry.key === item.key)) { state.pending = state.pending.filter((candidate) => candidate !== item); await write(ctx, state); continue; }
      const title = text(ctx.t("delivery.title", { title: item.occurrence.title || item.occurrence.eventId }), 160);
      const detail = text(item.offset === 0 ? ctx.t("delivery.starts") : ctx.t("delivery.startsIn", { minutes: Math.max(0, Math.ceil((item.occurrence.startAt - now) / 60_000)) }), 200);
      const expiresAt = Math.max(now + DELIVERY_EXPIRES_MARGIN_MS, Math.min(Number(item.occurrence.endAt) || now + DELIVERY_EXPIRES_MARGIN_MS, now + 7 * 24 * 60 * 60_000));
      if (!title || !detail || !Number.isFinite(expiresAt)) { state.pending = state.pending.filter((candidate) => candidate !== item); await write(ctx, state); continue; }
      try {
        await ctx.ui.delivery({ key: item.key, courier: ctx.assets.sprite(selectedCourier), title, detail, expiresAt });
        state.pending = state.pending.filter((candidate) => candidate !== item);
        state.delivered.push({ key: item.key, at: now }); prune(state, now); await write(ctx, state);
      } catch {
        // Keep the failed delivery, but avoid a tight retry loop and continue the batch.
        item.retryAt = now + 60_000; await write(ctx, state);
      }
    }
    prune(state, now); await write(ctx, state); await arm(ctx, state, now);
  });
}

async function token(ctx) {
  if (session?.accessToken && (!session.expiresAt || session.expiresAt > Date.now() + 60_000)) return session.accessToken;
  session = await ctx.auth.refresh("google"); return session.accessToken;
}
async function request(ctx, accessToken, url) { return ctx.net.fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, timeoutMs: 12_000 }); }
async function failedAuth(ctx, error) {
  await ctx.log.warn("calendar airmail sync failure", { classification: error?.code === "invalid_grant" ? "invalid_grant" : "sync_failed" });
  const state = await read(ctx);
  if (error?.code === "invalid_grant") { session = null; await ctx.schedule.cancel(NEXT_SCHEDULE); await write(ctx, emptyState()); await updateCommands(ctx, false); await status(ctx, "status.reconnect", undefined, "warning"); }
  else await status(ctx, "status.offline", undefined, "warning");
  return false;
}

export async function sync(ctx) {
  return exclusive(async () => {
    const state = await read(ctx); if (!state.connected) { await status(ctx, "status.disconnected", undefined, "warning"); return false; }
    let accessToken;
    try { accessToken = await token(ctx); } catch (error) { return failedAuth(ctx, error); }
    const now = Date.now(); const params = new URLSearchParams({ singleEvents: "true", timeMin: nowIso(now - 300_000), timeMax: nowIso(now + HORIZON_MS), maxResults: "250", orderBy: "startTime" });
    const events = []; let pageToken = "";
    try {
      for (let page = 0; page < 10; page += 1) {
        const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
        let response = await request(ctx, accessToken, url);
        if (response.status === 401) { session = await ctx.auth.refresh("google"); accessToken = session.accessToken; response = await request(ctx, accessToken, url); }
        if (!response.ok) throw new Error(`calendar-http-${response.status}`);
        const body = response.json ?? JSON.parse(response.text || "{}"); if (!Array.isArray(body.items)) throw new Error("calendar-response");
        events.push(...body.items); pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
        if (!pageToken) break;
        if (page === 9 || events.length >= 2500) { await status(ctx, "status.cap", undefined, "warning"); return false; }
      }
    } catch (error) { return failedAuth(ctx, error); }
    state.occurrences = normalizeEvents(events); prune(state, now); rebuildPending(state, now); await write(ctx, state); await arm(ctx, state, now); await syncedStatus(ctx, state); const nextDueAt = state.pending.reduce((next, item) => !next || item.dueAt < next ? item.dueAt : next, undefined); await ctx.log.info("calendar airmail sync succeeded", { count: state.occurrences.length, nextDueAt }); return true;
  });
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      await ctx.schedule.every(SYNC_SCHEDULE, SYNC_MS, () => sync(ctx)); await rebuild(ctx);
      const state = await read(ctx); await updateCommands(ctx, state.connected); if (state.connected) { await status(ctx, "status.connected", undefined, "success"); void sync(ctx); } else await status(ctx, "status.disconnected");
      ctx.config.onChange(() => rebuild(ctx));
    },
    async stop(ctx) { await ctx.schedule.cancel(NEXT_SCHEDULE); }
  });
}
