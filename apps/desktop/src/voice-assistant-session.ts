import type { VoiceMicrophoneArbiter, VoiceMicrophoneReservation } from "./voice-microphone-arbiter.js";

export type VoiceAssistantActivity = "listening" | "thinking" | "acting" | "speaking";
export type VoiceAssistantSessionStatus = "idle" | "active" | "muted" | "paused" | "ending" | "ended";
export type VoiceAssistantErrorScope = "input" | "assistant" | "synthesis" | "playback" | "session";

export type VoiceAssistantSessionSnapshot = {
  readonly status: VoiceAssistantSessionStatus;
  readonly activity: VoiceAssistantActivity | null;
  readonly muted: boolean;
  readonly conversationId: string;
  readonly generation: number;
  readonly turnId: string | null;
  readonly userTranscript: string | null;
  readonly assistantTranscript: string | null;
  readonly interruptionCount: number;
  readonly error: { readonly scope: VoiceAssistantErrorScope; readonly message: string } | null;
};

export type VoiceAssistantTranscriptEvent = {
  readonly type: "transcript";
  readonly sequence: number;
  readonly turnId: string;
  readonly speaker: "user" | "assistant";
  readonly kind: "partial" | "final";
  readonly text: string;
};

export type VoiceAssistantSessionEvent =
  | { readonly type: "snapshot"; readonly sequence: number; readonly snapshot: VoiceAssistantSessionSnapshot }
  | VoiceAssistantTranscriptEvent
  | { readonly type: "error"; readonly sequence: number; readonly scope: VoiceAssistantErrorScope; readonly message: string }
  | { readonly type: "interrupted"; readonly sequence: number; readonly generation: number; readonly turnId: string | null }
  | { readonly type: "ended"; readonly sequence: number; readonly reason: "ended" | "shutdown" };

type VoiceAssistantSessionEventInput =
  | { readonly type: "snapshot"; readonly snapshot: VoiceAssistantSessionSnapshot }
  | Omit<VoiceAssistantTranscriptEvent, "sequence">
  | { readonly type: "error"; readonly scope: VoiceAssistantErrorScope; readonly message: string }
  | { readonly type: "interrupted"; readonly generation: number; readonly turnId: string | null }
  | { readonly type: "ended"; readonly reason: "ended" | "shutdown" };

export type VoiceAssistantSessionListener = (event: VoiceAssistantSessionEvent) => void;

export type VoiceAssistantInputResult =
  | { readonly status: "completed"; readonly final: string }
  | { readonly status: "cancelled"; readonly reason?: string };

export type VoiceAssistantInputOptions = {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly reservation: VoiceMicrophoneReservation;
  readonly onPartial?: (text: string) => void;
};

/** One bounded capture/transcription attempt. cancel(requestId) settles that attempt. */
export interface VoiceAssistantInput {
  listen(options: VoiceAssistantInputOptions): Promise<VoiceAssistantInputResult>;
  cancel(requestId: string): Promise<void>;
}

export type VoiceAssistantTurnResult = {
  readonly status: "completed" | "cancelled" | "failed";
  /** The terminal response after all capability outcomes have been applied. */
  readonly response?: string;
  readonly error?: string;
};

export type VoiceAssistantActivityEvent = {
  readonly conversationId: string;
  readonly turnId: string;
  readonly activity: "thinking" | "acting" | "responding";
};

export interface VoiceAssistantTurnAdapter {
  startTurn(conversationId: string, text: string, signal: AbortSignal): Promise<VoiceAssistantTurnResult>;
  subscribe(listener: (event: VoiceAssistantActivityEvent) => void): () => void;
  clearConversation(conversationId: string): void | Promise<void>;
}

export type VoiceAssistantSpeech =
  | { readonly kind: "audio"; readonly bytes: Uint8Array; readonly mimeType: string }
  | { readonly kind: "system"; readonly text: string };
export type VoiceAssistantSynthesisOptions = { readonly requestId: string; readonly signal: AbortSignal };

export interface VoiceAssistantSynthesizer {
  synthesize(text: string, options: VoiceAssistantSynthesisOptions): Promise<VoiceAssistantSpeech>;
}

/** The player owns both decoded audio and eventual system speech, per request. */
export interface VoiceAssistantPlayer {
  play(requestId: string, speech: VoiceAssistantSpeech, signal: AbortSignal): Promise<void>;
  stop(requestId: string): Promise<void>;
}

export type VoiceAssistantSessionOptions = {
  readonly conversationId?: string;
  readonly microphoneArbiter: VoiceMicrophoneArbiter;
  readonly input: VoiceAssistantInput;
  readonly assistant: VoiceAssistantTurnAdapter;
  readonly synthesizer: VoiceAssistantSynthesizer;
  readonly player: VoiceAssistantPlayer;
};

type InputStage = {
  readonly generation: number;
  readonly requestId: string;
  readonly turnId: string;
  readonly controller: AbortController;
  promise: Promise<void>;
  cancelPromise: Promise<void> | null;
  lastPartial: string | null;
};

type TurnStage = {
  readonly generation: number;
  readonly turnId: string;
  readonly controller: AbortController;
  promise: Promise<VoiceAssistantTurnResult>;
  unsubscribe: (() => void) | null;
};

type SpeechStage = {
  readonly generation: number;
  readonly requestId: string;
  readonly turnId: string;
  readonly controller: AbortController;
  synthesis: Promise<VoiceAssistantSpeech>;
  playback: Promise<void> | null;
};

const DEFAULT_CONVERSATION_ID = "voice-assistant";

/** Host-private batch voice session. No provider wire event crosses this boundary. */
export class VoiceAssistantSession {
  readonly #options: VoiceAssistantSessionOptions;
  readonly #conversationId: string;
  readonly #listeners = new Set<VoiceAssistantSessionListener>();
  #microphoneReservation: VoiceMicrophoneReservation | null = null;
  #input: InputStage | null = null;
  #turn: TurnStage | null = null;
  #speech: SpeechStage | null = null;
  #ending: Promise<void> | null = null;
  #lifecycleTail: Promise<void> = Promise.resolve();
  #snapshot: VoiceAssistantSessionSnapshot;
  #sequence = 1;
  #generation = 0;
  #started = false;
  #ended = false;
  #muted = false;
  #nextRequest = 1;
  #nextTurnOrdinal = 0;

  constructor(options: VoiceAssistantSessionOptions) {
    this.#options = options;
    this.#conversationId = normalizeConversationId(options.conversationId ?? DEFAULT_CONVERSATION_ID);
    this.#snapshot = freeze({
      status: "idle",
      activity: null,
      muted: false,
      conversationId: this.#conversationId,
      generation: 0,
      turnId: null,
      userTranscript: null,
      assistantTranscript: null,
      interruptionCount: 0,
      error: null,
    });
  }

  snapshot(): VoiceAssistantSessionSnapshot { return this.#snapshot; }

  subscribe(listener: VoiceAssistantSessionListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  start(): Promise<void> { return this.#serialize(() => this.#start()); }
  retry(): Promise<void> { return this.#serialize(() => this.#retry()); }
  mute(): Promise<void> { return this.#serialize(() => this.#mute()); }
  unmute(): Promise<void> { return this.#serialize(() => this.#unmute()); }
  interrupt(): Promise<void> { return this.#serialize(() => this.#interrupt()); }
  end(): Promise<void> { return this.#serialize(() => this.#end("ended")); }
  shutdown(): Promise<void> { return this.#serialize(() => this.#end("shutdown")); }

  async #start(): Promise<void> {
    if (this.#ended) throw new Error("Voice assistant session has ended.");
    if (this.#started) return;
    this.#microphoneReservation = this.#options.microphoneArbiter.reserve("assistant-session");
    this.#started = true;
    this.#setSnapshot({ status: "active", activity: "listening", muted: false, error: null });
    this.#beginListen();
    await Promise.resolve();
  }

  async #retry(): Promise<void> {
    if (!this.#started) throw new Error("Voice assistant session has not started.");
    if (this.#ended || this.#muted || this.#snapshot.status !== "paused") return;
    this.#setSnapshot({ status: "active", activity: "listening", error: null });
    this.#beginListen();
    await Promise.resolve();
  }

  async #mute(): Promise<void> {
    if (!this.#started) throw new Error("Voice assistant session has not started.");
    if (this.#ended || this.#muted) return;
    this.#muted = true;
    this.#setSnapshot({ muted: true, status: "muted", activity: null });
    const input = this.#input;
    if (input) {
      ++this.#generation;
      await this.#cancelInput(input);
      this.#input = null;
    }
    if (!this.#turn && !this.#speech) this.#setSnapshot({ activity: null });
  }

  async #unmute(): Promise<void> {
    if (!this.#started) throw new Error("Voice assistant session has not started.");
    if (this.#ended || !this.#muted) return;
    this.#muted = false;
    this.#setSnapshot({ muted: false, status: "active" });
    if (!this.#input && !this.#turn && !this.#speech) this.#beginListen();
    await Promise.resolve();
  }

  async #interrupt(): Promise<void> {
    if (!this.#started || this.#ended) return;
    const input = this.#input;
    const turn = this.#turn;
    const speech = this.#speech;
    ++this.#generation;
    const turnId = input?.turnId ?? turn?.turnId ?? speech?.turnId ?? null;
    this.#setSnapshot({ status: this.#muted ? "muted" : "active", activity: null, interruptionCount: this.#snapshot.interruptionCount + 1 });
    this.#emit({ type: "interrupted", generation: this.#generation, turnId });
    await this.#cancelStages(input, turn, speech);
    this.#input = null;
    this.#turn = null;
    this.#speech = null;
    if (this.#muted) this.#setSnapshot({ status: "muted", activity: null });
    else {
      this.#setSnapshot({ status: "active", activity: "listening" });
      this.#beginListen();
    }
  }

  #beginListen(): void {
    if (this.#ended || !this.#started || !this.#microphoneReservation || this.#muted || this.#input || this.#turn || this.#speech) return;
    const generation = ++this.#generation;
    const ordinal = ++this.#nextTurnOrdinal;
    const turnId = `voice-turn-${ordinal}`;
    const requestId = `voice-input-${this.#nextRequest++}`;
    const controller = new AbortController();
    this.#setSnapshot({ status: "active", activity: "listening", turnId, userTranscript: null, assistantTranscript: null, error: null });
    const stage: InputStage = { generation, requestId, turnId, controller, promise: Promise.resolve(), cancelPromise: null, lastPartial: null };
    const promise = Promise.resolve().then(() => this.#options.input.listen({
      requestId,
      signal: controller.signal,
      reservation: this.#microphoneReservation!,
      onPartial: (value) => {
        if (!this.#isCurrentInput(stage)) return;
        const text = normalizeTranscript(value);
        if (!text || text === stage.lastPartial) return;
        stage.lastPartial = text;
        this.#setSnapshot({ activity: "listening", turnId, userTranscript: text, error: null });
        this.#emit({ type: "transcript", turnId, speaker: "user", kind: "partial", text });
      },
    })).then((result) => {
      if (!this.#isCurrentInput(stage)) return;
      this.#finishInput(stage);
      if (result.status === "cancelled") {
        this.#pauseInput(result.reason ?? "Voice input was cancelled.");
        return;
      }
      const text = normalizeTranscript(result.final);
      if (!text) {
        this.#pauseInput("Voice input returned no text.");
        return;
      }
      this.#setSnapshot({ userTranscript: text, activity: "thinking", error: null });
      this.#emit({ type: "transcript", turnId, speaker: "user", kind: "final", text });
      this.#beginTurn(turnId, text);
    }).catch((error: unknown) => {
      if (!this.#isCurrentInput(stage)) return;
      this.#finishInput(stage);
      this.#pauseInput(errorMessage(error));
    });
    stage.promise = promise;
    this.#input = stage;
  }

  #beginTurn(turnId: string, text: string): void {
    if (this.#ended || this.#muted || this.#turn) return;
    const generation = ++this.#generation;
    const controller = new AbortController();
    const stage: TurnStage = { generation, turnId, controller, promise: Promise.resolve(undefined as never), unsubscribe: null };
    this.#turn = stage;
    try {
      stage.unsubscribe = this.#options.assistant.subscribe((event) => {
        if (!this.#isCurrentTurn(stage) || event.conversationId !== this.#conversationId) return;
        this.#setSnapshot({ activity: this.#muted ? null : event.activity === "acting" ? "acting" : "thinking", error: null });
      });
    } catch (error) {
      this.#finishTurn(stage);
      this.#emitError("assistant", errorMessage(error));
      this.#resumeAfterTurn();
      return;
    }
    stage.promise = Promise.resolve().then(() => this.#options.assistant.startTurn(this.#conversationId, text, controller.signal));
    void stage.promise.then((result) => {
      if (!this.#isCurrentTurn(stage)) return;
      this.#finishTurn(stage);
      if (result.status === "cancelled") {
        this.#resumeAfterTurn();
        return;
      }
      if (result.status === "failed") {
        this.#emitError("assistant", result.error ?? "Pet Assistant turn failed.");
        this.#resumeAfterTurn();
        return;
      }
      const response = normalizeTranscript(result.response ?? "");
      if (!response) {
        this.#emitError("assistant", "Pet Assistant returned no response.");
        this.#resumeAfterTurn();
        return;
      }
      this.#setSnapshot({ assistantTranscript: response, activity: this.#muted ? null : "thinking", error: null });
      this.#emit({ type: "transcript", turnId, speaker: "assistant", kind: "final", text: response });
      this.#beginSpeech(turnId, response);
    }, (error: unknown) => {
      if (!this.#isCurrentTurn(stage)) return;
      this.#finishTurn(stage);
      this.#emitError("assistant", errorMessage(error));
      this.#resumeAfterTurn();
    });
  }

  #beginSpeech(turnId: string, text: string): void {
    if (this.#ended) return;
    const generation = ++this.#generation;
    const requestId = `voice-output-${this.#nextRequest++}`;
    const controller = new AbortController();
    const stage: SpeechStage = { generation, requestId, turnId, controller, synthesis: Promise.resolve(undefined as never), playback: null };
    stage.synthesis = Promise.resolve().then(() => this.#options.synthesizer.synthesize(text, { requestId, signal: controller.signal }));
    this.#speech = stage;
    void stage.synthesis.then((speech) => {
      if (!this.#isCurrentSpeech(stage)) return;
      this.#setSnapshot({ activity: this.#muted ? null : "speaking", error: null });
      stage.playback = Promise.resolve().then(() => this.#options.player.play(requestId, speech, controller.signal));
      void stage.playback.then(() => {
        if (!this.#isCurrentSpeech(stage)) return;
        this.#finishSpeech(stage);
        this.#resumeAfterTurn();
      }, (error: unknown) => {
        if (!this.#isCurrentSpeech(stage)) return;
        this.#finishSpeech(stage);
        this.#emitError("playback", errorMessage(error));
        this.#resumeAfterTurn();
      });
    }, (error: unknown) => {
      if (!this.#isCurrentSpeech(stage)) return;
      this.#finishSpeech(stage);
      this.#emitError("synthesis", errorMessage(error));
      this.#resumeAfterTurn();
    });
  }

  #resumeAfterTurn(): void {
    if (this.#ended || this.#muted) {
      if (!this.#ended) this.#setSnapshot({ status: "muted", activity: null });
      return;
    }
    this.#setSnapshot({ status: "active", activity: "listening" });
    this.#beginListen();
  }

  #pauseInput(message: string): void {
    const normalized = message.trim() || "Voice input failed.";
    this.#setSnapshot({ status: "paused", activity: null, error: { scope: "input", message: normalized } });
    this.#emit({ type: "error", scope: "input", message: normalized });
  }

  async #end(reason: "ended" | "shutdown"): Promise<void> {
    if (this.#ended) return;
    if (this.#ending) return this.#ending;
    this.#ending = this.#finishEnd(reason);
    await this.#ending;
  }

  async #finishEnd(reason: "ended" | "shutdown"): Promise<void> {
    this.#ended = true;
    ++this.#generation;
    this.#setSnapshot({ status: "ending", activity: null });
    const turn = this.#turn;
    await this.#cancelStages(this.#input, turn, this.#speech);
    if (turn) {
      turn.unsubscribe?.();
      turn.unsubscribe = null;
    }
    try {
      await this.#options.assistant.clearConversation(this.#conversationId);
    } catch (error) {
      this.#emitError("session", errorMessage(error));
    }
    if (this.#microphoneReservation) {
      this.#options.microphoneArbiter.releaseReservation(this.#microphoneReservation);
      this.#microphoneReservation = null;
    }
    this.#input = null;
    this.#turn = null;
    this.#speech = null;
    this.#setSnapshot({ status: "ended", activity: null });
    this.#emit({ type: "ended", reason });
  }

  async #cancelStages(input: InputStage | null, turn: TurnStage | null, speech: SpeechStage | null): Promise<void> {
    const pending: Promise<unknown>[] = [];
    if (input) pending.push(this.#cancelInput(input));
    if (turn) {
      turn.controller.abort();
      pending.push(turn.promise.catch(() => undefined));
    }
    if (speech) {
      speech.controller.abort();
      pending.push(Promise.resolve().then(() => this.#options.player.stop(speech.requestId)).catch(() => undefined));
      pending.push(speech.synthesis.catch(() => undefined));
      if (speech.playback) pending.push(speech.playback.catch(() => undefined));
    }
    await Promise.all(pending);
  }

  async #cancelInput(stage: InputStage): Promise<void> {
    stage.controller.abort();
    if (!stage.cancelPromise) stage.cancelPromise = Promise.resolve().then(() => this.#options.input.cancel(stage.requestId)).catch(() => undefined);
    await Promise.all([stage.cancelPromise, stage.promise.catch(() => undefined)]);
  }

  #finishInput(stage: InputStage): void { if (this.#input === stage) this.#input = null; }
  #finishTurn(stage: TurnStage): void { stage.unsubscribe?.(); stage.unsubscribe = null; if (this.#turn === stage) this.#turn = null; }
  #finishSpeech(stage: SpeechStage): void { if (this.#speech === stage) this.#speech = null; }

  #isCurrentInput(stage: InputStage): boolean { return this.#input === stage && !this.#ended && this.#generation === stage.generation; }
  #isCurrentTurn(stage: TurnStage): boolean { return this.#turn === stage && !this.#ended && this.#generation === stage.generation; }
  #isCurrentSpeech(stage: SpeechStage): boolean { return this.#speech === stage && !this.#ended && this.#generation === stage.generation; }

  #serialize<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.#lifecycleTail.then(operation, operation);
    this.#lifecycleTail = next.then(() => undefined, () => undefined);
    return next;
  }

  #setSnapshot(patch: Partial<VoiceAssistantSessionSnapshot>): void {
    this.#snapshot = freeze({ ...this.#snapshot, ...patch, generation: this.#generation });
    this.#emit({ type: "snapshot", snapshot: this.#snapshot });
  }

  #emitError(scope: VoiceAssistantErrorScope, message: string): void {
    const normalized = message.trim() || "Voice assistant operation failed.";
    this.#setSnapshot({ error: { scope, message: normalized } });
    this.#emit({ type: "error", scope, message: normalized });
  }

  #emit(event: VoiceAssistantSessionEventInput): void {
    const immutable = freeze({ ...event, sequence: this.#sequence++ }) as unknown as VoiceAssistantSessionEvent;
    for (const listener of [...this.#listeners]) {
      try { listener(immutable); } catch { /* observers cannot affect cleanup */ }
    }
  }
}

function normalizeConversationId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Voice assistant conversation id must not be empty.");
  return normalized;
}

function normalizeTranscript(value: string): string { return value.trim(); }
function errorMessage(error: unknown): string { return error instanceof Error && error.message ? error.message : String(error); }

function freeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}
