export type VoicePlaybackKind = "audio" | "system";
export type VoicePlaybackCompletion = { readonly owner: unknown; readonly requestId: string; readonly kind: VoicePlaybackKind; readonly outcome: "ended" | "error" | "stopped" };
export const VOICE_PLAYBACK_DEFAULT_TIMEOUT_MS = 60_000;
export const VOICE_PLAYBACK_MAX_TIMEOUT_MS = 120_000;
const systemSpeechMinimumTimeoutMs = 20_000;
const systemSpeechOverheadMs = 5_000;
const systemSpeechCharactersPerSecond = 12;

export type VoicePlaybackSpeech =
  | { readonly kind: "audio"; readonly bytes: Uint8Array }
  | { readonly kind: "system"; readonly text: string };

export function getVoicePlaybackTimeoutMs(speech: VoicePlaybackSpeech, rate = 1): number {
  if (speech.kind === "audio") {
    // Encoded byte length does not identify duration: bitrate and codec settings
    // can make equally sized payloads play for very different lengths.
    return VOICE_PLAYBACK_MAX_TIMEOUT_MS;
  }

  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const estimatedSpeechMs = Math.ceil(speech.text.length / (systemSpeechCharactersPerSecond * safeRate) * 1_000);
  return Math.min(VOICE_PLAYBACK_MAX_TIMEOUT_MS, Math.max(systemSpeechMinimumTimeoutMs, systemSpeechOverheadMs + estimatedSpeechMs));
}

type PendingPlayback = {
  readonly owner: unknown;
  readonly requestId: string;
  readonly kind: VoicePlaybackKind;
  readonly stop: () => void;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
};

export type VoicePlaybackTransport = {
  start(): void;
  stop(): void;
};

/** Main-process request coordinator; every request settles exactly once. */
export class VoiceAssistantPlaybackCoordinator {
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, PendingPlayback>();

  constructor(timeoutMs = VOICE_PLAYBACK_DEFAULT_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Invalid voice playback timeout.");
    this.#timeoutMs = timeoutMs;
  }

  play(requestId: string, kind: VoicePlaybackKind, owner: unknown, transport: VoicePlaybackTransport, timeoutMs = this.#timeoutMs): Promise<void> {
    if (!requestId || this.#pending.has(requestId)) return Promise.reject(new Error("Voice playback request is already active."));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return Promise.reject(new Error("Invalid voice playback timeout."));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#take(requestId);
        if (!pending) return;
        try { pending.stop(); } catch { /* renderer may already be gone */ }
        pending.reject(new Error("Voice playback completion timed out."));
      }, timeoutMs);
      const pending: PendingPlayback = { owner, requestId, kind, stop: transport.stop, resolve, reject, timer };
      this.#pending.set(requestId, pending);
      try { transport.start(); } catch (error) { this.#settle(pending, "error", error instanceof Error ? error : new Error(String(error))); }
    });
  }

  complete(completion: VoicePlaybackCompletion): boolean {
    const pending = this.#pending.get(completion.requestId);
    if (!pending || pending.owner !== completion.owner || pending.kind !== completion.kind) return false;
    this.#settle(pending, completion.outcome, completion.outcome === "ended" ? undefined : new Error(`Voice playback ${completion.outcome}.`));
    return true;
  }

  stop(requestId: string): boolean {
    const pending = this.#take(requestId);
    if (!pending) return false;
    try { pending.stop(); } catch { /* renderer may already be gone */ }
    pending.reject(new Error("Voice playback was stopped."));
    return true;
  }

  failOwner(owner: unknown, reason = "Voice playback window was lost."): void {
    for (const pending of [...this.#pending.values()]) {
      if (pending.owner !== owner) continue;
      const taken = this.#take(pending.requestId);
      if (taken) taken.reject(new Error(reason));
    }
  }

  shutdown(reason = "Voice playback was shut down."): void {
    for (const pending of [...this.#pending.values()]) {
      const taken = this.#take(pending.requestId);
      if (!taken) continue;
      try { taken.stop(); } catch { /* renderer may already be gone */ }
      taken.reject(new Error(reason));
    }
  }

  get pendingCount(): number { return this.#pending.size; }

  #settle(pending: PendingPlayback, outcome: "ended" | "error" | "stopped", error?: Error): void {
    const taken = this.#take(pending.requestId);
    if (!taken) return;
    if (outcome === "ended") taken.resolve();
    else taken.reject(error ?? new Error(`Voice playback ${outcome}.`));
  }

  #take(requestId: string): PendingPlayback | null {
    const pending = this.#pending.get(requestId);
    if (!pending) return null;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    return pending;
  }
}
