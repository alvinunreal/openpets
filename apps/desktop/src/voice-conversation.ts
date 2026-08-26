import type { VoiceMicrophoneArbiter, VoiceMicrophoneLease } from "./voice-microphone-arbiter.js";
import type { VoicePrivacyIndicator } from "./voice-privacy-indicator.js";
import type { PetAssistantToolResult } from "./pet-assistant-types.js";

export const VOICE_REALTIME_MODEL = "gpt-realtime-2.1";

export type VoiceRealtimeSessionConfig = Readonly<Record<string, unknown>>;

export type VoiceRealtimeToolResultCommand = {
  readonly callId: string;
  readonly result: PetAssistantToolResult;
};

export function createDefaultVoiceRealtimeSessionConfig(model = VOICE_REALTIME_MODEL): VoiceRealtimeSessionConfig {
  return {
    type: "realtime",
    model,
    instructions: "You are the OpenPets Pet Assistant.",
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: { model: "gpt-realtime-whisper" },
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {},
    },
    tools: [],
    tool_choice: "none",
  };
}

export type VoiceConversationPhase = "idle" | "acquiring" | "negotiating" | "connected" | "closing";
export type VoiceConversationActivity = "idle" | "user-speaking" | "thinking" | "assistant-speaking";

export type VoiceConversationEvent =
  | { readonly type: "microphone-acquired" }
  | { readonly type: "microphone-released" }
  | { readonly type: "negotiating" }
  | { readonly type: "connected" }
  | { readonly type: "speech-started"; readonly itemId: string }
  | { readonly type: "speech-stopped"; readonly itemId: string }
  | { readonly type: "response-started"; readonly responseId: string }
  | { readonly type: "response-audio-started"; readonly responseId: string }
  | { readonly type: "response-audio-stopped"; readonly responseId: string }
  | { readonly type: "response-completed"; readonly responseId: string }
  | { readonly type: "transcript"; readonly entryId: string; readonly itemId: string; readonly responseId?: string; readonly speaker: "user" | "assistant"; readonly status: "partial" | "final"; readonly text: string }
  | { readonly type: "tool-call"; readonly callId: string; readonly itemId: string; readonly responseId: string; readonly name: string; readonly arguments: string }
  | { readonly type: "interrupted"; readonly responseId?: string; readonly itemId?: string }
  | { readonly type: "error"; readonly error: unknown }
  | { readonly type: "closed"; readonly reason?: string };

export type VoiceConversationSnapshot = {
  readonly phase: VoiceConversationPhase;
  readonly sessionId: string | null;
  readonly generation: number | null;
  readonly muted: boolean;
  readonly activity: VoiceConversationActivity;
  readonly interruptionCount: number;
  readonly error: string | null;
};

export type VoiceConversationTransportContext = {
  readonly sessionId: string;
  readonly generation: number;
  readonly session: VoiceRealtimeSessionConfig;
  readonly signal: AbortSignal;
  readonly emit: (event: VoiceConversationEvent) => void;
};

export interface VoiceConversationTransport {
  start(): Promise<void>;
  setMuted(muted: boolean): void | Promise<void>;
  close(): Promise<void>;
  sendToolResult?(command: VoiceRealtimeToolResultCommand): void | Promise<void>;
}

export type VoiceConversationTransportFactory = (context: VoiceConversationTransportContext) => VoiceConversationTransport;

export type VoiceConversationServiceOptions = {
  readonly microphoneArbiter: VoiceMicrophoneArbiter;
  readonly privacyIndicator: VoicePrivacyIndicator;
  readonly transportFactory: VoiceConversationTransportFactory;
  readonly sessionFactory?: () => VoiceRealtimeSessionConfig;
  readonly onEvent?: (event: VoiceConversationEvent) => void;
};

export class VoiceConversationCancelledError extends Error {
  constructor(message = "Voice conversation was closed.") {
    super(message);
    this.name = "VoiceConversationCancelledError";
  }
}

type DeferredNever = {
  readonly promise: Promise<never>;
  reject(error: unknown): void;
};

type ActiveConversation = {
  readonly generation: number;
  readonly sessionId: string;
  readonly controller: AbortController;
  readonly microphoneLease: VoiceMicrophoneLease;
  readonly closed: DeferredNever;
  phase: VoiceConversationPhase;
  activity: VoiceConversationActivity;
  muted: boolean;
  interruptionCount: number;
  error: Error | null;
  transport: VoiceConversationTransport | null;
  indicatorLive: boolean;
  closing: boolean;
  cleaned: boolean;
  cleanupPromise: Promise<void> | null;
  closePromise: Promise<void> | null;
};

export class VoiceConversationService {
  readonly #microphoneArbiter: VoiceMicrophoneArbiter;
  readonly #privacyIndicator: VoicePrivacyIndicator;
  readonly #transportFactory: VoiceConversationTransportFactory;
  readonly #sessionFactory: () => VoiceRealtimeSessionConfig;
  readonly #onEvent?: (event: VoiceConversationEvent) => void;
  #active: ActiveConversation | null = null;
  #nextGeneration = 0;
  #lastError: Error | null = null;
  #shutdownRequested = false;
  #shutdownPromise: Promise<void> | null = null;

  constructor(options: VoiceConversationServiceOptions) {
    this.#microphoneArbiter = options.microphoneArbiter;
    this.#privacyIndicator = options.privacyIndicator;
    this.#transportFactory = options.transportFactory;
    this.#sessionFactory = options.sessionFactory ?? createDefaultVoiceRealtimeSessionConfig;
    this.#onEvent = options.onEvent;
  }

  snapshot(): VoiceConversationSnapshot {
    const active = this.#active;
    if (!active) {
      return {
        phase: "idle",
        sessionId: null,
        generation: null,
        muted: false,
        activity: "idle",
        interruptionCount: 0,
        error: this.#lastError?.message ?? null,
      };
    }
    return {
      phase: active.phase,
      sessionId: active.sessionId,
      generation: active.generation,
      muted: active.muted,
      activity: active.activity,
      interruptionCount: active.interruptionCount,
      error: active.error?.message ?? this.#lastError?.message ?? null,
    };
  }

  async start(): Promise<VoiceConversationSnapshot> {
    if (this.#shutdownRequested) throw new Error("Voice conversation service is shut down.");
    if (this.#active) throw new Error("A realtime voice conversation is already in progress.");

    const microphoneLease = this.#microphoneArbiter.acquire("conversation");
    const generation = ++this.#nextGeneration;
    const active = this.#createActive(generation, microphoneLease);
    this.#active = active;
    this.#lastError = null;

    try {
      active.transport = this.#transportFactory({
        sessionId: active.sessionId,
        generation: active.generation,
        session: this.#sessionFactory(),
        signal: active.controller.signal,
        emit: (event) => this.#handleEvent(active, event),
      });
      const startPromise = Promise.resolve().then(() => active.transport!.start());
      void startPromise.catch(() => undefined);
      await Promise.race([startPromise, active.closed.promise]);
      if (active.closing || !this.#isCurrent(active)) throw new VoiceConversationCancelledError();
      if (active.phase !== "connected") active.phase = "connected";
      active.activity = "idle";
      return this.snapshot();
    } catch (error) {
      const failure = active.closing ? new VoiceConversationCancelledError() : normalizeError(error);
      if (!active.closing) {
        active.error = failure;
        this.#lastError = failure;
      }
      await this.#cleanup(active);
      throw failure;
    }
  }

  async close(reason = "Voice conversation was closed."): Promise<void> {
    const active = this.#active;
    if (!active) return;
    if (active.closePromise) return active.closePromise;

    active.closing = true;
    active.phase = "closing";
    active.controller.abort();
    active.closed.reject(new VoiceConversationCancelledError(reason));
    active.closePromise = this.#cleanup(active);
    await active.closePromise;
  }

  async mute(): Promise<void> {
    await this.#setMuted(true);
  }

  async unmute(): Promise<void> {
    await this.#setMuted(false);
  }

  async sendToolResult(command: VoiceRealtimeToolResultCommand): Promise<boolean> {
    const active = this.#active;
    if (!active || active.closing || !active.transport?.sendToolResult || !this.#isCurrent(active)) return false;
    await active.transport.sendToolResult(command);
    return this.#isCurrent(active) && !active.closing;
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownRequested = true;
    this.#shutdownPromise = (async () => {
      await this.close("OpenPets is shutting down.");
    })();
    return this.#shutdownPromise;
  }

  #createActive(generation: number, microphoneLease: VoiceMicrophoneLease): ActiveConversation {
    let rejectClosed!: (error: unknown) => void;
    const closed = new Promise<never>((_resolve, reject) => { rejectClosed = reject; });
    void closed.catch(() => undefined);
    return {
      generation,
      sessionId: `voice-conversation-${generation}`,
      controller: new AbortController(),
      microphoneLease,
      closed: { promise: closed, reject: rejectClosed },
      phase: "acquiring",
      activity: "idle",
      muted: false,
      interruptionCount: 0,
      error: null,
      transport: null,
      indicatorLive: false,
      closing: false,
      cleaned: false,
      cleanupPromise: null,
      closePromise: null,
    };
  }

  async #setMuted(muted: boolean): Promise<void> {
    const active = this.#active;
    if (!active || active.closing || !active.transport) throw new Error("No realtime voice conversation is active.");
    if (active.muted === muted) return;
    await active.transport.setMuted(muted);
    if (this.#isCurrent(active) && !active.closing) active.muted = muted;
  }

  #handleEvent(active: ActiveConversation, event: VoiceConversationEvent): void {
    if (!this.#isCurrent(active) || active.closing) return;
    try { this.#onEvent?.(event); } catch (error) { this.#lastError = normalizeError(error); }
    switch (event.type) {
      case "microphone-acquired":
        if (!active.indicatorLive) {
          active.indicatorLive = true;
          this.#privacyIndicator.trackStarted();
        }
        active.phase = "negotiating";
        return;
      case "microphone-released":
        this.#releaseIndicator(active);
        return;
      case "negotiating":
        if (active.phase === "acquiring") active.phase = "negotiating";
        return;
      case "connected":
        active.phase = "connected";
        active.activity = "idle";
        return;
      case "speech-started":
        if (active.activity === "assistant-speaking") active.interruptionCount += 1;
        active.activity = "user-speaking";
        return;
      case "speech-stopped":
        active.activity = "thinking";
        return;
      case "response-started":
        active.activity = "thinking";
        return;
      case "response-audio-started":
        active.activity = "assistant-speaking";
        return;
      case "response-audio-stopped":
      case "response-completed":
        active.activity = "idle";
        return;
      case "interrupted":
        active.interruptionCount += 1;
        active.activity = "user-speaking";
        return;
      case "error": {
        const error = normalizeError(event.error);
        active.error = error;
        this.#lastError = error;
        void this.close("Realtime voice reported an error.").catch(() => undefined);
        return;
      }
      case "closed":
        active.error ??= new Error(event.reason || "The realtime voice renderer closed unexpectedly.");
        this.#lastError = active.error;
        void this.close("The realtime voice renderer closed unexpectedly.").catch(() => undefined);
        return;
    }
  }

  async #cleanup(active: ActiveConversation): Promise<void> {
    if (active.cleanupPromise) return active.cleanupPromise;
    active.cleanupPromise = (async () => {
      active.cleaned = true;
      try {
        await active.transport?.close();
      } catch {
        // Resource release must not depend on renderer or transport cooperation.
      } finally {
        this.#releaseIndicator(active);
        active.microphoneLease.release();
        if (this.#active === active) this.#active = null;
      }
    })();
    return active.cleanupPromise;
  }

  #releaseIndicator(active: ActiveConversation): void {
    if (!active.indicatorLive) return;
    active.indicatorLive = false;
    this.#privacyIndicator.trackStopped();
  }

  #isCurrent(active: ActiveConversation): boolean {
    return this.#active === active && active.generation === this.#nextGeneration && !active.cleaned;
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
