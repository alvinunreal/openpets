export type VoiceOperationPhase = "acquiring" | "recording" | "transcribing";

export type VoiceOperationSnapshot = {
  readonly phase: VoiceOperationPhase;
  readonly cancel: () => Promise<void>;
};

export class VoiceOperationState {
  #operation: { phase: VoiceOperationPhase; cancel: () => Promise<void> } | null = null;
  readonly #listeners = new Set<() => void>();

  begin(cancel: () => Promise<void>): void {
    if (this.#operation) throw new Error("A voice operation is already in progress.");
    this.#operation = { phase: "acquiring", cancel };
    this.#notify();
  }

  setPhase(phase: VoiceOperationPhase): void {
    if (!this.#operation || this.#operation.phase === phase) return;
    this.#operation.phase = phase;
    this.#notify();
  }

  settle(): void {
    if (!this.#operation) return;
    this.#operation = null;
    this.#notify();
  }

  snapshot(): VoiceOperationSnapshot | null {
    if (!this.#operation) return null;
    return { phase: this.#operation.phase, cancel: this.#operation.cancel };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try { listener(); } catch { /* host observers must not affect voice cleanup */ }
    }
  }
}
