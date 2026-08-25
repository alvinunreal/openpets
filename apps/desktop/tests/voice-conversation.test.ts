import assert from "node:assert/strict";

import {
  createDefaultVoiceRealtimeSessionConfig,
  VoiceConversationService,
  type VoiceConversationEvent,
  type VoiceConversationTransport,
  type VoiceConversationTransportContext,
} from "../src/voice-conversation.js";
import {
  VoiceCaptureService,
  type VoiceCaptureAttempt,
  type VoiceCaptureRecording,
  type VoiceCaptureResult,
} from "../src/voice-capture.js";
import { VoiceMicrophoneArbiter } from "../src/voice-microphone-arbiter.js";
import { VoicePrivacyIndicator, type VoicePrivacyIndicatorSurface } from "../src/voice-privacy-indicator.js";

class FakeSurface implements VoicePrivacyIndicatorSurface {
  showCount = 0;
  hideCount = 0;
  destroyCount = 0;

  show(): void { this.showCount += 1; }
  hide(): void { this.hideCount += 1; }
  destroy(): void { this.destroyCount += 1; }
}

class FakeTransport implements VoiceConversationTransport {
  readonly resources = { micTracks: 1, peerOpen: true, channelOpen: true, audioAttached: true, windowAlive: true };
  readonly muted: boolean[] = [];
  microphoneTrackEnabled = true;
  closeCount = 0;
  readonly #context: VoiceConversationTransportContext;
  readonly #startGate = deferred<void>();
  readonly #startFailure: Error | null;
  readonly #autoConnect: boolean;

  constructor(context: VoiceConversationTransportContext, options: { autoConnect?: boolean; startFailure?: Error } = {}) {
    this.#context = context;
    this.#autoConnect = options.autoConnect === true;
    this.#startFailure = options.startFailure ?? null;
  }

  async start(): Promise<void> {
    if (this.#startFailure) throw this.#startFailure;
    if (this.#autoConnect) {
      this.connect();
      return;
    }
    await this.#startGate.promise;
  }

  setMuted(muted: boolean): void {
    this.muted.push(muted);
    this.#desiredMuted = muted;
    if (this.#microphoneReady) this.microphoneTrackEnabled = !muted;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.resources.micTracks = 0;
    this.resources.peerOpen = false;
    this.resources.channelOpen = false;
    this.resources.audioAttached = false;
    this.resources.windowAlive = false;
  }

  connect(): void {
    this.#microphoneReady = true;
    this.microphoneTrackEnabled = this.#desiredMuted === false;
    this.#context.emit({ type: "microphone-acquired" });
    this.#context.emit({ type: "negotiating" });
    this.#context.emit({ type: "connected" });
    this.#startGate.resolve(undefined);
  }

  emit(event: VoiceConversationEvent): void {
    this.#context.emit(event);
  }

  #microphoneReady = false;
  #desiredMuted = false;
}

class ImmediateRecording implements VoiceCaptureRecording {
  readonly result: Promise<VoiceCaptureResult>;
  #reject!: (error: unknown) => void;

  constructor() {
    this.result = new Promise<VoiceCaptureResult>((_resolve, reject) => { this.#reject = reject; });
    void this.result.catch(() => undefined);
  }

  async stop(): Promise<VoiceCaptureResult> {
    return { bytes: new Uint8Array(128), mimeType: "audio/webm" };
  }

  async cancel(): Promise<void> {
    this.#reject(new Error("capture cancelled"));
  }

  async close(): Promise<void> {}
}

class ImmediateAttempt implements VoiceCaptureAttempt {
  readonly recording = new ImmediateRecording();
  readonly #onAcquired: () => boolean;
  disposeCount = 0;

  constructor(onAcquired: () => boolean) {
    this.#onAcquired = onAcquired;
  }

  async acquire(): Promise<VoiceCaptureRecording> {
    if (!this.#onAcquired()) throw new Error("capture was cancelled");
    return this.recording;
  }

  async cancel(): Promise<void> {
    await this.recording.cancel();
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }
}

function fixture(options: { autoConnect?: boolean; startFailure?: Error; factoryError?: Error } = {}) {
  const surface = new FakeSurface();
  const indicator = new VoicePrivacyIndicator(() => surface);
  const microphoneArbiter = new VoiceMicrophoneArbiter();
  const transports: FakeTransport[] = [];
  const service = new VoiceConversationService({
    microphoneArbiter,
    privacyIndicator: indicator,
    transportFactory: (context) => {
      if (options.factoryError) throw options.factoryError;
      const transport = new FakeTransport(context, options);
      transports.push(transport);
      return transport;
    },
  });
  return { surface, indicator, microphoneArbiter, service, transports };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

{
    const config = createDefaultVoiceRealtimeSessionConfig();
    const audio = config.audio as { input?: { turn_detection?: Record<string, unknown> } };
    assert.deepEqual(config.output_modalities, ["audio"]);
    assert.deepEqual(config.tools, []);
  assert.equal(config.tool_choice, "none");
  assert.deepEqual(audio.input?.turn_detection, { type: "server_vad", create_response: true, interrupt_response: true });
}

{
  const current = fixture();
  const first = current.service.start();
  await flush();
  assert.equal(current.service.snapshot().phase, "acquiring");
  await assert.rejects(() => current.service.start(), /already in progress/);
  current.transports[0]!.connect();
  await first;
  assert.equal(current.service.snapshot().phase, "connected");
  await current.service.close();
}

{
  const current = fixture();
  const start = current.service.start();
  await flush();
  await current.service.close();
  await assert.rejects(start, /closed/);
  assert.equal(current.transports[0]?.closeCount, 1);
  assert.equal(current.microphoneArbiter.activeOwner, null);
  current.transports[0]?.connect();
  await flush();
  assert.equal(current.service.snapshot().phase, "idle");
  assert.equal(current.surface.showCount, 0);
}

{
  const current = fixture();
  const start = current.service.start();
  await flush();
  current.transports[0]!.emit({ type: "microphone-acquired" });
  current.transports[0]!.emit({ type: "negotiating" });
  assert.equal(current.surface.showCount, 1);
  await current.service.close();
  await assert.rejects(start, /closed/);
  assert.equal(current.surface.hideCount, 1);
  assert.equal(current.microphoneArbiter.activeOwner, null);
}

{
  const current = fixture({ autoConnect: true });
  await current.service.start();
  await current.service.close();
  assert.equal(current.transports[0]?.closeCount, 1);
  await Promise.all([current.service.close(), current.service.close(), current.service.close()]);
  const second = current.service.start();
  await second;
  assert.equal(current.transports.length, 2);
  await current.service.close();
}

for (const failure of [
  { name: "permission", options: { factoryError: new Error("microphone permission denied") }, expected: /permission denied/ },
  { name: "provider", options: { startFailure: new Error("provider negotiation failed") }, expected: /provider negotiation failed/ },
  { name: "RTC", options: { startFailure: new Error("RTC connection failed") }, expected: /RTC connection failed/ },
] as const) {
  const current = fixture(failure.options);
  await assert.rejects(current.service.start(), failure.expected, failure.name);
  assert.equal(current.microphoneArbiter.activeOwner, null);
  assert.equal(current.service.snapshot().phase, "idle");
  assert.match(current.service.snapshot().error ?? "", failure.expected);
}

{
  const current = fixture({ autoConnect: true });
  await current.service.start();
  const transport = current.transports[0]!;
  await current.service.mute();
  await current.service.mute();
  assert.equal(current.service.snapshot().muted, true);
  assert.deepEqual(transport.muted, [true]);
  await current.service.unmute();
  assert.equal(current.service.snapshot().muted, false);
  assert.deepEqual(transport.muted, [true, false]);
  await current.service.close();
}

{
  const current = fixture();
  const start = current.service.start();
  await flush();
  const transport = current.transports[0]!;
  await current.service.mute();
  assert.equal(current.service.snapshot().muted, true);
  assert.equal(transport.microphoneTrackEnabled, true);
  transport.connect();
  await start;
  assert.equal(transport.microphoneTrackEnabled, false);
  assert.equal(current.service.snapshot().muted, true);
  await current.service.close();
}

{
  const current = fixture({ autoConnect: true });
  await current.service.start();
  const transport = current.transports[0]!;
  transport.emit({ type: "response-started" });
  transport.emit({ type: "response-audio-started" });
  transport.emit({ type: "speech-started" });
  assert.equal(current.service.snapshot().activity, "user-speaking");
  assert.equal(current.service.snapshot().interruptionCount, 1);
  transport.emit({ type: "speech-stopped" });
  assert.equal(current.service.snapshot().activity, "thinking");
  transport.emit({ type: "response-completed" });
  assert.equal(current.service.snapshot().activity, "idle");
  await current.service.close();
}

{
  const current = fixture({ autoConnect: true });
  await current.service.start();
  const transport = current.transports[0]!;
  transport.emit({ type: "closed", reason: "renderer crashed" });
  await flush();
  assert.equal(transport.closeCount, 1);
  assert.equal(current.microphoneArbiter.activeOwner, null);
  assert.match(current.service.snapshot().error ?? "", /renderer crashed/);
  transport.emit({ type: "response-audio-started" });
  assert.equal(current.service.snapshot().activity, "idle");
}

{
  const current = fixture({ autoConnect: true });
  await current.service.start();
  const oldTransport = current.transports[0]!;
  await current.service.close();
  const secondStart = current.service.start();
  await secondStart;
  const newTransport = current.transports[1]!;
  assert.notEqual(current.transports[0]!.resources.windowAlive, newTransport.resources.windowAlive);
  assert.notEqual(current.transports[0], newTransport);
  oldTransport.emit({ type: "response-audio-started" });
  assert.equal(current.service.snapshot().activity, "idle");
  assert.equal(current.service.snapshot().generation, 2);
  await current.service.close();
}

{
  const current = fixture({ autoConnect: true });
  await current.service.start();
  const transport = current.transports[0]!;
  assert.equal(current.microphoneArbiter.activeOwner, "conversation");
  await current.service.shutdown();
  await current.service.shutdown();
  assert.equal(transport.resources.micTracks, 0);
  assert.equal(transport.resources.peerOpen, false);
  assert.equal(transport.resources.channelOpen, false);
  assert.equal(transport.resources.audioAttached, false);
  assert.equal(transport.resources.windowAlive, false);
  assert.equal(current.indicator.liveTracks, 0);
  assert.equal(current.surface.destroyCount, 0, "lane shutdown must not destroy shared privacy state");
  current.indicator.shutdown();
  assert.equal(current.surface.destroyCount, 1, "the shared owner performs final indicator destruction");
  assert.equal(current.microphoneArbiter.activeOwner, null);
  await assert.rejects(() => current.service.start(), /shut down/);
}

{
  const surface = new FakeSurface();
  const indicator = new VoicePrivacyIndicator(() => surface);
  const arbiter = new VoiceMicrophoneArbiter();
  const conversation = new VoiceConversationService({
    microphoneArbiter: arbiter,
    privacyIndicator: indicator,
    transportFactory: (context) => new FakeTransport(context),
  });
  const capture = new VoiceCaptureService(
    (_duration, onAcquired) => new ImmediateAttempt(onAcquired),
    indicator,
    { microphoneArbiter: arbiter },
  );
  const conversationStart = conversation.start();
  await flush();
  await assert.rejects(() => capture.start(1_000), /realtime voice conversation/);
  await conversation.close();
  await conversationStart.catch(() => undefined);
  const captureHandle = await capture.start(1_000);
  await captureHandle.cancel();
  assert.equal(arbiter.activeOwner, null);
}

{
  const surface = new FakeSurface();
  const indicator = new VoicePrivacyIndicator(() => surface);
  const arbiter = new VoiceMicrophoneArbiter();
  const capture = new VoiceCaptureService(
    (_duration, onAcquired) => new ImmediateAttempt(onAcquired),
    indicator,
    { microphoneArbiter: arbiter },
  );
  const handle = await capture.start(1_000);
  const conversation = new VoiceConversationService({
    microphoneArbiter: arbiter,
    privacyIndicator: indicator,
    transportFactory: (context) => new FakeTransport(context),
  });
  await assert.rejects(() => conversation.start(), /one-shot voice listening/);
  await handle.cancel();
  assert.equal(arbiter.activeOwner, null);
}

console.log("Realtime voice conversation lifecycle behavior verified.");

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolveValue!: (value: T) => void;
  let rejectValue!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { resolveValue = resolve; rejectValue = reject; });
  return { promise, resolve: resolveValue, reject: rejectValue };
}
