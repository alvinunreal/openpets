import assert from "node:assert/strict";

import {
  VoiceAssistantSession,
  type VoiceAssistantActivityEvent,
  type VoiceAssistantInput,
  type VoiceAssistantInputOptions,
  type VoiceAssistantPlayer,
  type VoiceAssistantSessionEvent,
  type VoiceAssistantSessionSnapshot,
  type VoiceAssistantSpeech,
  type VoiceAssistantSynthesizer,
  type VoiceAssistantTurnAdapter,
  type VoiceAssistantTurnResult,
} from "../src/voice-assistant-session.js";
import {
  VoiceCaptureService,
  type VoiceCaptureAttempt,
  type VoiceCaptureRecording,
  type VoiceCaptureResult,
} from "../src/voice-capture.js";
import { VoiceMicrophoneArbiter, type VoiceMicrophoneReservation } from "../src/voice-microphone-arbiter.js";
import { VoicePrivacyIndicator, type VoicePrivacyIndicatorSurface } from "../src/voice-privacy-indicator.js";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };

function deferred<T>(): Deferred<T> {
  let resolveValue!: (value: T) => void;
  let rejectValue!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { resolveValue = resolve; rejectValue = reject; });
  void promise.catch(() => undefined);
  return { promise, resolve: resolveValue, reject: rejectValue };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

class FakeInput implements VoiceAssistantInput {
  readonly calls: Array<{ readonly options: VoiceAssistantInputOptions; readonly result: Deferred<{ status: "completed"; final: string } | { status: "cancelled"; reason?: string }> }> = [];
  readonly cancelIds: string[] = [];
  cancelGate: Deferred<void> | null = null;
  activeCount = 0;
  maxActiveCount = 0;

  listen(options: VoiceAssistantInputOptions): Promise<{ status: "completed"; final: string } | { status: "cancelled"; reason?: string }> {
    const result = deferred<{ status: "completed"; final: string } | { status: "cancelled"; reason?: string }>();
    this.calls.push({ options, result });
    this.activeCount += 1;
    this.maxActiveCount = Math.max(this.maxActiveCount, this.activeCount);
    result.promise.finally(() => { this.activeCount -= 1; }).catch(() => undefined);
    return result.promise;
  }

  async cancel(requestId: string): Promise<void> {
    this.cancelIds.push(requestId);
    if (this.cancelGate) await this.cancelGate.promise;
    const call = this.calls.find((candidate) => candidate.options.requestId === requestId);
    call?.result.resolve({ status: "cancelled", reason: "cancelled by test" });
  }

  partial(text: string, index = this.calls.length - 1): void { this.calls[index]?.options.onPartial?.(text); }
  finish(text: string, index = this.calls.length - 1): void { this.calls[index]?.result.resolve({ status: "completed", final: text }); }
  cancelResult(index = this.calls.length - 1): void { this.calls[index]?.result.resolve({ status: "cancelled", reason: "adapter cancelled" }); }
  reject(error: unknown, index = this.calls.length - 1): void { this.calls[index]?.result.reject(error); }
}

class FakeAssistant implements VoiceAssistantTurnAdapter {
  readonly calls: Array<{ conversationId: string; text: string; signal: AbortSignal; result: Deferred<VoiceAssistantTurnResult> }> = [];
  #listener: ((event: VoiceAssistantActivityEvent) => void) | null = null;
  clearCount = 0;

  startTurn(conversationId: string, text: string, signal: AbortSignal): Promise<VoiceAssistantTurnResult> {
    const result = deferred<VoiceAssistantTurnResult>();
    this.calls.push({ conversationId, text, signal, result });
    signal.addEventListener("abort", () => result.resolve({ status: "cancelled" }), { once: true });
    return result.promise;
  }

  subscribe(listener: (event: VoiceAssistantActivityEvent) => void): () => void {
    this.#listener = listener;
    return () => { if (this.#listener === listener) this.#listener = null; };
  }

  activity(activity: VoiceAssistantActivityEvent["activity"]): void {
    const call = this.calls.at(-1);
    if (!call) return;
    this.#listener?.({ conversationId: call.conversationId, turnId: `adapter-${this.calls.length}`, activity });
  }

  clearConversation(_conversationId: string): void { this.clearCount += 1; }
}

class FakeSynthesizer implements VoiceAssistantSynthesizer {
  readonly calls: Array<{ requestId: string; text: string; signal: AbortSignal; result: Deferred<VoiceAssistantSpeech> }> = [];

  synthesize(text: string, options: { requestId: string; signal: AbortSignal }): Promise<VoiceAssistantSpeech> {
    const result = deferred<VoiceAssistantSpeech>();
    this.calls.push({ requestId: options.requestId, text, signal: options.signal, result });
    options.signal.addEventListener("abort", () => result.resolve({ kind: "system", text: "cancelled" }), { once: true });
    return result.promise;
  }
}

class FakePlayer implements VoiceAssistantPlayer {
  readonly calls: Array<{ requestId: string; speech: VoiceAssistantSpeech; signal: AbortSignal; result: Deferred<void> }> = [];
  readonly stopIds: string[] = [];

  play(requestId: string, speech: VoiceAssistantSpeech, signal: AbortSignal): Promise<void> {
    const result = deferred<void>();
    this.calls.push({ requestId, speech, signal, result });
    signal.addEventListener("abort", () => result.resolve(undefined), { once: true });
    return result.promise;
  }

  async stop(requestId: string): Promise<void> { this.stopIds.push(requestId); }
}

function fixture() {
  const input = new FakeInput();
  const assistant = new FakeAssistant();
  const synthesizer = new FakeSynthesizer();
  const player = new FakePlayer();
  const microphoneArbiter = new VoiceMicrophoneArbiter();
  const session = new VoiceAssistantSession({ microphoneArbiter, input, assistant, synthesizer, player, conversationId: "same-conversation" });
  const sessionEvents: VoiceAssistantSessionEvent[] = [];
  session.subscribe((event) => sessionEvents.push(event));
  return { input, assistant, synthesizer, player, microphoneArbiter, session, sessionEvents };
}

function snapshots(events: readonly VoiceAssistantSessionEvent[]): VoiceAssistantSessionSnapshot[] {
  return events.filter((event): event is Extract<VoiceAssistantSessionEvent, { type: "snapshot" }> => event.type === "snapshot").map((event) => event.snapshot);
}

function distinctActivities(events: readonly VoiceAssistantSessionEvent[]): Array<string | null> {
  const values = snapshots(events).map((snapshot) => snapshot.activity);
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

// Multi-turn canonical behavior: partials are turn-local replacements and the
// assistant transcript is the terminal capability-aware Pet Assistant result.
{
  const current = fixture();
  await current.session.start();
  current.input.partial(" same ");
  current.input.partial("same");
  current.input.finish("same");
  await flush();
  current.assistant.activity("thinking");
  current.assistant.activity("acting");
  current.assistant.calls[0]!.result.resolve({ status: "completed", response: "Capability outcomes: completed=1, rejected=0, unavailable=0, indeterminate=0." });
  await flush();
  current.synthesizer.calls[0]!.result.resolve({ kind: "audio", bytes: new Uint8Array([1]), mimeType: "audio/test" });
  await flush();
  current.player.calls[0]!.result.resolve(undefined);
  await flush();
  assert.equal(current.session.snapshot().turnId, "voice-turn-2");
  assert.equal(current.session.snapshot().userTranscript, null);
  assert.equal(current.session.snapshot().assistantTranscript, null);

  current.input.partial("same");
  current.input.finish("second turn");
  await flush();
  current.assistant.calls[1]!.result.resolve({ status: "completed", response: "second answer" });
  await flush();
  current.synthesizer.calls[1]!.result.resolve({ kind: "system", text: "second answer" });
  await flush();
  current.player.calls[1]!.result.resolve(undefined);
  await flush();

  const transcripts = current.sessionEvents.filter((event): event is Extract<VoiceAssistantSessionEvent, { type: "transcript" }> => event.type === "transcript");
  assert.deepEqual(transcripts.map(({ turnId, speaker, kind, text }) => [turnId, speaker, kind, text]), [
    ["voice-turn-1", "user", "partial", "same"],
    ["voice-turn-1", "user", "final", "same"],
    ["voice-turn-1", "assistant", "final", "Capability outcomes: completed=1, rejected=0, unavailable=0, indeterminate=0."],
    ["voice-turn-2", "user", "partial", "same"],
    ["voice-turn-2", "user", "final", "second turn"],
    ["voice-turn-2", "assistant", "final", "second answer"],
  ]);
  assert.deepEqual(current.assistant.calls.map((call) => call.conversationId), ["same-conversation", "same-conversation"]);
  assert.equal(current.player.calls[1]!.speech.kind, "system");
  assert.deepEqual(distinctActivities(current.sessionEvents), ["listening", "thinking", "acting", "thinking", "speaking", "listening", "thinking", "speaking", "listening"]);
  assert.ok(current.sessionEvents.every((event) => Object.isFrozen(event)));
  await current.session.end();
  assert.equal(current.assistant.clearCount, 1);
}

// Final-only STT emits only its one nonblank final.
{
  const current = fixture();
  await current.session.start();
  assert.equal(current.session.snapshot().turnId, "voice-turn-1");
  assert.equal(current.session.snapshot().userTranscript, null);
  assert.equal(current.session.snapshot().assistantTranscript, null);
  current.input.finish("final only");
  await flush();
  assert.equal(current.session.snapshot().turnId, "voice-turn-1");
  assert.equal(current.session.snapshot().userTranscript, "final only");
  const users = current.sessionEvents.filter((event): event is Extract<VoiceAssistantSessionEvent, { type: "transcript" }> => event.type === "transcript" && event.speaker === "user");
  assert.deepEqual(users.map((event) => [event.kind, event.text]), [["final", "final only"]]);
  await current.session.end();
}

// Input, assistant, synthesis, and playback interruption all settle their
// current generation, preserve the reservation/conversation, and continue.
for (const stage of ["input", "assistant", "synthesis", "playback"] as const) {
  const current = fixture();
  await current.session.start();
  if (stage === "input") {
    await current.session.interrupt();
  } else {
    current.input.finish("interrupt me");
    await flush();
    if (stage !== "assistant") {
      current.assistant.calls[0]!.result.resolve({ status: "completed", response: "spoken response" });
      await flush();
      if (stage === "playback") {
        current.synthesizer.calls[0]!.result.resolve({ kind: "audio", bytes: new Uint8Array([1]), mimeType: "audio/test" });
        await flush();
      }
    }
    await current.session.interrupt();
  }
  assert.equal(current.session.snapshot().status, "active");
  assert.equal(current.microphoneArbiter.activeOwner, "assistant-session");
  assert.equal(current.sessionEvents.filter((event) => event.type === "interrupted").length, 1);
  assert.equal(current.sessionEvents.some((event) => event.type === "ended"), false);
  assert.equal(current.assistant.clearCount, 0);
  assert.equal(current.input.calls.length, 2);
  if (stage === "assistant") assert.equal(current.assistant.calls[0]!.signal.aborted, true);
  if (stage === "synthesis") assert.equal(current.synthesizer.calls[0]!.signal.aborted, true);
  if (stage === "playback") assert.deepEqual(current.player.stopIds, [current.player.calls[0]!.requestId]);
  if (stage === "synthesis" || stage === "playback") {
    assert.equal(current.sessionEvents.filter((event) => event.type === "interrupted").at(-1)?.turnId, "voice-turn-1");
  }
  current.input.calls[0]!.options.onPartial?.("stale completion");
  assert.equal(current.sessionEvents.some((event) => event.type === "transcript" && event.text === "stale completion"), false);
  await current.session.end();
}

// Mute is microphone-only: output continues, but host activity is cleared and
// the session becomes muted without opening a new input until unmute.
{
  const current = fixture();
  await current.session.start();
  current.input.finish("keep speaking");
  await flush();
  await current.session.mute();
  assert.equal(current.session.snapshot().activity, null);
  current.assistant.calls[0]!.result.resolve({ status: "completed", response: "still speaking" });
  await flush();
  assert.equal(current.session.snapshot().activity, null);
  current.synthesizer.calls[0]!.result.resolve({ kind: "audio", bytes: new Uint8Array([1]), mimeType: "audio/test" });
  await flush();
  assert.equal(current.session.snapshot().activity, null);
  await current.session.mute();
  assert.equal(current.session.snapshot().activity, null);
  current.player.calls[0]!.result.resolve(undefined);
  await flush();
  assert.equal(current.session.snapshot().status, "muted");
  assert.equal(current.session.snapshot().activity, null);
  assert.equal(current.input.calls.length, 1);
  await current.session.unmute();
  assert.equal(current.input.calls.length, 2);
  await current.session.end();
}

// Synthesis and request-scoped playback failures also recover to listening.
{
  const synthesisFailure = fixture();
  await synthesisFailure.session.start();
  synthesisFailure.input.finish("synthesis fails");
  await flush();
  synthesisFailure.assistant.calls[0]!.result.resolve({ status: "completed", response: "failure" });
  await flush();
  synthesisFailure.synthesizer.calls[0]!.result.reject(new Error("synthesis failed"));
  await flush();
  assert.equal(synthesisFailure.input.calls.length, 2);
  assert.ok(synthesisFailure.sessionEvents.some((event) => event.type === "error" && event.scope === "synthesis"));
  await synthesisFailure.session.end();

  const playbackFailure = fixture();
  await playbackFailure.session.start();
  playbackFailure.input.finish("playback fails");
  await flush();
  playbackFailure.assistant.calls[0]!.result.resolve({ status: "completed", response: "failure" });
  await flush();
  playbackFailure.synthesizer.calls[0]!.result.resolve({ kind: "audio", bytes: new Uint8Array([1]), mimeType: "audio/test" });
  await flush();
  playbackFailure.player.calls[0]!.result.reject(new Error("playback failed"));
  await flush();
  assert.equal(playbackFailure.input.calls.length, 2);
  assert.ok(playbackFailure.sessionEvents.some((event) => event.type === "error" && event.scope === "playback"));
  await playbackFailure.session.end();
}

// Input failure pauses once instead of hot-retrying; retry() is deliberate,
// and terminal cleanup still releases the session reservation.
{
  const current = fixture();
  await current.session.start();
  current.input.reject(new Error("input failed immediately"));
  await flush();
  assert.equal(current.input.calls.length, 1);
  assert.equal(current.session.snapshot().status, "paused");
  assert.equal(current.session.snapshot().activity, null);
  assert.match(current.session.snapshot().error?.message ?? "", /input failed immediately/);
  await current.session.retry();
  assert.equal(current.input.calls.length, 2);
  await current.session.end();
  assert.equal(current.microphoneArbiter.activeOwner, null);

  const blank = fixture();
  await blank.session.start();
  blank.input.finish("   ");
  await flush();
  assert.equal(blank.input.calls.length, 1);
  assert.equal(blank.session.snapshot().status, "paused");
  await blank.session.end();
}

// Lifecycle operations serialize behind stage cleanup. Concurrent mute,
// unmute, and end cannot overlap capture or return before cancellation.
{
  const current = fixture();
  await current.session.start();
  const gate = deferred<void>();
  current.input.cancelGate = gate;
  let endSettled = false;
  const mute = current.session.mute();
  const unmute = current.session.unmute();
  const end = current.session.end().then(() => { endSettled = true; });
  await flush();
  assert.equal(endSettled, false);
  gate.resolve(undefined);
  await Promise.all([mute, unmute, end]);
  assert.equal(current.input.maxActiveCount, 1);
  assert.equal(current.microphoneArbiter.activeOwner, null);
  assert.equal(current.sessionEvents.filter((event) => event.type === "ended").length, 1);
  await Promise.all([current.session.end(), current.session.shutdown()]);
  assert.equal(current.sessionEvents.filter((event) => event.type === "ended").length, 1);
}

// End, repeated end, and shutdown all wait for the one in-flight cleanup.
{
  const current = fixture();
  await current.session.start();
  const gate = deferred<void>();
  current.input.cancelGate = gate;
  let firstSettled = false;
  let secondSettled = false;
  let shutdownSettled = false;
  const first = current.session.end().then(() => { firstSettled = true; });
  const second = current.session.end().then(() => { secondSettled = true; });
  const shutdown = current.session.shutdown().then(() => { shutdownSettled = true; });
  await flush();
  assert.deepEqual([firstSettled, secondSettled, shutdownSettled], [false, false, false]);
  gate.resolve(undefined);
  await Promise.all([first, second, shutdown]);
  assert.equal(current.microphoneArbiter.activeOwner, null);
  assert.equal(current.sessionEvents.filter((event) => event.type === "ended").length, 1);
}

// Adapter cancellation and failed turns recover to a fresh listening stage.
{
  const current = fixture();
  await current.session.start();
  current.input.cancelResult();
  await flush();
  assert.equal(current.input.calls.length, 1);
  assert.equal(current.session.snapshot().status, "paused");
  await current.session.retry();
  assert.equal(current.input.calls.length, 2);
  current.input.finish("cancelled turn");
  await flush();
  current.assistant.calls[0]!.result.resolve({ status: "cancelled" });
  await flush();
  assert.equal(current.input.calls.length, 3);
  current.input.finish("failed turn");
  await flush();
  current.assistant.calls[1]!.result.resolve({ status: "failed", error: "failed deterministically" });
  await flush();
  assert.equal(current.input.calls.length, 4);
  assert.ok(current.sessionEvents.some((event) => event.type === "error" && event.scope === "assistant"));
  await current.session.end();
}

class FakeSurface implements VoicePrivacyIndicatorSurface {
  showCount = 0;
  hideCount = 0;
  destroyCount = 0;
  show(): void { this.showCount += 1; }
  hide(): void { this.hideCount += 1; }
  destroy(): void { this.destroyCount += 1; }
}

class ImmediateRecording implements VoiceCaptureRecording {
  readonly result: Promise<VoiceCaptureResult>;
  #reject!: (error: unknown) => void;
  constructor() {
    this.result = new Promise<VoiceCaptureResult>((_resolve, reject) => { this.#reject = reject; });
    void this.result.catch(() => undefined);
  }
  async stop(): Promise<VoiceCaptureResult> { return { bytes: new Uint8Array(128), mimeType: "audio/webm" }; }
  async cancel(): Promise<void> { this.#reject(new Error("capture cancelled")); }
  async close(): Promise<void> {}
}

class ImmediateAttempt implements VoiceCaptureAttempt {
  readonly recording = new ImmediateRecording();
  readonly #onAcquired: () => boolean;
  constructor(onAcquired: () => boolean) { this.#onAcquired = onAcquired; }
  async acquire(): Promise<VoiceCaptureRecording> { if (!this.#onAcquired()) throw new Error("capture cancelled"); return this.recording; }
  async cancel(): Promise<void> { await this.recording.cancel(); }
  async dispose(): Promise<void> {}
}

// The real capture seam acquires one child track, drives privacy from that
// actual track, rejects a second child, and leaves shared indicator teardown to
// the host rather than VoiceCaptureService.shutdown().
{
  const surface = new FakeSurface();
  const indicator = new VoicePrivacyIndicator(() => surface);
  const arbiter = new VoiceMicrophoneArbiter();
  const reservation: VoiceMicrophoneReservation = arbiter.reserve("assistant-session");
  const capture = new VoiceCaptureService((_duration, onAcquired) => new ImmediateAttempt(onAcquired), indicator, { microphoneArbiter: arbiter });
  const second = new VoiceCaptureService((_duration, onAcquired) => new ImmediateAttempt(onAcquired), indicator, { microphoneArbiter: arbiter });
  const handle = await capture.start(1_000, reservation);
  assert.equal(surface.showCount, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(reservation, "release"), false);
  await assert.rejects(() => second.start(1_000, reservation), /already has an active track/);
  await handle.cancel("test cleanup");
  assert.equal(surface.hideCount, 1);
  await capture.shutdown();
  assert.equal(surface.destroyCount, 0);
  arbiter.releaseReservation(reservation);
  assert.equal(arbiter.activeOwner, null);
}

console.log("Composable voice assistant session behavior verified.");
