import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CATALOGS, resolveLanguage, resolveOs, t } from "./index.js";
import {
  ALERT_COOLDOWN_MS,
  FALLBACK_PET_ID,
  SATELLITE_OFFSET_X,
  SCHEDULE_ID,
  SIDECAR_URL,
  clampPercent,
  collectSnapshot,
  hottestMetric,
  hudSpec,
  mergeSnapshot,
  readConfig,
  register,
  resolveCatalogPetId,
  satellitePosition,
  speakSnapshot,
  tick,
  toneFor,
} from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(new URL("../../../packages/sdk/dist/testing.js", import.meta.url)));
}

const PERMISSIONS = [
  "pet:speak",
  "pet:reaction",
  "pet:pin",
  "pet:interact",
  "pet:move",
  "pet:animate",
  "pets:read",
  "pets:manage",
  "schedule",
  "storage",
  "commands",
  "status",
  "events",
  "system:metrics",
  "network",
  "network:local",
];
const LOCALES = {
  en: JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8")),
  nl: JSON.parse(await readFile(new URL("./locales/nl.json", import.meta.url), "utf8")),
  fr: JSON.parse(await readFile(new URL("./locales/fr.json", import.meta.url), "utf8")),
  de: JSON.parse(await readFile(new URL("./locales/de.json", import.meta.url), "utf8")),
};

const requiredKeys = Object.keys(LOCALES.en);
for (const [lang, catalog] of Object.entries(LOCALES)) {
  assert.deepEqual(Object.keys(catalog).sort(), requiredKeys.slice().sort(), `${lang} locale keys`);
  assert.deepEqual(catalog, CATALOGS[lang], `${lang} catalog matches locale file`);
}

assert.equal(resolveLanguage("auto", "fr-FR"), "fr");
assert.equal(resolveLanguage("de", "en-US"), "de");
assert.equal(resolveLanguage("nope", "nl-NL"), "nl");
assert.equal(t("fr", "plugin.name"), "Ressources système");
assert.equal(t("de", "speech.alert", { label: "CPU", value: "96" }), "CPU liegt bei 96 Prozent.");

assert.equal(clampPercent(12.4), 12);
assert.equal(clampPercent(140), 100);
assert.equal(clampPercent("nope"), null);
assert.equal(toneFor(40), "green");
assert.equal(toneFor(75), "amber");
assert.equal(toneFor(95), "red");
assert.equal(toneFor(null), "slate");

const merged = mergeSnapshot({ cpuPercent: 11, memUsedPercent: 64 }, { gpuPercent: 8, ssdUsedPercent: 30 });
assert.equal(merged.cpu, 11);
assert.equal(merged.ram, 64);
assert.equal(merged.gpu, 8);
assert.equal(merged.ssd, 30);
assert.equal(merged.sidecarOnline, true);
assert.equal(hottestMetric(merged).key, "ram");

const cfg = readConfig({ pollSeconds: 3, alertPercent: 140, showHud: false });
assert.equal(cfg.pollSeconds, 5);
assert.equal(cfg.alertPercent, 99);
assert.equal(cfg.showHud, false);
assert.equal(cfg.language, "en");
assert.equal(readConfig({ language: "fr" }, "de").language, "fr");
assert.equal(readConfig({ language: "auto" }, "de-DE").language, "de");
assert.equal(resolveOs("auto", "win"), "windows");
assert.equal(resolveOs("linux", "mac"), "linux");
  assert.equal(readConfig({ os: "windows" }, "en", "mac").os, "mac");
  assert.equal(readConfig({ os: "auto" }, "en", "linux").os, "linux");
  assert.equal(readConfig({ sidecarHint: "ignore-me" }, "en", "mac").os, "mac");
assert.deepEqual(satellitePosition({ position: { x: 100, y: 40 } }), { x: 100 + SATELLITE_OFFSET_X, y: 40 });
assert.equal(resolveCatalogPetId({ pets: { default: { id: "default" } } }, [{ id: "default", kind: "default" }]), FALLBACK_PET_ID);
assert.equal(resolveCatalogPetId({ pets: { default: { id: "meowbyte" } } }), "meowbyte");

{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 1_000_000 });
  await h.start();
  h.expectScheduled(SCHEDULE_ID);
  h.expectBubble({ sticky: true, pin: true });
  const bubble = h.calls.bubbles.at(-1);
  assert.notEqual(bubble.petId, "default", "resource HUD must not steal the default pet pin slot");
  assert.deepEqual(h.calls.spawnedPets, [FALLBACK_PET_ID]);
  assert.equal(bubble.spec.hud.items.length, 2);
  assert.equal(bubble.spec.hud.items[0].value, 5);
  assert.equal(bubble.spec.hud.items[1].value, 40);
  assert.match(String(h.calls.status.at(-1).text), /CPU 5% · RAM 40%/);
  assert.doesNotMatch(String(h.calls.status.at(-1).text), /sidecar/i);
  h.expectNoErrors();
  await h.stop();
}

{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    locales: LOCALES,
    nowMs: 2_000_000,
    config: { showHud: false },
  });
  await h.start();
  assert.equal(h.calls.bubbles.length, 0, "HUD stays off when showHud is false");
  assert.equal(h.calls.spawnedPets.length, 0, "no satellite pet when HUD is off");
  h.expectNoErrors();
  await h.stop();
}

{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 3_000_000 });
  h.net.mock(SIDECAR_URL, { json: { gpuPercent: 22, ssdUsedPercent: 71 } });
  h.system.setMetrics({ cpuPercent: 18, memUsedPercent: 55 });
  await h.start();
  const items = h.calls.bubbles.at(-1).spec.hud.items;
  assert.equal(items.length, 4);
  assert.deepEqual(
    items.map((item) => item.value),
    [18, 55, 22, 71],
  );
  h.expectNetCall("127.0.0.1:37647/metrics");
  if (typeof h.runCapability === "function") {
    const snapshot = await h.runCapability("resources.get", {});
    assert.equal(snapshot.gpuPercent, 22);
    assert.equal(snapshot.sidecarOnline, true);
  }
  await h.runCommand("snapshot");
  h.expectSpoke(/CPU 18%/);
  await h.runCommand("hide");
  assert.ok(h.calls.dismissedBubbles.length > 0);
  h.expectNoErrors();
  await h.stop();
}

{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 4_000_000 });
  h.system.setMetrics({ cpuPercent: 96, memUsedPercent: 40 });
  await h.start();
  h.expectSpoke(/CPU is at 96 percent/);
  h.expectReacted("error");
  const previousSpeak = h.calls.speak.length;
  const alertedAt = Date.now();
  h.system.setMetrics({ cpuPercent: 97, memUsedPercent: 40 });
  await tick(h.ctx, alertedAt + 60_000);
  assert.equal(h.calls.speak.length, previousSpeak, "alert cooldown must suppress spam");
  await tick(h.ctx, alertedAt + ALERT_COOLDOWN_MS);
  assert.ok(h.calls.speak.length > previousSpeak);
  h.expectNoErrors();
  await h.stop();
}

{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 5_000_000 });
  await h.start();
  await h.emit("pet:clicked", {});
  h.expectSpoke(/CPU 5%/);
  const spec = hudSpec(h.ctx, await collectSnapshot(h.ctx));
  assert.equal(spec.hud.items[0].icon.name, "cpu");
  await speakSnapshot(h.ctx);
  h.expectNoErrors();
  await h.stop();
}

{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    locales: LOCALES,
    nowMs: 6_000_000,
    config: { language: "fr" },
  });
  h.system.setMetrics({ cpuPercent: 18, memUsedPercent: 55 });
  await h.start();
  await h.runCommand("snapshot");
  h.expectSpoke("CPU 18%, RAM 55%.");
  h.expectNoErrors();
  await h.stop();
}

{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    locales: LOCALES,
    nowMs: 7_000_000,
    config: { language: "de" },
  });
  h.system.setMetrics({ cpuPercent: 96, memUsedPercent: 40 });
  await h.start();
  h.expectSpoke("CPU liegt bei 96 Prozent.");
  h.expectNoErrors();
  await h.stop();
}

{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    locales: LOCALES,
    nowMs: 8_000_000,
    config: { language: "nl" },
  });
  h.system.setMetrics({ cpuPercent: 91, memUsedPercent: 40 });
  await h.start();
  h.expectSpoke("CPU zit op 91 procent.");
  h.expectNoErrors();
  await h.stop();
}

{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    locales: LOCALES,
    nowMs: 9_000_000,
  });
  h.system.set({ platform: "win" });
  h.net.mock(SIDECAR_URL, { json: { gpuPercent: 41, ssdUsedPercent: 63 } });
  await h.start();
  h.expectNetCall("platform=windows");
  assert.equal(h.calls.bubbles.at(-1).spec.hud.items[2].value, 41);
  h.expectNoErrors();
  await h.stop();
}

{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    locales: LOCALES,
    nowMs: 10_000_000,
  });
  h.system.set({ platform: "linux" });
  h.net.mock(SIDECAR_URL, { json: { gpuPercent: 9, ssdUsedPercent: 44 } });
  await h.start();
  h.expectNetCall("platform=linux");
  assert.equal(h.calls.bubbles.at(-1).spec.hud.items[3].value, 44);
  h.expectNoErrors();
  await h.stop();
}

console.log("openpets.system-resources: all checks passed.");
