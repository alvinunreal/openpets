import type { PetAssistantService } from "./pet-assistant-service.js";
import type { HostProviderOperations } from "./provider-service.js";
import type { VoiceAssistantInput, VoiceAssistantInputOptions, VoiceAssistantInputResult, VoiceAssistantSpeech, VoiceAssistantSynthesizer, VoiceAssistantTurnAdapter, VoiceAssistantTurnResult } from "./voice-assistant-session.js";
import type { VoiceCaptureService } from "./voice-capture.js";
import { VoiceListeningService } from "./voice-listening-service.js";
import { VoiceAssistantSession } from "./voice-assistant-session.js";
import type { VoiceAssistantSessionEvent } from "./voice-assistant-session.js";

const HOST_RECORDING_DURATION_MS = 10_000;

export type VoiceAssistantHostInstance = {
  readonly session: VoiceAssistantSession;
  readonly sessionId?: number;
  shutdown(): Promise<void>;
};

export type VoiceAssistantHostEvent = VoiceAssistantSessionEvent & { readonly sessionId: number };

/** Owns activation scope; ended sessions are discarded before the next activation. */
export class VoiceAssistantHostController {
  readonly #create: () => VoiceAssistantHostInstance;
  #active: VoiceAssistantHostInstance | null = null;
  #transition: Promise<void> = Promise.resolve();
  #stopped = false;
  readonly #listeners = new Set<(event: VoiceAssistantHostEvent) => void>();
  #unsubscribeSession: (() => void) | null = null;

  constructor(create: () => VoiceAssistantHostInstance) {
    this.#create = create;
  }

  get session(): VoiceAssistantSession | null { return this.#active?.session ?? null; }

  subscribe(listener: (event: VoiceAssistantHostEvent) => void): () => void {
    this.#listeners.add(listener);
    if (this.#active) listener({ type: "snapshot", sequence: 0, snapshot: this.#active.session.snapshot(), sessionId: this.#active.sessionId ?? 0 });
    return () => { this.#listeners.delete(listener); };
  }

  activate(): Promise<VoiceAssistantSession> {
    if (this.#stopped) return Promise.reject(new Error("Voice assistant host has stopped."));
    const next = this.#transition.then(async () => {
      if (this.#stopped) throw new Error("Voice assistant host has stopped.");
      if (this.#active && this.#active.session.snapshot().status === "ended") {
        this.#unsubscribeSession?.();
        this.#unsubscribeSession = null;
        await this.#active.shutdown();
        this.#active = null;
      }
      if (!this.#active) {
        const created = this.#create();
        this.#active = created;
        this.#unsubscribeSession = created.session.subscribe((event) => {
          const sessionEvent = { ...event, sessionId: created.sessionId ?? 0 } as VoiceAssistantHostEvent;
          for (const listener of [...this.#listeners]) {
            try { listener(sessionEvent); } catch { /* observers cannot affect session cleanup */ }
          }
        });
        try { await created.session.start(); }
        catch (error) { this.#unsubscribeSession?.(); this.#unsubscribeSession = null; await created.shutdown().catch(() => undefined); this.#active = null; throw error; }
      }
      return this.#active.session;
    });
    this.#transition = next.then(() => undefined, () => undefined);
    return next;
  }

  toggle(): Promise<VoiceAssistantSession | null> {
    if (this.#stopped) return Promise.reject(new Error("Voice assistant host has stopped."));
    const next = this.#transition.then(async () => {
      if (this.#stopped) throw new Error("Voice assistant host has stopped.");
      const active = this.#active;
      if (active && active.session.snapshot().status !== "ended") {
        await active.session.end();
        await active.shutdown();
        this.#unsubscribeSession?.();
        this.#unsubscribeSession = null;
        if (this.#active === active) this.#active = null;
        return null;
      }
      if (this.#active && this.#active.session.snapshot().status === "ended") {
        this.#unsubscribeSession?.();
        this.#unsubscribeSession = null;
        await this.#active.shutdown();
        this.#active = null;
      }
      const created = this.#create();
      this.#active = created;
      this.#unsubscribeSession = created.session.subscribe((event) => {
        const sessionEvent = { ...event, sessionId: created.sessionId ?? 0 } as VoiceAssistantHostEvent;
        for (const listener of [...this.#listeners]) {
          try { listener(sessionEvent); } catch { /* observers cannot affect session cleanup */ }
        }
      });
      try { await created.session.start(); }
      catch (error) { this.#unsubscribeSession?.(); this.#unsubscribeSession = null; await created.shutdown().catch(() => undefined); this.#active = null; throw error; }
      return created.session;
    });
    this.#transition = next.then(() => undefined, () => undefined);
    return next;
  }

  end(): Promise<void> {
    const next = this.#transition.then(async () => {
      const active = this.#active;
      if (!active) return;
      await active.session.end();
      await active.shutdown();
      this.#unsubscribeSession?.();
      this.#unsubscribeSession = null;
      if (this.#active === active) this.#active = null;
    });
    this.#transition = next.then(() => undefined, () => undefined);
    return next;
  }

  shutdown(): Promise<void> {
    this.#stopped = true;
    const next = this.#transition.then(async () => {
      const active = this.#active;
      this.#active = null;
      this.#unsubscribeSession?.();
      this.#unsubscribeSession = null;
      await active?.shutdown();
    });
    this.#transition = next.then(() => undefined, () => undefined);
    return next;
  }
}

export class HostVoiceInput implements VoiceAssistantInput {
  readonly #provider: HostProviderOperations;
  readonly #capture: VoiceCaptureService;
  #active: { readonly requestId: string; readonly service: VoiceListeningService } | null = null;

  constructor(provider: HostProviderOperations, capture: VoiceCaptureService) {
    this.#provider = provider;
    this.#capture = capture;
  }

  async listen(options: VoiceAssistantInputOptions): Promise<VoiceAssistantInputResult> {
    if (this.#active) throw new Error("A voice capture is already in progress.");
    if (options.signal.aborted) return { status: "cancelled", reason: "Voice input was cancelled." };
    const snapshot = await this.#provider.snapshot("stt");
    if (options.signal.aborted) return { status: "cancelled", reason: "Voice input was cancelled." };
    const service = new VoiceListeningService(this.#capture, async (capture, signal) => options.signal.aborted ? "" : await this.#provider.transcribe(snapshot, capture.bytes, capture.mimeType, signal));
    this.#active = { requestId: options.requestId, service };
    try {
      const result = await service.listenOnce(HOST_RECORDING_DURATION_MS, options.reservation);
      if (options.signal.aborted) return { status: "cancelled", reason: "Voice input was cancelled." };
      return { status: "completed", final: result.text };
    } catch (error) {
      if (options.signal.aborted) return { status: "cancelled", reason: error instanceof Error ? error.message : "Voice input was cancelled." };
      throw error;
    } finally {
      if (this.#active?.requestId === options.requestId) this.#active = null;
    }
  }

  async cancel(requestId: string): Promise<void> {
    if (this.#active?.requestId !== requestId) return;
    await this.#active.service.cancel();
  }
}

export class ProviderVoiceSynthesizer implements VoiceAssistantSynthesizer {
  readonly #provider: HostProviderOperations;

  constructor(provider: HostProviderOperations) {
    this.#provider = provider;
  }

  async synthesize(text: string, options: { readonly requestId: string; readonly signal: AbortSignal }): Promise<VoiceAssistantSpeech> {
    const snapshot = await this.#provider.snapshot("tts");
    const speech = await this.#provider.synthesize(snapshot, text, {}, options.signal);
    return speech ? { kind: "audio", bytes: speech.bytes, mimeType: speech.mimeType } : { kind: "system", text };
  }
}

export class PetAssistantVoiceAdapter implements VoiceAssistantTurnAdapter {
  readonly #assistant: PetAssistantService;

  constructor(assistant: PetAssistantService) {
    this.#assistant = assistant;
  }

  startTurn(conversationId: string, text: string, signal: AbortSignal, turnId?: string): Promise<VoiceAssistantTurnResult> {
    return this.#assistant.startTurn(conversationId, text, signal, turnId === undefined ? {} : { turnId }).then((result) => ({ status: result.status, turnId: result.turnId, ...(result.response === undefined ? {} : { response: result.response }), ...(result.error === undefined ? {} : { error: result.error }) }));
  }

  subscribe(listener: (event: { readonly conversationId: string; readonly turnId: string; readonly activity: "thinking" | "acting" | "responding" }) => void): () => void {
    return this.#assistant.subscribe((event) => {
      if (event.type !== "activity" || (event.activity !== "thinking" && event.activity !== "acting" && event.activity !== "responding")) return;
      listener({ conversationId: event.conversationId, turnId: event.turnId, activity: event.activity });
    });
  }

}

export function reactionForVoiceActivity(activity: "listening" | "thinking" | "acting" | "speaking"): "waiting" | "thinking" | "working" | "running" {
  if (activity === "listening") return "waiting";
  if (activity === "acting") return "working";
  if (activity === "speaking") return "running";
  return "thinking";
}
