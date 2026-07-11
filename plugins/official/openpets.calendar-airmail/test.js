import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register, deliverDue, sync, DEFAULT_COURIER, GOOGLE_CLIENT_SECRET } from "./index.js";

let createTestHarness;
try { ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing")); } catch { ({ createTestHarness } = await import(new URL("../../../packages/sdk/dist/testing.js", import.meta.url))); }

const locales = { en: JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8")) };
const permissions = ["ui:delivery", "auth", "network", "schedule", "storage", "commands", "status"];
const event = (id, start) => ({ id, summary: `Event ${id}`, start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + 3_600_000).toISOString() } });
const commandIds = (harness) => [...harness.calls.commands.keys()];

const h = createTestHarness(register, { permissions, locales, config: { courier: "courier-owl" }, nowMs: 1_000_000 });
const realNow = Date.now;
Date.now = () => h.clock.now();

try {
  h.auth.mock({ accessToken: "token", expiresAt: 9_999_999 });
  h.ctx.net.fetch = async () => ({ status: 200, ok: true, headers: {}, text: "", json: { items: [event("upcoming", h.clock.now() + 3_600_000)] } });

  await h.start();
  assert.deepEqual(commandIds(h), ["connect"], "only connection is available while Calendar Airmail is disconnected");

  let oauthConfig;
  h.ctx.auth.oauth = async (config) => { oauthConfig = config; return { accessToken: "token", expiresAt: 9_999_999 }; };
  await h.runCommand("connect");
  assert.equal(oauthConfig?.clientSecret, GOOGLE_CLIENT_SECRET, "Calendar Airmail supplies its installed-app credential secret to the host OAuth flow");
  assert.deepEqual(commandIds(h), ["sync-now", "disconnect", "test-delivery"], "calendar commands become available after connecting");
  assert.equal(h.calls.status.at(-1)?.tone, "success", "a successful sync reports successful calendar status");
  assert.equal(h.calls.schedules.has("calendar-airmail-next"), true, "an upcoming event arms a delivery schedule");
  assert.equal(h.calls.menuItems.length, 2, "today's next event appears in the pet menu");
  assert.equal(h.calls.menuItems.every((item) => item.enabled === false), true, "calendar today summary items are disabled");
  assert.equal(h.calls.menuItems.some((item) => item.title.includes("Event upcoming")), true, "the menu identifies today's next event");

  h.ctx.net.fetch = async () => ({ status: 200, ok: true, headers: {}, text: "", json: { items: [] } });
  await sync(h.ctx);
  assert.deepEqual(h.calls.menuItems, [], "the menu clears when no future timed event remains today");

  const denied = createTestHarness(register, { permissions, locales, config: { courier: "courier-owl" }, nowMs: h.clock.now() });
  const deniedOccurrence = { key: "denied", eventId: "denied", title: "Denied", startAt: h.clock.now() + 60_000, endAt: h.clock.now() + 3_600_000 };
  await denied.ctx.storage.set("calendar-airmail-state", { connected: true, occurrences: [deniedOccurrence], pending: [{ key: "calendar.denied.0", dueAt: h.clock.now() + 60_000, offset: 0, occurrence: deniedOccurrence }], delivered: [] });
  const apiFailures = [];
  denied.ctx.log.warn = async (message, fields) => { if (message === "calendar airmail api failure") apiFailures.push(fields); };
  denied.ctx.net.fetch = async () => ({ status: 403, ok: false, headers: {}, text: JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "Calendar API access denied at https://example.test/?access_token=secret", errors: [{ reason: "accessNotConfigured" }], events: [{ summary: "private event" }] } }) });
  await denied.start();
  await sync(denied.ctx);
  assert.equal(denied.calls.storage.get("calendar-airmail-state").connected, true, "Calendar API denial retains the connection state");
  assert.equal(denied.calls.status.at(-1)?.text.includes("Calendar API access was denied"), true, "Calendar API denial publishes an access-denied warning");
  assert.equal(denied.calls.status.at(-1)?.tone, "warning", "Calendar API denial is a warning");
  assert.equal(apiFailures.some((failure) => failure?.httpStatus === 403 && failure?.googleStatus === "PERMISSION_DENIED" && failure?.reason === "accessNotConfigured" && failure?.message?.includes("[url]") && !failure?.message?.includes("secret")), true, "Calendar API denial logs safe status and reason classification");

  const occurrence = { key: "two-offsets", eventId: "two-offsets", title: "Two offsets", startAt: h.clock.now(), endAt: h.clock.now() + 3_600_000 };
  await h.ctx.storage.set("calendar-airmail-state", {
    connected: true,
    occurrences: [],
    pending: [
      { key: "calendar.two-offsets.600000", dueAt: h.clock.now(), offset: 600_000, occurrence },
      { key: "calendar.two-offsets.0", dueAt: h.clock.now(), offset: 0, occurrence },
    ],
    delivered: [],
  });
  await deliverDue(h.ctx);
  assert.equal(h.calls.deliveries.length, 2, "each due reminder is delivered");
  assert.equal(h.calls.deliveries.every((delivery) => delivery.spec.courier?.name === "courier-owl"), true, "deliveries use the configured courier");
  await deliverDue(h.ctx);
  assert.equal(h.calls.deliveries.length, 2, "delivered reminders are not delivered again");

  await h.runCommand("disconnect");
  assert.deepEqual(commandIds(h), ["connect"], "disconnecting removes calendar-only commands");
  assert.deepEqual(h.calls.menuItems, [], "disconnecting clears the calendar today summary");

  const defaultCourier = createTestHarness(register, { permissions, locales, config: {}, nowMs: h.clock.now() });
  await defaultCourier.ctx.storage.set("calendar-airmail-state", { connected: true, occurrences: [], pending: [], delivered: [] });
  await defaultCourier.start();
  await defaultCourier.runCommand("test-delivery");
  assert.equal(defaultCourier.calls.deliveries[0].spec.courier?.name, DEFAULT_COURIER, "deliveries use the declared default courier when none is selected");

  const revoked = createTestHarness(register, { permissions, locales, config: { courier: "courier-owl" }, nowMs: h.clock.now() });
  const revokedOccurrence = { key: "revoked", eventId: "revoked", title: "Revoked", startAt: h.clock.now() + 60_000, endAt: h.clock.now() + 3_600_000 };
  await revoked.ctx.storage.set("calendar-airmail-state", { connected: true, occurrences: [revokedOccurrence], pending: [{ key: "calendar.revoked.0", dueAt: h.clock.now() + 60_000, offset: 0, occurrence: revokedOccurrence }], delivered: [] });
  await revoked.ctx.schedule.once("calendar-airmail-next", 60_000, () => undefined);
  revoked.ctx.net.fetch = async () => ({ status: 401, ok: false, headers: {}, text: "", json: {} });
  revoked.ctx.auth.refresh = async () => { const error = new Error("revoked"); error.code = "invalid_grant"; throw error; };
  await revoked.start();
  await sync(revoked.ctx);
  assert.deepEqual(revoked.calls.storage.get("calendar-airmail-state"), { connected: false, occurrences: [], pending: [], delivered: [] }, "revoked authorization clears calendar data");
  assert.equal(revoked.calls.schedules.has("calendar-airmail-next"), false, "revoked authorization cancels scheduled deliveries");
  assert.deepEqual(commandIds(revoked), ["connect"], "revoked authorization returns Calendar Airmail to its disconnected commands");

  console.log("openpets.calendar-airmail: behavior checks passed.");
} finally {
  Date.now = realNow;
}
