import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import type { BrowserWindow } from "electron";

import type { VoiceSynthesisRequest, VoiceSynthesisResult } from "../src/voice-provider.js";
import type { VoiceProviderRegistry } from "../src/voice-provider-registry.js";
import { initializeVoiceSettings, updateVoiceSettings, type VoiceProviderId } from "../src/voice-settings.js";

type PlaybackRuntime = {
  playAudio(window: BrowserWindow, payload: { readonly bytes: Uint8Array; readonly mimeType: string; readonly volume: number }, generation: number): Promise<void>;
  speakSystem(window: BrowserWindow, text: string, opts: { readonly voice?: string; readonly rate?: number }, generation: number): Promise<void>;
  stop(window: BrowserWindow): void;
};

const runtimeKey = "__openPetsVoiceLifecycleRuntime";
const runtimeGlobal = globalThis as typeof globalThis & { [runtimeKey]?: PlaybackRuntime };
const stubModules = new Map<string, string>([
  ["./app-state.js", "export const getAppStateSnapshot = () => ({ preferences: { defaultPetId: 'default' } });"],
  ["./default-pet-controller.js", `export const getDefaultPetWindowForPlugins = () => globalThis.${runtimeKey}.defaultWindow?.() ?? null;`],
  ["./logger.js", "export const debug = () => undefined; export const warn = () => undefined;"],
  ["./pet-window.js", [
    `export const playPetWindowVoiceAudio = (...args) => globalThis.${runtimeKey}.playAudio(...args);`,
    `export const speakPetWindowVoiceTts = (...args) => globalThis.${runtimeKey}.speakSystem(...args);`,
    `export const stopPetWindowVoice = (...args) => globalThis.${runtimeKey}.stop(...args);`,
  ].join("\n")],
  ["./plugin-pet-registry.js", [
    "export const resolveInstalledPetVoiceTarget = () => { throw new Error('unexpected installed-pet target'); };",
    "export const resolvePluginPetVoiceTarget = () => { throw new Error('unexpected plugin-pet target'); };",
  ].join("\n")],
]);
const loaderSource = `
const stubs = new Map(${JSON.stringify([...stubModules])});
export async function resolve(specifier, context, nextResolve) {
  const source = stubs.get(specifier);
  if (!source) return nextResolve(specifier, context);
  return { url: "data:text/javascript;charset=utf-8," + encodeURIComponent(source), shortCircuit: true };
}
`;
register(`data:text/javascript;charset=utf-8,${encodeURIComponent(loaderSource)}`, import.meta.url);

const userData = mkdtempSync(join(tmpdir(), "openpets-voice-lifecycle-"));
try {
  initializeVoiceSettings(userData);
  updateVoiceSettings({
    output: {
      providerId: "pockettts",
      voiceId: "initial-voice",
      model: "initial-model",
      overlapPolicy: "queue",
      providerFallback: "fail",
    },
  });

  const synthesisCalls: Array<{ providerId: VoiceProviderId; request: VoiceSynthesisRequest }> = [];
  const playbackTexts: string[] = [];
  let releaseFirstPlayback: (() => void) | undefined;
  let markFirstPlaybackStarted: (() => void) | undefined;
  const firstPlaybackStarted = new Promise<void>((resolve) => { markFirstPlaybackStarted = resolve; });
  runtimeGlobal[runtimeKey] = {
    async playAudio() {},
    async speakSystem(_window, text) {
      playbackTexts.push(text);
      if (playbackTexts.length === 1) {
        markFirstPlaybackStarted?.();
        await new Promise<void>((resolve) => { releaseFirstPlayback = resolve; });
      }
    },
    stop() {},
  };

  const providers = {
    async synthesize(providerId: VoiceProviderId, request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
      synthesisCalls.push({ providerId, request });
      return { kind: "system", text: request.text, voiceId: request.voiceId, rate: request.rate };
    },
  } as unknown as VoiceProviderRegistry;
  const { VoiceOutputService } = await import("../src/voice-output-service.js");
  const output = new VoiceOutputService(providers);
  const window = { id: 7, isDestroyed: () => false } as BrowserWindow;

  const first = output.speak({
    text: "  First message  ",
    target: { kind: "window", petId: "pet", window },
    reason: "conversation",
    requestedProviderId: "system",
    overlapPolicy: "queue",
  });
  await firstPlaybackStarted;
  const explicitQueued = output.speak({
    text: "  Explicit queued message  ",
    target: { kind: "window", petId: "pet", window },
    reason: "conversation",
    requestedProviderId: "elevenlabs",
    requestedVoiceId: "queued-voice",
    requestedModel: "queued-model",
    overlapPolicy: "queue",
  });
  const resolvedQueued = output.speak({
    text: "  Resolved queued message  ",
    target: { kind: "window", petId: "pet", window },
    reason: "conversation",
    overlapPolicy: "queue",
  });

  updateVoiceSettings({ output: { providerId: "system", voiceId: "changed-voice", model: "changed-model" } });
  assert.equal(synthesisCalls.length, 1, "queued speech waits for the active playback");
  releaseFirstPlayback?.();
  assert.equal((await first).ok, true);
  assert.equal((await explicitQueued).ok, true);
  assert.equal((await resolvedQueued).ok, true);

  assert.deepEqual(synthesisCalls.map(({ providerId, request }) => ({
    providerId,
    text: request.text,
    voiceId: request.voiceId,
    model: request.model,
  })), [
    { providerId: "system", text: "First message", voiceId: undefined, model: undefined },
    { providerId: "elevenlabs", text: "Explicit queued message", voiceId: "queued-voice", model: "queued-model" },
    { providerId: "pockettts", text: "Resolved queued message", voiceId: "initial-voice", model: "initial-model" },
  ], "queued speech keeps the normalized text and selection resolved when it was accepted");
  assert.deepEqual(playbackTexts, ["First message", "Explicit queued message", "Resolved queued message"]);
} finally {
  delete runtimeGlobal[runtimeKey];
  rmSync(userData, { recursive: true, force: true });
}

type Listener = (...args: unknown[]) => void;

class FakeEventTarget {
  readonly #listeners = new Map<string, Array<{ listener: Listener; once: boolean }>>();

  addEventListener(type: string, listener: Listener, options?: { once?: boolean }): void {
    const entries = this.#listeners.get(type) ?? [];
    entries.push({ listener, once: options?.once === true });
    this.#listeners.set(type, entries);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.set(type, (this.#listeners.get(type) ?? []).filter((entry) => entry.listener !== listener));
  }

  dispatch(type: string): void {
    for (const entry of [...(this.#listeners.get(type) ?? [])]) {
      if (entry.once) this.removeEventListener(type, entry.listener);
      entry.listener();
    }
  }

  listeners(type: string): Listener[] {
    return (this.#listeners.get(type) ?? []).map((entry) => entry.listener);
  }
}

class FakeAudio extends FakeEventTarget {
  static readonly instances: FakeAudio[] = [];
  volume = 1;
  paused = false;

  constructor(readonly source: string) {
    super();
    FakeAudio.instances.push(this);
  }

  play(): Promise<void> {
    return new Promise(() => undefined);
  }

  pause(): void {
    this.paused = true;
  }
}

class FakeUtterance extends FakeEventTarget {
  static readonly instances: FakeUtterance[] = [];
  rate = 1;
  voice: unknown;

  constructor(readonly text: string) {
    super();
    FakeUtterance.instances.push(this);
  }
}

class FakeSpeechSynthesis extends FakeEventTarget {
  voices: Array<{ voiceURI: string; name: string; lang: string }> = [];
  cancelCount = 0;
  readonly spoken: FakeUtterance[] = [];

  getVoices() { return this.voices; }
  speak(utterance: FakeUtterance) { this.spoken.push(utterance); }
  cancel() {
    this.cancelCount += 1;
    // Chromium may synchronously fire a terminal media event while cancelling.
    for (const utterance of this.spoken) utterance.dispatch("end");
  }
}

const preloadSource = readFileSync(new URL("../../pet-preload.cjs", import.meta.url), "utf8");
const ipcHandlers = new Map<string, Listener[]>();
const sent: Array<{ channel: string; payload: unknown }> = [];
const timers = new Map<number, () => void>();
let nextTimerId = 1;
const synthesis = new FakeSpeechSynthesis();
const ipcRenderer = {
  on(channel: string, listener: Listener) {
    ipcHandlers.set(channel, [...(ipcHandlers.get(channel) ?? []), listener]);
  },
  send(channel: string, payload?: unknown) {
    sent.push({ channel, payload });
  },
};
const emitIpc = (channel: string, payload?: unknown) => {
  for (const listener of ipcHandlers.get(channel) ?? []) listener({}, payload);
};

runInNewContext(preloadSource, {
  require(specifier: string) {
    if (specifier === "electron") return { ipcRenderer };
    throw new Error(`Unexpected preload dependency: ${specifier}`);
  },
  window: { speechSynthesis: synthesis },
  document: {
    readyState: "loading",
    documentElement: { dataset: {} },
    addEventListener() {},
    querySelector() { return null; },
    elementFromPoint() { return null; },
  },
  Audio: FakeAudio,
  SpeechSynthesisUtterance: FakeUtterance,
  setTimeout(callback: () => void) {
    const id = nextTimerId++;
    timers.set(id, callback);
    return id;
  },
  clearTimeout(id: number) { timers.delete(id); },
  console,
}, { filename: "pet-preload.cjs" });

emitIpc("openpets:voice-play-audio", { requestId: "audio-1", dataUrl: "data:audio/mpeg;base64,AA==", volume: 1 });
emitIpc("openpets:voice-play-audio", { requestId: "audio-2", dataUrl: "data:audio/mpeg;base64,AA==", volume: 1 });
emitIpc("openpets:voice-system-speak", { requestId: "system-1", text: "Hello" });
emitIpc("openpets:voice-stop");

const playbackResults = () => sent.filter((entry) => entry.channel === "openpets:voice-playback-finished");
assert.deepEqual(playbackResults().map((entry) => {
  const payload = entry.payload as { requestId?: string; ok?: boolean };
  return { requestId: payload.requestId, ok: payload.ok };
}), [
  { requestId: "audio-1", ok: false },
  { requestId: "audio-2", ok: false },
  { requestId: "system-1", ok: false },
], "stopping voice settles every active renderer request");
assert.equal(FakeAudio.instances.every((audio) => audio.paused), true);
assert.equal(synthesis.cancelCount, 1);
FakeAudio.instances[0]?.dispatch("ended");
FakeAudio.instances[1]?.dispatch("error");
FakeUtterance.instances[0]?.dispatch("end");
assert.equal(playbackResults().length, 3, "late media events cannot settle a stopped request twice");

emitIpc("openpets:voice-system-list-voices", { requestId: "voices-event" });
const eventTimer = [...timers.values()][0];
assert.ok(eventTimer);
const staleEventListener = synthesis.listeners("voiceschanged")[0];
assert.ok(staleEventListener);
synthesis.voices = [{ voiceURI: "voice://one", name: "One", lang: "en-US" }];
synthesis.dispatch("voiceschanged");
eventTimer();
assert.equal(synthesis.listeners("voiceschanged").length, 0);

synthesis.voices = [];
emitIpc("openpets:voice-system-list-voices", { requestId: "voices-timeout" });
const timeoutTimer = [...timers.values()][0];
assert.ok(timeoutTimer);
const staleTimeoutListener = synthesis.listeners("voiceschanged")[0];
assert.ok(staleTimeoutListener);
timeoutTimer();
staleTimeoutListener();
assert.equal(synthesis.listeners("voiceschanged").length, 0);
const voiceResults = sent.filter((entry) => entry.channel === "openpets:voice-system-voices-result");
assert.equal(voiceResults.filter((entry) => (entry.payload as { requestId?: string }).requestId === "voices-event").length, 1);
assert.equal(voiceResults.filter((entry) => (entry.payload as { requestId?: string }).requestId === "voices-timeout").length, 1);

console.log("voice output lifecycle behavior verified");
