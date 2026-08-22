// Quick Reminders (openpets.reminders) — a self-contained v3 plugin.
//
// Keeps the proven Quick Reminders interaction model (a "Set reminder..." form
// plus 15/30/60-minute presets from the pet menu) but delivers with the §21.3
// acknowledge pattern: ctx.ui.alert(...) with Done / Snooze 5m actions,
// optional custom sound, and optional OS notification. Every
// user-facing composed string flows through ctx.t(key, vars) so the host can
// localize it; nothing English is hardcoded below.

export const MAX_REMINDERS = 10;
export const MAX_MESSAGE_LENGTH = 140;
export const MAX_DELAY_MS = 24 * 60 * 60 * 1000;
export const SNOOZE_MS = 5 * 60 * 1000;
export const REMINDER_ID_PREFIX = "reminder-";

let nextReminderSequence = 0;

/**
 * Normalize a free-text reminder message: collapse whitespace, strip newlines,
 * cap length, and fall back when empty. `fallback` is already-resolved text
 * (callers pass ctx.t("reminder.defaultMessage")).
 */
export function cleanMessage(value, fallback = "Reminder time.") {
  const text =
    typeof value === "string"
      ? value.trim().replace(/[\r\n]+/g, " ").replace(/\s+/g, " ")
      : "";
  return (text || fallback).slice(0, MAX_MESSAGE_LENGTH).trim() || fallback;
}

/**
 * Convert a {hours, minutes} form payload into a delay in ms. Clamps each
 * field to its valid range and enforces a 1-minute..24-hour window. Throws on
 * an out-of-range total so the command surfaces the error to the user.
 */
export function durationMs(values = {}) {
  const hours = Math.max(0, Math.min(23, Math.round(Number(values.hours ?? 0))));
  const minutes = Math.max(0, Math.min(59, Math.round(Number(values.minutes ?? 0))));
  const ms = (hours * 60 + minutes) * 60_000;
  if (ms < 60_000 || ms > MAX_DELAY_MS) {
    throw new Error("Reminder duration must be 1 minute to 24 hours.");
  }
  return ms;
}

/**
 * A short, plain-text summary of the pending reminders. `now` defaults to the
 * current time. Translation-agnostic on purpose: returns a compact
 * "{minutes} min: {message}" join used by the pure-helper unit tests; runtime
 * UI uses the dynamic ctx.ui.menu list instead.
 */
export function summary(reminders, now = Date.now()) {
  if (!reminders.length) return "No active reminders.";
  return reminders
    .slice(0, 5)
    .map((r) => `${Math.max(1, Math.ceil((r.dueAt - now) / 60_000))} min: ${r.message}`)
    .join("; ");
}

const EXPLICIT_TIMEZONE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse the assistant's absolute due-time contract. A timezone designator or
 * numeric UTC offset is mandatory; local-time and natural-language values are
 * intentionally rejected.
 */
export function parseDueAt(value, now = Date.now()) {
  if (typeof value !== "string" || !EXPLICIT_TIMEZONE_PATTERN.test(value)) {
    throw new Error("Reminder dueAt must be an ISO timestamp with Z or a numeric UTC offset.");
  }
  const dueAt = Date.parse(value);
  if (!Number.isFinite(dueAt) || dueAt <= now) {
    throw new Error("Reminder dueAt must be a valid future timestamp.");
  }
  return dueAt;
}

function reminderId(existing, dueAt) {
  const timestamp = dueAt.toString(36);
  let id;
  do {
    nextReminderSequence += 1;
    id = `${REMINDER_ID_PREFIX}${timestamp}-${nextReminderSequence.toString(36)}`;
  } while (existing.some((reminder) => reminder.id === id));
  return id.slice(0, 64);
}

export function reminderResult(reminder) {
  return { id: reminder.id, message: reminder.message, dueAt: reminder.dueAt };
}

// --- storage -------------------------------------------------------------

export async function getReminders(ctx) {
  const reminders = await ctx.storage.get("reminders");
  return Array.isArray(reminders)
    ? reminders
        .filter(
          (r) =>
            r &&
            typeof r.id === "string" &&
            typeof r.dueAt === "number" &&
            Number.isFinite(r.dueAt) &&
            typeof r.message === "string",
        )
        .slice(0, MAX_REMINDERS)
    : [];
}

async function saveReminders(ctx, reminders) {
  const list = reminders.slice(0, MAX_REMINDERS);
  await ctx.storage.set("reminders", list);
  await updateStatus(ctx, list.length);
  return list;
}

async function updateStatus(ctx, count) {
  const text =
    count > 0
      ? ctx.t("status.active", { count })
      : ctx.t("status.none");
  await ctx.status.set({ text, tone: "info" });
}

// --- scheduling + delivery ----------------------------------------------

export async function scheduleReminder(ctx, reminder) {
  // schedule.once min delay is 1ms; never schedule in the past.
  const delay = Math.max(1, reminder.dueAt - Date.now());
  await ctx.schedule.once(reminder.id, delay, () => fireReminder(ctx, reminder.id));
}

export async function addReminder(ctx, message, delayMs) {
  const reminder = await createReminder(ctx, message, Date.now() + delayMs);
  await ctx.pet.speak(ctx.t("speech.set", { minutes: Math.max(1, Math.round(delayMs / 60_000)) }));
  return reminder;
}

/**
 * Store and schedule a reminder without producing direct-control speech.
 * Assistant capabilities use this domain operation directly.
 */
export async function createReminder(ctx, message, dueAt) {
  if (!Number.isFinite(dueAt) || dueAt <= Date.now()) {
    throw new Error("Reminder dueAt must be a valid future timestamp.");
  }
  const reminders = (await getReminders(ctx)).filter((r) => r.dueAt > Date.now());
  if (reminders.length >= MAX_REMINDERS) {
    throw new Error(ctx.t("error.tooMany", { max: MAX_REMINDERS }));
  }
  const reminder = {
    id: reminderId(reminders, dueAt),
    message: cleanMessage(message, ctx.t("reminder.defaultMessage")),
    dueAt,
  };
  reminders.push(reminder);
  await saveReminders(ctx, reminders);
  await scheduleReminder(ctx, reminder);
  return reminder;
}

export async function removeReminder(ctx, id) {
  const reminders = await getReminders(ctx);
  const item = reminders.find((reminder) => reminder.id === id);
  if (!item) return null;
  await ctx.schedule.cancel(item.id);
  await saveReminders(ctx, reminders.filter((reminder) => reminder.id !== id));
  return item;
}

/**
 * Move a pending reminder five minutes into the future. `fallbackMessage` is
 * only used by the already-fired alert action, whose reminder was removed
 * before delivery; assistant callers must omit it so invalid IDs stay inert.
 */
export async function snoozeReminder(ctx, id, fallbackMessage) {
  const item = await removeReminder(ctx, id);
  if (!item && fallbackMessage === undefined) return null;
  const reminder = await createReminder(
    ctx,
    item?.message ?? fallbackMessage,
    Date.now() + SNOOZE_MS,
  );
  return { previous: item, reminder };
}

export async function clearReminders(ctx) {
  await ctx.schedule.cancelAll();
  await saveReminders(ctx, []);
}

export async function listPendingReminders(ctx) {
  const now = Date.now();
  return (await getReminders(ctx)).filter((reminder) => reminder.dueAt > now);
}

/**
 * Deliver a reminder using the acknowledge pattern (§21.3). Degrades
 * gracefully: a disabled toggle or an unavailable permission must never throw
 * the message away — the sticky bubble is the guaranteed channel.
 */
async function deliver(ctx, message, { missed = false, id } = {}) {
  const config = (await ctx.config.get()) ?? {};
  const soundEnabled = config.soundEnabled !== false;
  const osNotification = config.osNotification !== false;

  const text = missed
    ? ctx.t("bubble.missed", { message })
    : ctx.t("bubble.due", { message });
  const reminderIcon = ctx.assets.icon("reminder");

  let alert;
  try {
    alert = await ctx.ui.alert({
      text,
      indicator: {
        icon: reminderIcon,
        label: missed ? ctx.t("indicator.missed") : ctx.t("indicator.due"),
        tone: missed ? "warning" : "info",
        color: missed ? "#d97706" : "#7c3aed",
        background: missed ? "#fef3c7" : "#ede9fe",
        borderColor: missed ? "#fbbf24" : "#c4b5fd",
      },
      tone: "info",
      sound: soundEnabled ? config.customSound || "alert" : undefined,
      notify: osNotification
        ? {
            title: ctx.t("notify.title"),
            body: missed ? ctx.t("notify.bodyMissed", { message }) : message,
          }
        : undefined,
      dismissOn: ["petClick", "click", "action"],
      actions: [
        { id: "done", label: ctx.t("action.done"), style: "primary" },
        { id: "snooze", label: ctx.t("action.snooze") },
      ],
    });
  } catch {
    // If interactive bubbles aren't permitted, still surface plain speech.
    try {
      await ctx.pet.speak(text);
    } catch {
      // last resort already attempted; nothing more to do.
    }
  }

  if (alert) {
    alert.onAction(async (actionId) => {
      if (actionId === "snooze") {
        const snoozed = await snoozeReminder(ctx, id, message);
        if (snoozed) {
          await ctx.pet.speak(ctx.t("speech.set", { minutes: 5 }));
        }
      }
      // "done" needs no extra work; dismissing the bubble is the acknowledgement.
    });
  }
}

export async function fireReminder(ctx, id) {
  const reminders = await getReminders(ctx);
  const item = reminders.find((r) => r.id === id);
  await saveReminders(ctx, reminders.filter((r) => r.id !== id));
  if (!item) return false;
  await deliver(ctx, item.message, { id: item.id });
  return true;
}

/**
 * Reconcile persisted reminders against the wall clock on start(). Schedules
 * are in-memory per session, so future reminders are re-registered and overdue
 * ones (fired while OpenPets was closed) are delivered as "missed".
 */
export async function reconcile(ctx) {
  await ctx.schedule.cancelAll();
  const now = Date.now();
  const reminders = await getReminders(ctx);
  const future = reminders.filter((r) => r.dueAt > now);
  const overdue = reminders.filter((r) => r.dueAt <= now);
  await saveReminders(ctx, future);
  for (const item of future) await scheduleReminder(ctx, item);
  for (const item of overdue) await deliver(ctx, item.message, { missed: true, id: item.id });
}

// --- commands ------------------------------------------------------------

async function showReminderList(ctx) {
  const pending = await listPendingReminders(ctx);
  const now = Date.now();
  if (!pending.length) {
    await ctx.pet.speak(ctx.t("speech.none"));
    await ctx.ui.menu.setItems([]);
    return;
  }
  await ctx.ui.menu.setItems(
    pending.slice(0, MAX_REMINDERS).map((reminder) => ({
      id: `cancel:${reminder.id}`.slice(0, 64),
      title: ctx.t("menu.item", {
        minutes: Math.max(1, Math.ceil((reminder.dueAt - now) / 60_000)),
        message: reminder.message,
      }),
      icon: "bell",
      onSelect: async () => {
        const removed = await removeReminder(ctx, reminder.id);
        if (removed) await ctx.pet.speak(ctx.t("speech.cancelled", { message: removed.message }));
        await showReminderList(ctx);
      },
    })),
  );
}

const assistantSchemas = {
  create: {
    type: "object",
    description: "Create a reminder for an absolute ISO timestamp with an explicit timezone or UTC offset.",
    properties: {
      message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_LENGTH },
      dueAt: {
        type: "string",
        minLength: 1,
        maxLength: 40,
        description: "ISO timestamp ending in Z or containing a numeric UTC offset, for example 2026-08-22T15:30:00-04:00.",
      },
    },
    required: ["message", "dueAt"],
    additionalProperties: false,
  },
  list: { type: "object", additionalProperties: false },
  byId: {
    type: "object",
    properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
    required: ["id"],
    additionalProperties: false,
  },
};

function assistantNotFound(id) {
  return { ok: false, error: "not_found", id };
}

async function registerAssistantCapabilities(ctx) {
  await ctx.assistant.registerCapability(
    {
      id: "reminders.create",
      description: "Create a reminder at an absolute timestamp with an explicit timezone or UTC offset.",
      inputSchema: assistantSchemas.create,
    },
    async (input) => {
      const reminder = await createReminder(
        ctx,
        input.message,
        parseDueAt(input.dueAt),
      );
      return { ok: true, reminder: reminderResult(reminder) };
    },
  );

  await ctx.assistant.registerCapability(
    {
      id: "reminders.list",
      description: "List active reminders and their stable identifiers and due times.",
      inputSchema: assistantSchemas.list,
    },
    async () => ({
      ok: true,
      reminders: (await listPendingReminders(ctx)).map(reminderResult),
    }),
  );

  await ctx.assistant.registerCapability(
    {
      id: "reminders.complete",
      description: "Complete an active reminder by its stable identifier.",
      inputSchema: assistantSchemas.byId,
    },
    async ({ id }) => {
      const reminder = await removeReminder(ctx, id);
      return reminder ? { ok: true, reminder: reminderResult(reminder) } : assistantNotFound(id);
    },
  );

  await ctx.assistant.registerCapability(
    {
      id: "reminders.snooze",
      description: "Snooze an active reminder by five minutes using its stable identifier.",
      inputSchema: assistantSchemas.byId,
    },
    async ({ id }) => {
      const result = await snoozeReminder(ctx, id);
      return result
        ? { ok: true, reminder: reminderResult(result.reminder) }
        : assistantNotFound(id);
    },
  );

  await ctx.assistant.registerCapability(
    {
      id: "reminders.remove",
      description: "Remove an active reminder by its stable identifier.",
      inputSchema: assistantSchemas.byId,
    },
    async ({ id }) => {
      const reminder = await removeReminder(ctx, id);
      return reminder ? { ok: true, reminder: reminderResult(reminder) } : assistantNotFound(id);
    },
  );
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      await reconcile(ctx);
      await registerAssistantCapabilities(ctx);

      await ctx.commands.register(
        {
          id: "set-reminder",
          title: "$t:command.setReminder.title",
          description: "$t:command.setReminder.description",
          icon: "bell",
          form: {
            submitLabel: "$t:command.setReminder.submit",
            fields: [
              {
                id: "message",
                type: "textarea",
                label: "$t:form.message.label",
                required: true,
                maxLength: MAX_MESSAGE_LENGTH,
              },
              {
                id: "hours",
                type: "number",
                label: "$t:form.hours.label",
                default: 0,
                min: 0,
                max: 23,
              },
              {
                id: "minutes",
                type: "number",
                label: "$t:form.minutes.label",
                default: 15,
                min: 0,
                max: 59,
              },
            ],
          },
        },
        async (values) => addReminder(ctx, values.message, durationMs(values)),
      );

      await ctx.commands.register(
        {
          id: "reminder-15",
          title: "$t:command.reminder15.title",
          description: "$t:command.reminder15.description",
          icon: "timer",
        },
        () => addReminder(ctx, ctx.t("reminder.defaultMessage"), 15 * 60_000),
      );
      await ctx.commands.register(
        {
          id: "reminder-30",
          title: "$t:command.reminder30.title",
          description: "$t:command.reminder30.description",
          icon: "timer",
        },
        () => addReminder(ctx, ctx.t("reminder.defaultMessage"), 30 * 60_000),
      );
      await ctx.commands.register(
        {
          id: "reminder-60",
          title: "$t:command.reminder60.title",
          description: "$t:command.reminder60.description",
          icon: "timer",
        },
        () => addReminder(ctx, ctx.t("reminder.defaultMessage"), 60 * 60_000),
      );

      await ctx.commands.register(
        {
          id: "view-reminders",
          title: "$t:command.viewReminders.title",
          description: "$t:command.viewReminders.description",
          icon: "bell",
        },
        () => showReminderList(ctx),
      );

      await ctx.commands.register(
        {
          id: "test-reminder",
          title: "$t:command.testReminder.title",
          description: "$t:command.testReminder.description",
          icon: "bell",
        },
        () => deliver(ctx, ctx.t("reminder.testMessage")),
      );

      await ctx.commands.register(
        {
          id: "clear-reminders",
          title: "$t:command.clearReminders.title",
          description: "$t:command.clearReminders.description",
          icon: "check",
        },
        async () => {
          await clearReminders(ctx);
          await ctx.ui.menu.setItems([]);
          await ctx.pet.speak(ctx.t("speech.cleared"));
        },
      );
    },
    async stop() {},
  });
}
