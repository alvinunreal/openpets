import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

import { getVoicePlaybackTimeoutMs, VOICE_PLAYBACK_MAX_TIMEOUT_MS, VoiceAssistantPlaybackCoordinator } from "../src/voice-assistant-playback.js";
import { installWindowLossHandlers } from "../src/voice-playback-window.js";

const require = createRequire(import.meta.url);
const { splitSystemSpeech } = require("../../pet-tts-helper.cjs") as { splitSystemSpeech(text: string, maxChars?: number): string[] };

async function main(): Promise<void> {
  const owner = { id: "pet-window" };
  const otherOwner = { id: "other-window" };
  let started = 0;
  let stopped = 0;
  const coordinator = new VoiceAssistantPlaybackCoordinator(20);
  const transport = { start: () => { started += 1; }, stop: () => { stopped += 1; } };

  const first = coordinator.play("request-1", "audio", owner, transport);
  assert.equal(coordinator.complete({ owner: otherOwner, requestId: "request-1", kind: "audio", outcome: "ended" }), false, "completion from another window cannot settle playback");
  assert.equal(coordinator.complete({ owner, requestId: "request-1", kind: "audio", outcome: "ended" }), true);
  await first;

  const replacement = coordinator.play("request-2", "audio", owner, transport);
  assert.equal(coordinator.complete({ owner, requestId: "wrong-request", kind: "audio", outcome: "stopped" }), false, "a mismatched scoped stop cannot settle the active request");
  assert.equal(coordinator.complete({ owner, requestId: "request-2", kind: "audio", outcome: "stopped" }), true, "renderer replacement settles the old request");
  await assert.rejects(replacement, /stopped/);

  const perRequestCoordinator = new VoiceAssistantPlaybackCoordinator(5);
  const perRequest = perRequestCoordinator.play("request-custom-timeout", "audio", owner, { start: () => undefined, stop: () => undefined }, 500);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(perRequestCoordinator.complete({ owner, requestId: "request-custom-timeout", kind: "audio", outcome: "ended" }), true, "the supplied request timeout remains active after the coordinator default expires");
  await perRequest;

  const unscopedStop = coordinator.play("request-3", "system", owner, transport);
  assert.equal(coordinator.complete({ owner, requestId: "request-3", kind: "system", outcome: "stopped" }), true, "unscoped renderer stop is reported against the active request");
  await assert.rejects(unscopedStop, /stopped/);

  const lostWindow = coordinator.play("request-4", "audio", owner, transport);
  coordinator.failOwner(owner);
  await assert.rejects(lostWindow, /window was lost/);

  const sendFailure = coordinator.play("request-5", "audio", owner, { start: () => { throw new Error("renderer send failed"); }, stop: () => undefined });
  await assert.rejects(sendFailure, /renderer send failed/);

  const timeout = coordinator.play("request-6", "audio", owner, transport);
  await assert.rejects(timeout, /timed out/);
  assert.equal(started, 5);
  assert.equal(stopped, 1, "timeout requests are stopped before rejection");
  assert.equal(coordinator.pendingCount, 0);

  const longSystemText = "This is a deliberately long system speech response. ".repeat(60);
  const longSystemTimeout = getVoicePlaybackTimeoutMs({ kind: "system", text: longSystemText });
  assert.equal(longSystemTimeout > 15_000, true, "long system speech receives more than the old fixed deadline");
  assert.equal(getVoicePlaybackTimeoutMs({ kind: "system", text: longSystemText }, 0.5) >= longSystemTimeout, true, "slower speech receives a longer deadline");
  assert.equal(getVoicePlaybackTimeoutMs({ kind: "system", text: "x".repeat(10_000) }) <= VOICE_PLAYBACK_MAX_TIMEOUT_MS, true, "system speech deadline is capped");
  const lowBitrateAudio = new Uint8Array(64_000);
  assert.equal(getVoicePlaybackTimeoutMs({ kind: "audio", bytes: lowBitrateAudio }), VOICE_PLAYBACK_MAX_TIMEOUT_MS, "valid low-bitrate provider audio is not cut off by a byte-derived allowance");

  for (const event of ["render-process-gone", "did-fail-load"] as const) {
    const lossOwner = { id: event };
    const lossCoordinator = new VoiceAssistantPlaybackCoordinator(10_000);
    const windowEvents = new EventEmitter();
    const window = { on: windowEvents.on.bind(windowEvents), off: windowEvents.off.bind(windowEvents), webContents: new EventEmitter() } as unknown as Electron.BrowserWindow;
    const lost = lossCoordinator.play(event, "audio", lossOwner, transport);
    const cleanup = installWindowLossHandlers(window, () => lossCoordinator.failOwner(lossOwner));
    window.webContents.emit(event);
    await assert.rejects(lost, /window was lost/);
    cleanup();
  }

  const longText = "one two three four five six seven eight nine ten ".repeat(80);
  const chunks = splitSystemSpeech(longText, 32);
  assert.equal(chunks.join(""), longText, "system chunks preserve the authoritative text");
  assert.equal(chunks.every((chunk) => chunk.length <= 32), true);
  assert.equal(chunks.length > 1, true);
}

main().then(() => console.log("Voice playback and TTS chunk behavior verified."), (error) => { console.error(error); process.exitCode = 1; });
