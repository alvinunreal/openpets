import type { VoiceCaptureResult, VoiceCaptureService } from "./voice-capture.js";

export const VOICE_TRANSCRIPTION_TIMEOUT_MS = 30_000;
export const VOICE_EMPTY_TRANSCRIPT_ERROR = "Voice transcription returned no text.";
export const VOICE_TRANSCRIPTION_TIMEOUT_ERROR = "Voice transcription timed out. Try again.";
export const VOICE_TRANSCRIPTION_CANCELLED_ERROR = "Voice transcription was cancelled.";
export const VOICE_CAPTURE_CANCELLED_ERROR = "Voice capture was cancelled.";

export type VoiceTranscriber = (capture: VoiceCaptureResult, signal: AbortSignal) => Promise<string>;
export type VoiceListeningPhase = "acquiring" | "recording" | "transcribing";

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

type ActiveListen = {
  readonly done: Deferred<void>;
  readonly rejectCancel: (error: unknown) => void;
  readonly cancelPromise: Promise<never>;
  capturePhase: "acquisition" | "recording" | "transcription";
  cancelled: boolean;
  cancelError: Error | null;
  transcriptionController: AbortController | null;
  transcriptionTimedOut: boolean;
};

export type VoiceListeningServiceOptions = {
  readonly transcriptionTimeoutMs?: number;
  readonly onPhaseChange?: (phase: VoiceListeningPhase) => void;
};

export class VoiceListeningService {
  readonly #capture: VoiceCaptureService;
  readonly #transcriber: VoiceTranscriber;
  readonly #transcriptionTimeoutMs: number;
  readonly #onPhaseChange?: (phase: VoiceListeningPhase) => void;
  #active: ActiveListen | null = null;

  constructor(capture: VoiceCaptureService, transcriber: VoiceTranscriber, options: VoiceListeningServiceOptions = {}) {
    this.#capture = capture;
    this.#transcriber = transcriber;
    this.#transcriptionTimeoutMs = options.transcriptionTimeoutMs ?? VOICE_TRANSCRIPTION_TIMEOUT_MS;
    this.#onPhaseChange = options.onPhaseChange;
  }

  listenOnce(recordingDurationMs: number): Promise<{ text: string }> {
    if (this.#active) throw new Error("A voice capture is already in progress.");
    const done = deferred<void>();
    let rejectCancel!: (error: unknown) => void;
    const cancelPromise = new Promise<never>((_resolve, reject) => { rejectCancel = reject; });
    const active: ActiveListen = {
      done,
      rejectCancel,
      cancelPromise,
      capturePhase: "acquisition" as const,
      cancelled: false,
      cancelError: null,
      transcriptionController: null,
      transcriptionTimedOut: false,
    };
    this.#active = active;
    this.#onPhaseChange?.("acquiring");
    const run = this.#run(active, recordingDurationMs).finally(async () => {
      await this.#capture.cancelActive(active.cancelError?.message ?? "Voice listening finished.").catch(() => undefined);
      if (this.#active === active) this.#active = null;
      active.done.resolve(undefined);
    });
    return run;
  }

  async cancel(reason = VOICE_CAPTURE_CANCELLED_ERROR): Promise<void> {
    const active = this.#active;
    if (!active) return;
    if (!active.cancelled) {
      active.cancelled = true;
      active.cancelError = new Error(active.capturePhase === "transcription" ? VOICE_TRANSCRIPTION_CANCELLED_ERROR : reason);
      active.rejectCancel(active.cancelError);
      active.transcriptionController?.abort();
    }
    await this.#capture.cancelActive(reason).catch(() => undefined);
    await active.done.promise;
  }

  async shutdown(): Promise<void> {
    await this.cancel("OpenPets is shutting down.");
    await this.#capture.shutdown();
  }

  async #run(active: ActiveListen, recordingDurationMs: number): Promise<{ text: string }> {
    try {
      const startPromise = this.#capture.start(recordingDurationMs);
      void startPromise.catch(() => undefined);
      const handle = await Promise.race([startPromise, active.cancelPromise]);
      active.capturePhase = "recording";
      this.#onPhaseChange?.("recording");
      const capturePromise = handle.result;
      void capturePromise.catch(() => undefined);
      const capture = await Promise.race([capturePromise, active.cancelPromise]);

      active.capturePhase = "transcription";
      this.#onPhaseChange?.("transcribing");
      const controller = new AbortController();
      active.transcriptionController = controller;
      let timeout: NodeJS.Timeout | null = null;
      const transcriptionPromise = Promise.resolve().then(() => this.#transcriber(capture, controller.signal));
      void transcriptionPromise.catch(() => undefined);
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          active.transcriptionTimedOut = true;
          controller.abort();
          reject(new Error(VOICE_TRANSCRIPTION_TIMEOUT_ERROR));
        }, this.#transcriptionTimeoutMs);
      });
      try {
        const raw = await Promise.race([transcriptionPromise, active.cancelPromise, timeoutPromise]);
        if (active.cancelled) throw active.cancelError ?? new Error(VOICE_TRANSCRIPTION_CANCELLED_ERROR);
        if (controller.signal.aborted) throw new Error(VOICE_TRANSCRIPTION_TIMEOUT_ERROR);
        const text = raw.trim();
        if (!text) throw new Error(VOICE_EMPTY_TRANSCRIPT_ERROR);
        return { text };
      } finally {
        if (timeout) clearTimeout(timeout);
        active.transcriptionController = null;
      }
    } catch (error) {
      if (active.cancelled) throw active.cancelError ?? new Error(VOICE_CAPTURE_CANCELLED_ERROR);
      if (active.transcriptionTimedOut) throw new Error(VOICE_TRANSCRIPTION_TIMEOUT_ERROR);
      if (isAbortError(error)) throw new Error(VOICE_TRANSCRIPTION_CANCELLED_ERROR);
      throw normalizeError(error);
    }
  }
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
