import type { VoicePrivacyIndicator } from "./voice-privacy-indicator.js";

export const VOICE_ACQUISITION_TIMEOUT_MS = 15_000;
export const VOICE_MIN_RECORDING_DURATION_MS = 1_000;
export const VOICE_MAX_RECORDING_DURATION_MS = 30_000;
export const VOICE_MIN_AUDIO_BYTES = 128;
export const VOICE_MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export type VoiceCaptureResult = {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
};

export interface VoiceCaptureRecording {
  readonly result: Promise<VoiceCaptureResult>;
  stop(): Promise<VoiceCaptureResult>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface VoiceCaptureAttempt {
  acquire(): Promise<VoiceCaptureRecording>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export type VoiceCaptureFactory = (durationMs: number, onAcquired: () => boolean) => VoiceCaptureAttempt;

export class VoiceCaptureCancelledError extends Error {
  constructor(message = "Voice capture was cancelled.") {
    super(message);
    this.name = "VoiceCaptureCancelledError";
  }
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

type ActiveCapture = {
  attempt: VoiceCaptureAttempt;
  readonly result: Deferred<VoiceCaptureResult>;
  readonly done: Deferred<void>;
  readonly rejectCancel: (error: unknown) => void;
  readonly cancelPromise: Promise<never>;
  recording?: VoiceCaptureRecording;
  indicatorLive: boolean;
  cancelled: boolean;
  cancelError: Error | null;
  acquisitionTimer: NodeJS.Timeout | null;
  recordingTimer: NodeJS.Timeout | null;
  finishing: Promise<VoiceCaptureResult> | null;
  cleaned: boolean;
};

export type VoiceCaptureServiceOptions = {
  readonly acquisitionTimeoutMs?: number;
};

export class VoiceCaptureService {
  readonly #factory: VoiceCaptureFactory;
  readonly #indicator: VoicePrivacyIndicator;
  readonly #acquisitionTimeoutMs: number;
  #active: ActiveCapture | null = null;

  constructor(factory: VoiceCaptureFactory, indicator: VoicePrivacyIndicator, options: VoiceCaptureServiceOptions = {}) {
    this.#factory = factory;
    this.#indicator = indicator;
    this.#acquisitionTimeoutMs = options.acquisitionTimeoutMs ?? VOICE_ACQUISITION_TIMEOUT_MS;
  }

  async start(timeoutMs: number): Promise<{
    readonly result: Promise<VoiceCaptureResult>;
    stop(): Promise<VoiceCaptureResult>;
    cancel(reason?: string): Promise<void>;
  }> {
    if (this.#active) throw new Error("A voice capture is already in progress.");

    const durationMs = normalizeRecordingDuration(timeoutMs);
    const result = deferred<VoiceCaptureResult>();
    const done = deferred<void>();
    let rejectCancel!: (error: unknown) => void;
    const cancelPromise = new Promise<never>((_resolve, reject) => { rejectCancel = reject; });
    const active: ActiveCapture = {
      attempt: undefined as unknown as VoiceCaptureAttempt,
      result,
      done,
      rejectCancel,
      cancelPromise,
      indicatorLive: false,
      cancelled: false,
      cancelError: null,
      acquisitionTimer: null,
      recordingTimer: null,
      finishing: null,
      cleaned: false,
    };

    try {
      active.attempt = this.#factory(durationMs, () => {
        if (active.cancelled || this.#active !== active) return false;
        active.indicatorLive = true;
        this.#indicator.trackStarted();
        return true;
      });
    } catch (error) {
      done.resolve(undefined);
      throw normalizeError(error);
    }
    this.#active = active;
    // The promise is intentionally kept rejected on failed acquisition, so make
    // its rejection observed even when no capture handle reaches the caller.
    void result.promise.catch(() => undefined);

    const acquisition = Promise.resolve().then(() => active.attempt.acquire());
    void acquisition.then((recording) => {
      if (active.cancelled || this.#active !== active) {
        void recording.cancel().catch(() => undefined);
        void recording.close().catch(() => undefined);
      }
    }).catch(() => undefined);

    try {
      active.acquisitionTimer = setTimeout(() => {
        this.#requestCancel(active, new Error("Microphone acquisition timed out."));
      }, this.#acquisitionTimeoutMs);

      const recording = await Promise.race([acquisition, active.cancelPromise]);
      if (active.cancelled) throw active.cancelError ?? new VoiceCaptureCancelledError();
      if (active.acquisitionTimer) clearTimeout(active.acquisitionTimer);
      active.acquisitionTimer = null;
      active.recording = recording;
      active.recordingTimer = setTimeout(() => {
        this.#requestCancel(active, new Error("Voice recording timed out."));
        void this.#finish(active, { kind: "cancel" }).catch(() => undefined);
      }, durationMs + 1_000);
      active.recordingTimer.unref?.();

      void recording.result.then(
        (capture) => { void this.#finish(active, { kind: "result", capture }).catch(() => undefined); },
        (error: unknown) => { void this.#finish(active, { kind: "error", error }).catch(() => undefined); },
      );

      return {
        result: result.promise,
        stop: () => this.#finish(active, { kind: "stop" }),
        cancel: (reason = "Voice capture was cancelled.") => this.#cancelHandle(active, reason),
      };
    } catch (error) {
      await this.#cleanup(active);
      throw normalizeError(error);
    }
  }

  async captureOneShot(timeoutMs: number): Promise<VoiceCaptureResult> {
    const handle = await this.start(timeoutMs);
    return handle.result;
  }

  async cancelActive(reason = "Voice capture was cancelled."): Promise<void> {
    const active = this.#active;
    if (!active) return;
    this.#requestCancel(active, new VoiceCaptureCancelledError(reason));
    if (active.recording) void this.#finish(active, { kind: "cancel" }).catch(() => undefined);
    await active.done.promise;
  }

  async shutdown(): Promise<void> {
    await this.cancelActive("OpenPets is shutting down.");
    this.#indicator.shutdown();
  }

  #requestCancel(active: ActiveCapture, error: Error): void {
    if (active.cancelled) return;
    active.cancelled = true;
    active.cancelError = error;
    active.rejectCancel(error);
    if (!active.recording) void active.attempt.cancel().catch(() => undefined);
  }

  async #cancelHandle(active: ActiveCapture, reason: string): Promise<void> {
    this.#requestCancel(active, new VoiceCaptureCancelledError(reason));
    if (active.recording) void this.#finish(active, { kind: "cancel" }).catch(() => undefined);
    await active.done.promise;
  }

  #finish(active: ActiveCapture, outcome: { kind: "result"; capture: VoiceCaptureResult } | { kind: "error"; error: unknown } | { kind: "stop" } | { kind: "cancel" }): Promise<VoiceCaptureResult> {
    if (active.finishing) return active.finishing;
    active.finishing = (async () => {
      let capture: VoiceCaptureResult | undefined;
      let failure: Error | undefined;
      try {
        if (active.cancelled || outcome.kind === "cancel") {
          await active.recording?.cancel().catch(() => undefined);
          throw active.cancelError ?? new VoiceCaptureCancelledError();
        }
        if (outcome.kind === "error") throw normalizeError(outcome.error);
        capture = outcome.kind === "result" || outcome.kind === "stop"
          ? outcome.kind === "result" ? outcome.capture : await active.recording!.stop()
          : undefined;
        if (!capture) throw new Error("Voice capture produced no audio.");
        if (active.cancelled) throw active.cancelError ?? new VoiceCaptureCancelledError();
      } catch (error) {
        failure = normalizeError(error);
      }
      await this.#cleanup(active);
      if (failure) {
        active.result.reject(failure);
        throw failure;
      }
      if (!capture) {
        const missing = new Error("Voice capture produced no audio.");
        active.result.reject(missing);
        throw missing;
      }
      active.result.resolve(capture);
      return capture;
    })();
    return active.finishing;
  }

  async #cleanup(active: ActiveCapture): Promise<void> {
    if (active.cleaned) return active.done.promise;
    active.cleaned = true;
    if (active.acquisitionTimer) clearTimeout(active.acquisitionTimer);
    active.acquisitionTimer = null;
    if (active.recordingTimer) clearTimeout(active.recordingTimer);
    active.recordingTimer = null;
    try {
      await active.recording?.close().catch(() => undefined);
      await active.attempt.cancel().catch(() => undefined);
      await active.attempt.dispose().catch(() => undefined);
    } finally {
      if (active.indicatorLive) {
        active.indicatorLive = false;
        this.#indicator.trackStopped();
      }
      if (this.#active === active) this.#active = null;
      active.done.resolve(undefined);
    }
  }
}

export function normalizeRecordingDuration(timeoutMs: number): number {
  return Math.min(VOICE_MAX_RECORDING_DURATION_MS, Math.max(VOICE_MIN_RECORDING_DURATION_MS, Math.round(timeoutMs)));
}

function deferred<T>(): Deferred<T> {
  let resolveValue!: (value: T) => void;
  let rejectValue!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { resolveValue = resolve; rejectValue = reject; });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
