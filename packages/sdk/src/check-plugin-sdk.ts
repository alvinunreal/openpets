/**
 * Contract test for @open-pets/plugin-sdk (SDK v3).
 *
 * This file does double duty: it only compiles if the exported types match the
 * real SDK surface, and at runtime it exercises a sample plugin against a mock
 * context. The full-featured testing harness built on this mock lives in
 * `@open-pets/plugin-sdk/testing` (`createTestHarness`).
 */
import type {
  OpenPetsBubble,
  OpenPetsBubbleHandle,
  OpenPetsContext,
  OpenPetsPickedFile,
  OpenPetsPluginDefinition,
  OpenPetsStatus,
} from "./index.js";
import { createMockContext, createTestHarness } from "./testing.js";

export { createMockContext } from "./testing.js";

// Self-contained assertions so this types-only package needs no runtime deps.
declare const console: { log(...args: unknown[]): void };
const assert = {
  ok(value: unknown, message?: string): void {
    if (!value) throw new Error(message ?? "Assertion failed.");
  },
  equal(actual: unknown, expected: unknown, message?: string): void {
    if (actual !== expected) throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}.`);
  },
  deepEqual(actual: unknown, expected: unknown, message?: string): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
    }
  },
};

// A representative v3 plugin, typed against the public contract.
const plugin: OpenPetsPluginDefinition = {
  async start(ctx: OpenPetsContext) {
    await ctx.status.set({ text: "Ready", tone: "info" });
    await ctx.pet.speak("Hello!");
    await ctx.pet.react("waving");
    await ctx.pet.react("waving", { showMessage: false });
    await ctx.pet.setStatusReaction("thinking");
    const alert = await ctx.ui.alert({ text: "Heads up", markdown: "**Check complete**", icon: "bell", tone: "info", sound: "alert" });
    alert.onAction(() => undefined);
    await alert.acknowledge();
    const bubble: OpenPetsBubbleHandle = await ctx.ui.bubble({
      text: "Break in 5:00",
      sticky: true,
      actions: [{ id: "snooze", label: "Snooze" }, { id: "done", label: "Done", style: "primary" }],
    } satisfies OpenPetsBubble);
    bubble.onAction(async (actionId) => {
      if (actionId === "done") await bubble.dismiss();
    });
    const hudBubble: OpenPetsBubbleHandle = await ctx.ui.bubble({
      pin: true,
      hud: {
        items: [
          { icon: "food", value: 80, tone: "amber", label: "Food" },
          { icon: "zap", value: 60, tone: "blue", label: "Energy" },
        ],
      },
    } satisfies OpenPetsBubble);
    const delivery = await ctx.ui.delivery({ key: "sample.delivery", courier: ctx.assets.sprite("courier"), title: "Delivery", detail: "Sample", expiresAt: Date.now() + 60_000 });
    delivery.onDismiss(() => undefined);
    await ctx.schedule.every("tick", 60_000, async () => {
      await ctx.storage.set("lastTick", "now");
    });
    await ctx.schedule.cron("daily-summary", "0 9 * * 1-5", async () => {
      await ctx.storage.set("summaryRan", true);
    });
    ctx.events.on("pet:clicked", () => {
      void ctx.pet.react("celebrating");
    });
    ctx.storage.subscribe("lastTick", () => undefined);
    await ctx.bus.publish("sample/mood", { mood: "happy" });
    const picked: OpenPetsPickedFile = (await ctx.files.pick({ accept: ["audio/*"] }))[0]!;
    const sound = await ctx.audio.importUserSound(picked, { name: "Bell" });
    await ctx.audio.play(sound);
    await ctx.audio.forgetUserSound(sound);
    await ctx.commands.register({ id: "greet", title: "Greet" }, async () => {
      await ctx.pet.speak("Hi again!");
    });
    await ctx.assistant.registerCapability({
      id: "sample.greet",
      description: "Greet someone by name.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", minLength: 1, maxLength: 40 } },
        required: ["name"],
        additionalProperties: false,
      },
    }, async (input) => ({ greeting: `Hello, ${String(input.name)}.` }));
    // i18n surface: ctx.locale (active host locale) + ctx.t (runtime translation).
    await ctx.status.set({ text: `${ctx.locale}:${ctx.t("greeting", { name: "Pet" })}` });
  },
};

const { ctx, calls, harness } = createMockContext();
harness.files.provide([{ name: "bell.wav", bytes: new Uint8Array([1, 2, 3]) }]);
await plugin.start(ctx);

assert.deepEqual(calls.speak, ["Hello!", "Heads up", "Break in 5:00"]);
assert.deepEqual(calls.react, ["waving", "waving"]);
assert.deepEqual(calls.reactions[1]?.options, { showMessage: false });
assert.deepEqual(calls.statusReactions, ["thinking"]);
assert.equal(calls.status.length, 2);
assert.ok(calls.schedules.has("tick"));
assert.ok(calls.schedules.has("daily-summary"));
assert.ok(calls.commands.has("greet"));
assert.ok(calls.assistantCapabilities.has("sample.greet"));
assert.deepEqual(await harness.runCapability("sample.greet", { name: "Pet" }), { greeting: "Hello, Pet." });
assert.equal(calls.bubbles.length, 4, "speak + ui.alert + ui.bubble all produce bubbles");
assert.equal(calls.bubbles[3]!.spec.hud?.items.length, 2);
assert.equal(calls.bubbles[3]!.spec.hud?.items[0]?.icon, "food");
assert.equal(calls.bubbles[3]!.spec.hud?.items[0]?.value, 80);
assert.equal(calls.bubbles[3]!.spec.hud?.items[0]?.tone, "amber");
assert.equal(calls.bubbles[3]!.spec.hud?.items[0]?.label, "Food");
assert.equal(calls.alerts.length, 1);
assert.equal(calls.deliveries.length, 1);
assert.ok(calls.deliveries[0]?.id.startsWith("delivery-"), "recorded deliveries expose deterministic ids");
assert.equal(calls.alerts[0]!.acknowledged, true);
assert.equal(calls.sounds[0]!.sound, "alert");
assert.equal(calls.busPublishes.length, 1);
assert.equal(calls.importedUserSounds.length, 1);
assert.equal(calls.forgottenUserSounds.length, 1);

await harness.dismissDelivery(calls.deliveries[0]!.id, "manual");
assert.equal(calls.deliveries[0]!.dismissed, true, "recorded delivery ids address deterministic dismissal");

// Bubble interactions round-trip.
const live = calls.bubbles[2]!;
assert.equal(live.spec.sticky, true);
await harness.fireBubbleAction(live.handle.id, "done");
assert.ok(calls.dismissedBubbles.includes(live.handle.id), "onAction('done') dismissed the bubble");

// Registered callbacks behave as expected.
await calls.schedules.get("tick")?.handler();
assert.equal(calls.storage.get("lastTick"), "now");

// Curated events reach subscribers.
await harness.emit("pet:clicked", { petId: "default" });
assert.deepEqual(calls.react, ["waving", "waving", "celebrating"]);

await calls.commands.get("greet")?.handler();
assert.deepEqual(calls.speak, ["Hello!", "Heads up", "Break in 5:00", "Hi again!"]);

const status: OpenPetsStatus = calls.status[0]!;
assert.ok(typeof status === "object" && status.text === "Ready");

// ctx.t / ctx.locale drift checks: the runtime bridge must expose both members.
assert.equal(ctx.locale, "en", "ctx.locale defaults to en");
assert.equal(ctx.t("missing.key", { name: "Pet" }), "missing.key", "ctx.t echoes unknown keys");
const i18nStatus = calls.status[1]!;
assert.ok(typeof i18nStatus === "object" && i18nStatus.text === "en:greeting", "no-catalog ctx.t echoes key, ctx.locale is en");

// A harness with catalogs resolves active locale -> en -> key, then interpolates.
const i18n = createMockContext({ locales: { en: { greeting: "Hi {name}" }, ja: { greeting: "やあ {name}" } } });
assert.equal(i18n.ctx.t("greeting", { name: "Pet" }), "Hi Pet", "default locale uses en catalog");
i18n.harness.system.set({ locale: "ja" });
assert.equal(i18n.ctx.locale, "ja", "ctx.locale follows system.set({ locale })");
assert.equal(i18n.ctx.t("greeting", { name: "Pet" }), "やあ Pet", "active locale catalog wins");
assert.equal(i18n.ctx.t("absent"), "absent", "unknown key echoes even with catalogs");

const assistantHarness = createTestHarness({
  async start(ctx) {
    await ctx.assistant.registerCapability({ id: "sample.echo", description: "Echo input.", inputSchema: { type: "object", additionalProperties: true } }, async (input) => ({ ...input }));
  },
}, { permissions: [] });
await assistantHarness.start();
assert.deepEqual(await assistantHarness.runCapability("sample.echo", { value: 1 }), { value: 1 }, "capability harness invocation is deterministic");
assert.ok(assistantHarness.calls.assistantCapabilities.has("sample.echo"), "capability registrations are recorded");
await assistantHarness.stop();
assert.equal(assistantHarness.calls.assistantCapabilities.size, 0, "harness cleanup removes capability registrations");

console.log("Plugin SDK contract tests passed.");
