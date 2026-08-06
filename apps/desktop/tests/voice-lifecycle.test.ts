import assert from "node:assert/strict";

import {
  VOICE_ACQUISITION_TIMEOUT_MS,
  VOICE_MAX_RECORDING_DURATION_MS,
  VOICE_MIN_RECORDING_DURATION_MS,
  VoiceCaptureService,
  type VoiceCaptureAttempt,
  type VoiceCaptureRecording,
  type VoiceCaptureResult,
} from "../src/voice-capture.js";
import {
  VOICE_CAPTURE_CANCELLED_ERROR,
  VOICE_EMPTY_TRANSCRIPT_ERROR,
  VOICE_TRANSCRIPTION_CANCELLED_ERROR,
  VOICE_TRANSCRIPTION_TIMEOUT_ERROR,
  VOICE_TRANSCRIPTION_TIMEOUT_MS,
  VoiceListeningService,
} from "../src/voice-listening-service.js";
import { VoicePrivacyIndicator, type VoicePrivacyIndicatorSurface } from "../src/voice-privacy-indicator.js";

class FakeSurface implements VoicePrivacyIndicatorSurface {
  showCount = 0;
  hideCount = 0;
  destroyCount = 0;

  show(): void { this.showCount += 1; }
  hide(): void { this.hideCount += 1; }
  destroy(): void { this.destroyCount += 1; }
}

class FakeRecording implements VoiceCaptureRecording {
  readonly result: Promise<VoiceCaptureResult>;
  stopCount = 0;
  cancelCount = 0;
  closeCount = 0;
  #resolve!: (capture: VoiceCaptureResult) => void;
  #reject!: (error: unknown) => void;

  constructor() {
    this.result = new Promise<VoiceCaptureResult>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    void this.result.catch(() => undefined);
  }

  resolveCapture(): void {
    this.#resolve({ bytes: new Uint8Array(128), mimeType: "audio/webm" });
  }

  rejectCapture(error = new Error("capture failed")): void {
    this.#reject(error);
  }

  async stop(): Promise<VoiceCaptureResult> {
    this.stopCount += 1;
    this.resolveCapture();
    return this.result;
  }

  async cancel(): Promise<void> {
    this.cancelCount += 1;
    this.#reject(new Error("capture cancelled"));
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

class ControlledAttempt implements VoiceCaptureAttempt {
  readonly recording = new FakeRecording();
  cancelCount = 0;
  disposeCount = 0;
  #resolveAcquire!: (recording: VoiceCaptureRecording) => void;
  #rejectAcquire!: (error: unknown) => void;
  #cancelled = false;
  readonly #onAcquired: () => boolean;
  readonly acquirePromise: Promise<VoiceCaptureRecording>;

  constructor(onAcquired: () => boolean) {
    this.#onAcquired = onAcquired;
    this.acquirePromise = new Promise<VoiceCaptureRecording>((resolve, reject) => {
      this.#resolveAcquire = resolve;
      this.#rejectAcquire = reject;
    });
  }

  acquire(): Promise<VoiceCaptureRecording> {
    return this.acquirePromise;
  }

  resolveAcquisition(): void {
    if (this.#cancelled || !this.#onAcquired()) {
      void this.recording.cancel();
      void this.recording.close();
      this.#rejectAcquire(new Error("late acquisition was rejected"));
      return;
    }
    this.#resolveAcquire(this.recording);
  }

  async cancel(): Promise<void> {
    this.cancelCount += 1;
    this.#cancelled = true;
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }
}

type Fixture = {
  readonly surface: FakeSurface;
  readonly indicator: VoicePrivacyIndicator;
  readonly capture: VoiceCaptureService;
  readonly listening: VoiceListeningService;
  getAttempt(): ControlledAttempt;
};

function fixture(
  transcriber: (capture: VoiceCaptureResult, signal: AbortSignal) => Promise<string> = async () => "  hello  ",
  options: { acquisitionTimeoutMs?: number; transcriptionTimeoutMs?: number } = {},
): Fixture {
  const surface = new FakeSurface();
  const indicator = new VoicePrivacyIndicator(() => surface);
  let attempt: ControlledAttempt | undefined;
  const capture = new VoiceCaptureService((_, onAcquired) => {
    attempt = new ControlledAttempt(onAcquired);
    return attempt;
  }, indicator, { acquisitionTimeoutMs: options.acquisitionTimeoutMs });
  const listening = new VoiceListeningService(capture, transcriber, { transcriptionTimeoutMs: options.transcriptionTimeoutMs });
  return { surface, indicator, capture, listening, getAttempt: () => attempt! };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

assert.equal(VOICE_ACQUISITION_TIMEOUT_MS, 15_000);
assert.equal(VOICE_TRANSCRIPTION_TIMEOUT_MS, 30_000);
assert.equal(VOICE_MIN_RECORDING_DURATION_MS, 1_000);
assert.equal(VOICE_MAX_RECORDING_DURATION_MS, 30_000);

{
  const surface = new FakeSurface();
  const indicator = new VoicePrivacyIndicator(() => surface);
  indicator.trackStarted();
  indicator.trackStarted();
  indicator.trackStopped();
  indicator.trackStopped();
  indicator.trackStopped();
  indicator.shutdown();
  assert.equal(surface.showCount, 1);
  assert.equal(surface.hideCount, 1);
  assert.equal(surface.destroyCount, 1);
  assert.equal(indicator.liveTracks, 0);
}

{
  const current = fixture();
  const pending = current.listening.listenOnce(45_000);
  await flush();
  assert.equal(current.surface.showCount, 0, "the indicator stays hidden while acquisition is pending");
  current.getAttempt().resolveAcquisition();
  await flush();
  assert.equal(current.surface.showCount, 1, "the indicator starts only after microphone acquisition");
  current.getAttempt().recording.resolveCapture();
  assert.deepEqual(await pending, { text: "hello" });
  assert.equal(current.surface.hideCount, 1);
  assert.equal(current.getAttempt().recording.closeCount, 1);
  assert.equal(current.getAttempt().disposeCount, 1);
}

{
  const current = fixture();
  const pending = current.listening.listenOnce(5_000);
  await flush();
  await current.listening.cancel();
  await assert.rejects(pending, new RegExp(VOICE_CAPTURE_CANCELLED_ERROR));
  assert.equal(current.surface.showCount, 0);
  assert.ok(current.getAttempt().cancelCount >= 1);
  assert.equal(current.getAttempt().disposeCount, 1);

  // A late getUserMedia resolution must be rejected and cleaned without
  // resurrecting the indicator or the cancelled listen operation.
  current.getAttempt().resolveAcquisition();
  await flush();
  assert.equal(current.surface.showCount, 0);
  assert.ok(current.getAttempt().recording.cancelCount >= 1);
  assert.ok(current.getAttempt().recording.closeCount >= 1);
}

{
  const current = fixture();
  const pending = current.listening.listenOnce(5_000);
  await flush();
  current.getAttempt().resolveAcquisition();
  await flush();
  assert.equal(current.surface.showCount, 1);
  await current.listening.cancel("The plugin was stopped.");
  await assert.rejects(pending, /The plugin was stopped\./);
  assert.ok(current.getAttempt().recording.cancelCount >= 1);
  assert.equal(current.surface.hideCount, 1);
  assert.equal(current.getAttempt().disposeCount, 1);
}

{
  let resolveTranscription!: (text: string) => void;
  let signal: AbortSignal | undefined;
  const current = fixture((_capture, nextSignal) => {
    signal = nextSignal;
    return new Promise<string>((resolve) => { resolveTranscription = resolve; });
  });
  const pending = current.listening.listenOnce(5_000);
  await flush();
  current.getAttempt().resolveAcquisition();
  await flush();
  current.getAttempt().recording.resolveCapture();
  await flush();
  assert.ok(signal);
  await current.listening.cancel();
  await assert.rejects(pending, new RegExp(VOICE_TRANSCRIPTION_CANCELLED_ERROR));
  assert.equal(signal?.aborted, true);
  resolveTranscription("late text");
  await flush();
  assert.equal(current.surface.hideCount, 1);
}

{
  const current = fixture(async () => "ok", { acquisitionTimeoutMs: 10 });
  const pending = current.listening.listenOnce(5_000);
  await assert.rejects(pending, /Microphone acquisition timed out\./);
  assert.ok(current.getAttempt().cancelCount >= 1);
  assert.equal(current.getAttempt().disposeCount, 1);
  assert.equal(current.surface.showCount, 0);
}

{
  let signal: AbortSignal | undefined;
  const current = fixture((_capture, nextSignal) => {
    signal = nextSignal;
    return new Promise<string>(() => undefined);
  }, { transcriptionTimeoutMs: 10 });
  const pending = current.listening.listenOnce(5_000);
  await flush();
  current.getAttempt().resolveAcquisition();
  await flush();
  current.getAttempt().recording.resolveCapture();
  await assert.rejects(pending, new RegExp(VOICE_TRANSCRIPTION_TIMEOUT_ERROR));
  assert.equal(signal?.aborted, true);
  assert.equal(current.surface.hideCount, 1);
}

{
  const current = fixture(async () => " \t\n ");
  const pending = current.listening.listenOnce(5_000);
  await flush();
  current.getAttempt().resolveAcquisition();
  await flush();
  current.getAttempt().recording.resolveCapture();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.message === VOICE_EMPTY_TRANSCRIPT_ERROR);
}

{
  const current = fixture();
  const first = current.listening.listenOnce(5_000);
  await flush();
  assert.throws(() => current.listening.listenOnce(5_000), /A voice capture is already in progress\./);
  await current.listening.cancel();
  await assert.rejects(first, /Voice capture was cancelled\./);
}

{
  const current = fixture();
  const pending = current.listening.listenOnce(5_000);
  await flush();
  current.getAttempt().resolveAcquisition();
  await flush();
  await current.listening.shutdown();
  await assert.rejects(pending, /OpenPets is shutting down\./);
  assert.equal(current.surface.destroyCount, 1);
  assert.equal(current.getAttempt().disposeCount, 1);
}

console.log("Voice capture lifecycle behavior verified.");
