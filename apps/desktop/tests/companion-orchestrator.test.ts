import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CompanionOrchestrator } from "../src/companion-orchestrator.js";
import { getCompanionMemorySnapshot, initializeCompanionMemory } from "../src/companion-memory.js";
import { defaultCompanionSettings, type CompanionSettings } from "../src/companion-settings.js";
import type { CompanionTarget, CompanionTargetHealth, CompanionTargetResult } from "../src/companion-targets.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function readyHealth(): CompanionTargetHealth {
  return { targetId: "codex", checkedAt: Date.now(), configured: true, ready: true, method: "test" };
}

function rejectsAsAbort(promise: Promise<unknown>, message?: string): Promise<void> {
  return assert.rejects(promise, (error: unknown) => error instanceof Error && error.name === "AbortError", message);
}

const settings: CompanionSettings = {
  ...defaultCompanionSettings,
  consentVersion: 1,
  enabled: true,
  profile: { name: "Thomas", preferredAddress: "Tom", goals: ["Take a real lunch break"] },
  pets: { pedra: { personality: "Warm, observant, and playfully blunt." } },
};

const appState = {
  preferences: { defaultPetId: "pedra" },
  pets: { installed: [{ id: "pedra", displayName: "Pedra", builtIn: false, protected: false, installed: true }] },
  analytics: {},
};

let lastPrompt = "";
const target: CompanionTarget = {
  id: "codex",
  health: async () => ({ targetId: "codex", checkedAt: Date.now(), configured: true, ready: true, method: "test" }),
  send: async (request) => { lastPrompt = request.prompt; return { text: "Lunch sounds like a good idea, Tom." }; },
  dispose() {},
};
const bubbles: string[] = [];
const speech: string[] = [];
const output = {
  cancel() {},
  speak: async (request: { text: string }) => { speech.push(request.text); return { ok: true, attempts: [] }; },
};
const orchestrator = new CompanionOrchestrator({
  targets: [target],
  output: output as never,
  getSettings: () => settings,
  getAppState: () => appState as never,
  showBubble: (_petId, text) => { bubbles.push(text); return true; },
  now: () => new Date(2026, 6, 17, 12, 30).getTime(),
});

const result = await orchestrator.sendUserTurn({ petId: "pedra", text: "How are you doing?", speak: false });
assert.equal(result.displayed, true);
assert.equal(result.spoken, false);
assert.deepEqual(bubbles, ["Lunch sounds like a good idea, Tom."]);
assert.deepEqual(speech, []);
assert.match(lastPrompt, /Warm, observant, and playfully blunt/);
assert.match(lastPrompt, /Thomas/);
assert.match(lastPrompt, /Take a real lunch break/);
assert.match(lastPrompt, /How are you doing/);

const contextSettings: CompanionSettings = {
  ...settings,
  context: { ...settings.context, pluginEnabled: true },
};
const controlCenterOnly = new CompanionOrchestrator({
  targets: [target],
  output: output as never,
  getSettings: () => contextSettings,
  getAppState: () => appState as never,
  getPluginFacts: () => [{ id: "fact:clock", pluginId: "test.plugin", text: "A deterministic fact.", expiresAt: 124_000 }],
  showBubble: () => false,
  now: () => 123_000,
});
const panelResult = await controlCenterOnly.sendUserTurn({ petId: "pedra", text: "Talk here", speak: false });
assert.equal(panelResult.displayed, false);
assert.ok(panelResult.displayToken);
assert.match(lastPrompt, /A deterministic fact/, "context expiry uses the same captured clock as the turn");
assert.equal(controlCenterOnly.acknowledgeDisplay("another-pet", panelResult.displayToken), false);
assert.equal(controlCenterOnly.acknowledgeDisplay("pedra", panelResult.displayToken), true);
assert.equal(controlCenterOnly.acknowledgeDisplay("pedra", panelResult.displayToken), false, "display acknowledgements are one-shot");

let release: (() => void) | undefined;
const slowTarget: CompanionTarget = {
  id: "codex",
  health: target.health,
  send: (request) => new Promise((resolve, reject) => {
    release = () => resolve({ text: "This arrived too late." });
    request.signal.addEventListener("abort", () => {
      const error = new Error("cancelled");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  }),
  dispose() {},
};
const staleBubbles: string[] = [];
const cancelling = new CompanionOrchestrator({
  targets: [slowTarget],
  output: output as never,
  getSettings: () => settings,
  getAppState: () => appState as never,
  showBubble: (_petId, text) => { staleBubbles.push(text); return true; },
});
const pending = cancelling.sendUserTurn({ petId: "pedra", text: "Wait for this", speak: false });
await Promise.resolve();
cancelling.cancel("pedra");
release?.();
await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
assert.deepEqual(staleBubbles, [], "a cancelled provider response must never reach the pet");

// A turn owns its generation before provider health is awaited. Starting a
// newer turn therefore cancels an older unresolved health probe immediately.
const firstHealth = deferred<CompanionTargetHealth>();
const secondHealth = deferred<CompanionTargetHealth>();
let healthCall = 0;
const healthRaceBubbles: string[] = [];
const healthRaceTarget: CompanionTarget = {
  id: "codex",
  health: () => (++healthCall === 1 ? firstHealth.promise : secondHealth.promise),
  send: async (request) => ({ text: request.prompt.includes("newer turn") ? "Newer response." : "Older response." }),
  dispose() {},
};
const healthRace = new CompanionOrchestrator({
  targets: [healthRaceTarget],
  output: output as never,
  getSettings: () => settings,
  getAppState: () => appState as never,
  showBubble: (_petId, text) => { healthRaceBubbles.push(text); return true; },
});
const olderHealthTurn = healthRace.sendUserTurn({ petId: "pedra", text: "older turn" });
const olderHealthRejected = rejectsAsAbort(olderHealthTurn);
const newerHealthTurn = healthRace.sendUserTurn({ petId: "pedra", text: "newer turn" });
secondHealth.resolve(readyHealth());
const newerHealthResult = await newerHealthTurn;
await olderHealthRejected;
firstHealth.resolve(readyHealth());
assert.equal(newerHealthResult.text, "Newer response.");
assert.deepEqual(healthRaceBubbles, ["Newer response."], "an older health completion cannot supersede a newer turn");

const cancelledHealth = deferred<CompanionTargetHealth>();
let cancelledHealthSendCalls = 0;
const cancelledHealthTarget: CompanionTarget = {
  id: "codex",
  health: () => cancelledHealth.promise,
  send: async () => { cancelledHealthSendCalls += 1; return { text: "Must not send." }; },
  dispose() {},
};
const healthCancellation = new CompanionOrchestrator({
  targets: [cancelledHealthTarget],
  output: output as never,
  getSettings: () => settings,
  getAppState: () => appState as never,
  showBubble: () => true,
});
const healthPending = healthCancellation.sendUserTurn({ petId: "pedra", text: "cancel during health" });
const healthRejected = rejectsAsAbort(healthPending);
healthCancellation.cancel("pedra");
await healthRejected;
cancelledHealth.resolve(readyHealth());
assert.equal(cancelledHealthSendCalls, 0, "cancelling an unresolved health check prevents provider generation");

async function assertPostProviderSettingsRejected(
  label: string,
  nextSettings: CompanionSettings,
): Promise<void> {
  let currentSettings = settings;
  const response = deferred<CompanionTargetResult>();
  const sendStarted = deferred<void>();
  const displayed: string[] = [];
  const mutableTarget: CompanionTarget = {
    id: "codex",
    health: async () => readyHealth(),
    send: () => { sendStarted.resolve(undefined); return response.promise; },
    dispose() {},
  };
  const mutable = new CompanionOrchestrator({
    targets: [mutableTarget],
    output: output as never,
    getSettings: () => currentSettings,
    getAppState: () => appState as never,
    showBubble: (_petId, text) => { displayed.push(text); return true; },
  });
  const turn = mutable.sendUserTurn({ petId: "pedra", text: `settings race ${label}` });
  const rejected = rejectsAsAbort(turn, label);
  await sendStarted.promise;
  currentSettings = nextSettings;
  response.resolve({ text: "This response lost authorization." });
  await rejected;
  assert.deepEqual(displayed, [], `${label} must reject display after provider generation`);
  mutable.dispose();
}

await assertPostProviderSettingsRejected("disabled companion", { ...settings, enabled: false });
await assertPostProviderSettingsRejected("withdrawn consent", { ...settings, consentVersion: 0 });
await assertPostProviderSettingsRejected("changed target", { ...settings, target: "host-ai" });

const proactiveSettings: CompanionSettings = {
  ...settings,
  proactivity: { enabled: true, frequency: "sometimes" },
};
let proactiveClock = 1_000;
let proactiveCurrentSettings = proactiveSettings;
const proactiveResponse = deferred<CompanionTargetResult>();
const proactiveStarted = deferred<void>();
const proactiveBubbles: string[] = [];
let proactiveHealthCalls = 0;
const proactiveTarget: CompanionTarget = {
  id: "codex",
  health: async () => { proactiveHealthCalls += 1; return readyHealth(); },
  send: (request) => {
    proactiveStarted.resolve(undefined);
    request.signal.addEventListener("abort", () => proactiveResponse.reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
    return proactiveResponse.promise;
  },
  dispose() {},
};
const proactiveExpiry = new CompanionOrchestrator({
  targets: [proactiveTarget],
  output: output as never,
  getSettings: () => proactiveCurrentSettings,
  getAppState: () => appState as never,
  showBubble: (_petId, text) => { proactiveBubbles.push(text); return true; },
  now: () => proactiveClock,
});
const expiredTurn = proactiveExpiry.sendProactiveTurn({
  petId: "pedra",
  text: "A temporary opportunity",
  proactive: { candidateId: "candidate:1", dedupeKey: "candidate:1", source: "time", expiresAt: 1_500 },
});
const expiredRejected = rejectsAsAbort(expiredTurn);
await proactiveStarted.promise;
proactiveClock = 1_500;
proactiveResponse.resolve({ text: "Too late to display." });
await expiredRejected;
assert.deepEqual(proactiveBubbles, [], "an expired proactive candidate cannot display its provider result");

proactiveCurrentSettings = { ...proactiveSettings, proactivity: { enabled: false, frequency: "sometimes" } };
const healthCallsBeforeDisabledRequest = proactiveHealthCalls;
await assert.rejects(
  proactiveExpiry.sendProactiveTurn({
    petId: "pedra",
    text: "Disabled before start",
    proactive: { candidateId: "candidate:2", dedupeKey: "candidate:2", source: "time", expiresAt: 2_500 },
  }),
  /disabled/,
);
assert.equal(proactiveHealthCalls, healthCallsBeforeDisabledRequest, "disabled proactivity is rejected before provider health");

// Selective cancellation aborts proactive work, but cannot disturb an active
// ordinary conversation.
let selectiveResponse = deferred<CompanionTargetResult>();
let selectiveStarted = deferred<void>();
const selectiveTarget: CompanionTarget = {
  id: "codex",
  health: async () => readyHealth(),
  send: (request) => {
    const responseForTurn = selectiveResponse;
    selectiveStarted.resolve(undefined);
    request.signal.addEventListener("abort", () => responseForTurn.reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
    return responseForTurn.promise;
  },
  dispose() {},
};
const selective = new CompanionOrchestrator({
  targets: [selectiveTarget],
  output: output as never,
  getSettings: () => proactiveSettings,
  getAppState: () => appState as never,
  showBubble: () => true,
  now: () => 2_000,
});
const ordinaryTurn = selective.sendUserTurn({ petId: "pedra", text: "ordinary turn" });
await selectiveStarted.promise;
selective.cancelProactive();
selectiveResponse.resolve({ text: "Ordinary response." });
assert.equal((await ordinaryTurn).text, "Ordinary response.");

selectiveResponse = deferred<CompanionTargetResult>();
selectiveStarted = deferred<void>();
const selectiveProactiveTurn = selective.sendProactiveTurn({
  petId: "pedra",
  text: "proactive turn",
  proactive: { candidateId: "candidate:3", dedupeKey: "candidate:3", source: "goal", expiresAt: 3_000 },
});
const selectiveProactiveRejected = rejectsAsAbort(selectiveProactiveTurn);
await selectiveStarted.promise;
selective.cancelProactive();
await selectiveProactiveRejected;
assert.deepEqual(selective.activity("pedra"), { thinking: false, speaking: false });

const undisplayedProactive = new CompanionOrchestrator({
  targets: [target],
  output: output as never,
  getSettings: () => proactiveSettings,
  getAppState: () => appState as never,
  showBubble: () => false,
  now: () => 2_000,
});
const undisplayedProactiveResult = await undisplayedProactive.sendProactiveTurn({
  petId: "pedra",
  text: "render in the panel",
  proactive: { candidateId: "candidate:4", dedupeKey: "candidate:4", source: "time", expiresAt: 3_000 },
});
assert.ok(undisplayedProactiveResult.displayToken);
undisplayedProactive.cancelProactive();
assert.equal(
  undisplayedProactive.acknowledgeDisplay("pedra", undisplayedProactiveResult.displayToken),
  false,
  "disabling proactivity invalidates a pending proactive display acknowledgement",
);

// A stale speech completion must not clear the speaking flag owned by a newer
// turn for the same pet.
const firstSpeech = deferred<{ ok: boolean; attempts: never[] }>();
const secondSpeech = deferred<{ ok: boolean; attempts: never[] }>();
const firstSpeechStarted = deferred<void>();
const secondSpeechStarted = deferred<void>();
let speechCall = 0;
const overlappingSpeechOutput = {
  cancel() {},
  speak: () => {
    speechCall += 1;
    if (speechCall === 1) {
      firstSpeechStarted.resolve(undefined);
      return firstSpeech.promise;
    }
    secondSpeechStarted.resolve(undefined);
    return secondSpeech.promise;
  },
};
const speechTarget: CompanionTarget = {
  id: "codex",
  health: async () => readyHealth(),
  send: async (request) => ({ text: request.prompt.includes("first spoken turn") ? "First spoken response." : "Second spoken response." }),
  dispose() {},
};
const speechRace = new CompanionOrchestrator({
  targets: [speechTarget],
  output: overlappingSpeechOutput as never,
  getSettings: () => settings,
  getAppState: () => appState as never,
  showBubble: () => true,
});
const firstSpokenTurn = speechRace.sendUserTurn({ petId: "pedra", text: "first spoken turn", speak: true });
await firstSpeechStarted.promise;
const secondSpokenTurn = speechRace.sendUserTurn({ petId: "pedra", text: "second spoken turn", speak: true });
await secondSpeechStarted.promise;
firstSpeech.resolve({ ok: true, attempts: [] });
assert.equal((await firstSpokenTurn).spoken, false, "a cancelled speech completion is not reported as current");
assert.deepEqual(speechRace.activity("pedra"), { thinking: false, speaking: true });
secondSpeech.resolve({ ok: true, attempts: [] });
assert.equal((await secondSpokenTurn).spoken, true);

// Memory consent is checked again after generation; turning it off preserves
// the accepted user turn but does not retain the later assistant response.
const memoryDirectory = mkdtempSync(join(tmpdir(), "openpets-orchestrator-memory-"));
const memoryNow = 1_700_000_000_000;
initializeCompanionMemory(memoryDirectory, memoryNow);
try {
  let memorySettings: CompanionSettings = { ...settings, memory: { enabled: true } };
  const memoryResponse = deferred<CompanionTargetResult>();
  const memorySendStarted = deferred<void>();
  const memoryTarget: CompanionTarget = {
    id: "codex",
    health: async () => readyHealth(),
    send: () => { memorySendStarted.resolve(undefined); return memoryResponse.promise; },
    dispose() {},
  };
  const memoryRace = new CompanionOrchestrator({
    targets: [memoryTarget],
    output: output as never,
    getSettings: () => memorySettings,
    getAppState: () => appState as never,
    showBubble: () => true,
    now: () => memoryNow,
  });
  const memoryTurn = memoryRace.sendUserTurn({ petId: "pedra", text: "Remember my accepted message" });
  await memorySendStarted.promise;
  memorySettings = { ...memorySettings, memory: { enabled: false } };
  memoryResponse.resolve({ text: "Do not retain this response." });
  await memoryTurn;
  assert.deepEqual(getCompanionMemorySnapshot(memoryNow).entries.map((entry) => entry.role), ["user"]);
  memoryRace.dispose();
} finally {
  rmSync(memoryDirectory, { recursive: true, force: true });
}

orchestrator.dispose();
controlCenterOnly.dispose();
cancelling.dispose();
healthRace.dispose();
healthCancellation.dispose();
proactiveExpiry.dispose();
selective.dispose();
undisplayedProactive.dispose();
speechRace.dispose();
console.log("companion orchestrator tests passed");
