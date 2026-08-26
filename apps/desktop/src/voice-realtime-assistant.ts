import type { PetAssistantService } from "./pet-assistant-service.js";
import type { PetAssistantRealtimeSession, PetAssistantRealtimeTurn, PetAssistantToolCall } from "./pet-assistant-types.js";
import { PET_ASSISTANT_CONVERSATION_ID } from "./pet-assistant-conversation.js";
import type { PetAssistantModalityCoordinator, PetAssistantModalityLease } from "./pet-assistant-modality.js";
import type { HostProviderOperations, ProviderOperationSnapshot } from "./provider-service.js";
import { VoiceConversationService, type VoiceConversationEvent, type VoiceConversationTransportFactory, type VoiceRealtimeSessionConfig } from "./voice-conversation.js";
import type { VoiceMicrophoneArbiter } from "./voice-microphone-arbiter.js";
import type { VoicePrivacyIndicator } from "./voice-privacy-indicator.js";
import type { VoiceAssistantSessionEvent, VoiceAssistantSessionEventInput, VoiceAssistantSessionListener, VoiceAssistantSessionSnapshot, VoiceAssistantSessionLike } from "./voice-assistant-session.js";

export type RealtimeVoiceSessionOptions = {
  readonly provider: HostProviderOperations;
  readonly assistant: PetAssistantService;
  readonly microphoneArbiter: VoiceMicrophoneArbiter;
  readonly privacyIndicator: VoicePrivacyIndicator;
  readonly modalityCoordinator: PetAssistantModalityCoordinator;
  readonly transportFactory: (provider: ProviderOperationSnapshot) => VoiceConversationTransportFactory;
  readonly turnIdPrefix?: string;
};

export function buildOpenAIRealtimeSessionConfig(model: string, realtime: Pick<PetAssistantRealtimeSession, "tools" | "instructions">): VoiceRealtimeSessionConfig {
  const tools = realtime.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema }));
  return Object.freeze({
    type: "realtime",
    model,
    instructions: realtime.instructions,
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: { model: "gpt-realtime-whisper" },
        turn_detection: { type: "server_vad", create_response: true, interrupt_response: true },
      },
      output: {},
    },
    tools: Object.freeze(tools),
    tool_choice: tools.length === 0 ? "none" : "auto",
  });
}

/** Native Realtime session that shares the Talk surface and canonical assistant authority. */
export class OpenAIRealtimeVoiceAssistantSession implements VoiceAssistantSessionLike {
  readonly #options: RealtimeVoiceSessionOptions;
  readonly #listeners = new Set<VoiceAssistantSessionListener>();
  readonly #turnIdPrefix: string;
  #snapshot: VoiceAssistantSessionSnapshot;
  #conversation: VoiceConversationService | null = null;
  #realtime: PetAssistantRealtimeSession | null = null;
  #turn: PetAssistantRealtimeTurn | null = null;
  #turnController: AbortController | null = null;
  #modalityLease: PetAssistantModalityLease | null = null;
  #sessionController: AbortController | null = null;
  #startPromise: Promise<void> | null = null;
  #endPromise: Promise<void> | null = null;
  #ended = false;
  #muted = false;
  #generation = 0;
  #sequence = 1;
  #turnOrdinal = 0;
  #lastAssistantTranscript: string | undefined;
  #interruptionCount = 0;
  #toolCalls = new Set<string>();
  #pendingToolCalls = 0;
  #responseCompleted = false;
  #hasToolCall = false;
  #awaitingToolFollowup = false;

  constructor(options: RealtimeVoiceSessionOptions) {
    this.#options = options;
    this.#turnIdPrefix = options.turnIdPrefix ?? "realtime-turn";
    this.#snapshot = freeze({ status: "idle", activity: null, muted: false, conversationId: PET_ASSISTANT_CONVERSATION_ID, generation: 0, turnId: null, userTranscript: null, assistantTranscript: null, interruptionCount: 0, error: null });
  }

  snapshot(): VoiceAssistantSessionSnapshot { return this.#snapshot; }

  subscribe(listener: VoiceAssistantSessionListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    if (this.#ended) throw new Error("Voice assistant session has ended.");
    this.#startPromise = this.#startInternal();
    try { await this.#startPromise; } finally { this.#startPromise = null; }
  }

  async retry(): Promise<void> {
    if (this.#ended) throw new Error("Voice assistant session has ended.");
    if (this.#snapshot.status === "paused") await this.start();
  }

  async mute(): Promise<void> {
    if (!this.#conversation || this.#ended) throw new Error("Voice assistant session is not active.");
    if (this.#muted) return;
    this.#muted = true;
    await this.#conversation.mute();
    this.#setSnapshot({ status: "muted", muted: true, activity: null });
  }

  async unmute(): Promise<void> {
    if (!this.#conversation || this.#ended) throw new Error("Voice assistant session is not active.");
    if (!this.#muted) return;
    this.#muted = false;
    await this.#conversation.unmute();
    this.#setSnapshot({ status: "active", muted: false, activity: "listening" });
  }

  async interrupt(): Promise<void> {
    if (this.#ended) return;
    this.#interruptionCount += 1;
    await this.#cancelTurn("Realtime response was interrupted.");
    this.#setSnapshot({ status: this.#muted ? "muted" : "active", activity: this.#muted ? null : "listening", interruptionCount: this.#interruptionCount });
    this.#emit({ type: "interrupted", generation: this.#generation, turnId: this.#snapshot.turnId });
  }

  async end(): Promise<void> { await this.#end("ended"); }
  async shutdown(): Promise<void> { await this.#end("shutdown"); }

  async #startInternal(): Promise<void> {
    const lease = this.#options.modalityCoordinator.acquire("voice");
    this.#modalityLease = lease;
    this.#sessionController = new AbortController();
    ++this.#generation;
    try {
      // Both snapshots are captured before WebRTC negotiation and remain fixed.
      const provider = await this.#options.provider.snapshot("realtime");
      const realtime = await this.#options.assistant.openRealtimeSession(this.#sessionController.signal);
      this.#realtime = realtime;
      const conversation = new VoiceConversationService({
        microphoneArbiter: this.#options.microphoneArbiter,
        privacyIndicator: this.#options.privacyIndicator,
        sessionFactory: () => buildOpenAIRealtimeSessionConfig(provider.profile.model, realtime),
        transportFactory: this.#options.transportFactory(provider),
        onEvent: (event) => this.#handleConversationEvent(event),
      });
      this.#conversation = conversation;
      await conversation.start();
      this.#setSnapshot({ status: "active", activity: "listening", muted: false, error: null });
    } catch (error) {
      await this.#realtime?.close().catch(() => undefined);
      await this.#conversation?.close().catch(() => undefined);
      this.#realtime = null;
      this.#conversation = null;
      this.#sessionController = null;
      this.#modalityLease?.release();
      this.#modalityLease = null;
      this.#setSnapshot({ status: "ended", activity: null, error: { scope: "session", message: errorMessage(error) } });
      throw error;
    }
  }

  #handleConversationEvent(event: VoiceConversationEvent): void {
    if (this.#ended) return;
    if (event.type === "speech-started") {
      this.#setSnapshot({ status: this.#muted ? "muted" : "active", activity: this.#muted ? null : "listening" });
      if (!this.#turn) this.#beginTurn();
    } else if (event.type === "speech-stopped") {
      this.#setSnapshot({ activity: this.#muted ? null : "thinking" });
    } else if (event.type === "response-started") {
      this.#setSnapshot({ activity: this.#muted ? null : "thinking" });
    } else if (event.type === "response-audio-started") {
      this.#setSnapshot({ activity: this.#muted ? null : "speaking" });
    } else if (event.type === "response-audio-stopped") {
      this.#setSnapshot({ activity: this.#muted ? null : "thinking" });
    } else if (event.type === "response-completed") {
      this.#completeTurn();
    } else if (event.type === "interrupted") {
      void this.interrupt().catch(() => undefined);
    } else if (event.type === "transcript") {
      this.#handleTranscript(event);
    } else if (event.type === "tool-call") {
      void this.#handleToolCall(event).catch((error) => this.#fail(error));
    } else if (event.type === "error" || event.type === "closed") {
      this.#fail(event.type === "error" ? event.error : new Error(event.reason ?? "Realtime transport closed."));
    }
  }

  #handleTranscript(event: Extract<VoiceConversationEvent, { readonly type: "transcript" }>): void {
    const turn = this.#turn ?? this.#beginTurn();
    const text = event.text.trim();
    if (!text) return;
    if (event.status === "final") turn.recordTranscript(event.speaker, text);
    if (event.speaker === "user") this.#setSnapshot({ userTranscript: text, turnId: turn.turnId });
    else {
      this.#lastAssistantTranscript = text;
      this.#setSnapshot({ assistantTranscript: text, turnId: turn.turnId });
    }
    this.#emit({ type: "transcript", turnId: turn.turnId, speaker: event.speaker, kind: event.status, text });
  }

  async #handleToolCall(event: Extract<VoiceConversationEvent, { readonly type: "tool-call" }>): Promise<void> {
    const turn = this.#turn ?? this.#beginTurn();
    if (this.#toolCalls.has(event.callId)) return;
    this.#toolCalls.add(event.callId);
    this.#hasToolCall = true;
    this.#awaitingToolFollowup = false;
    this.#pendingToolCalls += 1;
    try {
      let argumentsValue: unknown;
      try { argumentsValue = JSON.parse(event.arguments); } catch { argumentsValue = undefined; }
      const call: PetAssistantToolCall = { id: event.callId, name: event.name, arguments: argumentsValue };
      if (!isPlainObject(argumentsValue)) {
        await this.#conversation?.sendToolResult({ callId: event.callId, result: { status: "rejected", reason: "Capability arguments must be a strict JSON object." } });
        return;
      }
      turn.recordToolCall(call);
      this.#setSnapshot({ activity: this.#muted ? null : "acting", turnId: turn.turnId });
      const result = await turn.executeToolCall(call, this.#turnController?.signal ?? this.#sessionController!.signal);
      if (this.#turn === turn && !this.#ended) await this.#conversation?.sendToolResult({ callId: event.callId, result });
    } finally {
      this.#pendingToolCalls -= 1;
      this.#completeTurnIfReady();
    }
  }

  #beginTurn(): PetAssistantRealtimeTurn {
    if (!this.#realtime || !this.#sessionController) throw new Error("Realtime assistant is not ready.");
    if (this.#turn) return this.#turn;
    this.#turnController = new AbortController();
    const turn = this.#realtime.beginTurn(`${this.#turnIdPrefix}-${++this.#turnOrdinal}`, this.#turnController.signal);
    this.#turn = turn;
    this.#toolCalls = new Set();
    this.#pendingToolCalls = 0;
    this.#responseCompleted = false;
    this.#hasToolCall = false;
    this.#awaitingToolFollowup = false;
    this.#setSnapshot({ turnId: turn.turnId, userTranscript: null, assistantTranscript: null });
    return turn;
  }

  #completeTurn(): void {
    this.#responseCompleted = true;
    this.#completeTurnIfReady();
  }

  #completeTurnIfReady(): void {
    const turn = this.#turn;
    if (!turn || !this.#responseCompleted || this.#pendingToolCalls > 0) return;
    if (this.#hasToolCall && !this.#awaitingToolFollowup) {
      this.#awaitingToolFollowup = true;
      this.#responseCompleted = false;
      return;
    }
    const result = turn.complete(this.#lastAssistantTranscript);
    this.#turn = null;
    this.#turnController = null;
    this.#lastAssistantTranscript = undefined;
    this.#responseCompleted = false;
    this.#emit({ type: "turn-settled", turnId: result.turnId, outcome: result.status });
    this.#setSnapshot({ activity: this.#muted ? null : "listening", turnId: null });
  }

  async #cancelTurn(reason: string): Promise<void> {
    const turn = this.#turn;
    if (!turn) return;
    this.#turnController?.abort();
    const result = await turn.cancel();
    this.#turn = null;
    this.#turnController = null;
    this.#lastAssistantTranscript = undefined;
    this.#pendingToolCalls = 0;
    this.#responseCompleted = false;
    this.#hasToolCall = false;
    this.#awaitingToolFollowup = false;
    this.#emit({ type: "turn-settled", turnId: result.turnId, outcome: result.status });
    void reason;
  }

  async #end(reason: "ended" | "shutdown"): Promise<void> {
    if (this.#endPromise) return this.#endPromise;
    if (this.#ended) return;
    this.#endPromise = (async () => {
      this.#ended = true;
      this.#setSnapshot({ status: "ending", activity: null });
      await this.#cancelTurn("Realtime session ended.").catch(() => undefined);
      this.#sessionController?.abort();
      await this.#conversation?.close().catch(() => undefined);
      await this.#realtime?.close().catch(() => undefined);
      this.#conversation = null;
      this.#realtime = null;
      this.#modalityLease?.release();
      this.#modalityLease = null;
      this.#setSnapshot({ status: "ended", activity: null });
      this.#emit({ type: "ended", reason });
    })();
    await this.#endPromise;
  }

  #fail(error: unknown): void {
    if (this.#ended) return;
    this.#setSnapshot({ status: "paused", activity: null, error: { scope: "session", message: errorMessage(error) } });
    void this.end().catch(() => undefined);
  }

  #setSnapshot(patch: Partial<VoiceAssistantSessionSnapshot>): void {
    this.#snapshot = freeze({ ...this.#snapshot, ...patch, generation: this.#generation });
    this.#emit({ type: "snapshot", snapshot: this.#snapshot });
  }

  #emit(event: VoiceAssistantSessionEventInput): void {
    const immutable = freeze({ ...event, sequence: this.#sequence++ }) as VoiceAssistantSessionEvent;
    for (const listener of [...this.#listeners]) {
      try { listener(immutable); } catch { /* observers cannot affect cleanup */ }
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function errorMessage(error: unknown): string { return error instanceof Error && error.message ? error.message : String(error); }

function freeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}
