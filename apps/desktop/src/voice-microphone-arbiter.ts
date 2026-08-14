export type VoiceMicrophoneOwner = "listen" | "conversation";

export type VoiceMicrophoneLease = {
  readonly owner: VoiceMicrophoneOwner;
  readonly generation: number;
  release(): void;
};

/** The host-level boundary that prevents independent voice paths owning audio together. */
export class VoiceMicrophoneArbiter {
  #active: { readonly owner: VoiceMicrophoneOwner; readonly generation: number } | null = null;
  #nextGeneration = 0;

  get activeOwner(): VoiceMicrophoneOwner | null {
    return this.#active?.owner ?? null;
  }

  acquire(owner: VoiceMicrophoneOwner): VoiceMicrophoneLease {
    if (this.#active) {
      throw new Error(`The microphone is already in use by ${this.#ownerDescription(this.#active.owner)}.`);
    }

    const entry = { owner, generation: ++this.#nextGeneration };
    this.#active = entry;
    let released = false;
    return {
      owner,
      generation: entry.generation,
      release: () => {
        if (released) return;
        released = true;
        if (this.#active === entry) this.#active = null;
      },
    };
  }

  #ownerDescription(owner: VoiceMicrophoneOwner): string {
    return owner === "listen" ? "one-shot voice listening" : "a realtime voice conversation";
  }
}
