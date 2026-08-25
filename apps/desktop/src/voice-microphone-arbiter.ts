export type VoiceMicrophoneOwner = "listen" | "conversation" | "assistant-session";

export type VoiceMicrophoneLease = {
  readonly owner: VoiceMicrophoneOwner;
  readonly generation: number;
  release(): void;
};

/** The only microphone capability an input adapter receives for a session. */
export type VoiceMicrophoneTrackLease = {
  readonly owner: "listen";
  readonly generation: number;
  release(): void;
};

/** Opaque reservation: adapters can acquire one track, but cannot release the parent. */
export type VoiceMicrophoneReservation = {
  readonly generation: number;
  acquireTrack(): VoiceMicrophoneTrackLease;
};

type ActiveEntry = {
  readonly owner: VoiceMicrophoneOwner;
  readonly generation: number;
  childActive: boolean;
  released: boolean;
};

/** The host-level boundary that prevents independent voice paths owning audio together. */
export class VoiceMicrophoneArbiter {
  #active: ActiveEntry | null = null;
  readonly #leases = new WeakMap<object, { readonly entry: ActiveEntry; released: boolean }>();
  readonly #reservations = new WeakMap<object, { readonly entry: ActiveEntry; released: boolean }>();
  #nextGeneration = 0;

  get activeOwner(): VoiceMicrophoneOwner | null { return this.#active?.owner ?? null; }

  acquire(owner: VoiceMicrophoneOwner): VoiceMicrophoneLease {
    const entry = this.#acquireEntry(owner);
    const lease = {
      owner,
      generation: entry.generation,
      release: () => {
        const metadata = this.#leases.get(lease);
        if (!metadata || metadata.released) return;
        metadata.released = true;
        entry.released = true;
        this.#releaseEntry(entry);
      },
    } satisfies VoiceMicrophoneLease;
    this.#leases.set(lease, { entry, released: false });
    return lease;
  }

  reserve(owner: VoiceMicrophoneOwner): VoiceMicrophoneReservation {
    const entry = this.#acquireEntry(owner);
    const reservation = {
      generation: entry.generation,
      acquireTrack: () => {
        const metadata = this.#reservations.get(reservation);
        if (!metadata || metadata.released || metadata.entry.released || this.#active !== metadata.entry) {
          throw new Error("The microphone reservation is no longer active.");
        }
        if (metadata.entry.childActive) throw new Error("The microphone reservation already has an active track.");
        metadata.entry.childActive = true;
        let released = false;
        return {
          owner: "listen" as const,
          generation: metadata.entry.generation,
          release: () => {
            if (released) return;
            released = true;
            metadata.entry.childActive = false;
            this.#releaseEntry(metadata.entry);
          },
        };
      },
    } satisfies VoiceMicrophoneReservation;
    this.#reservations.set(reservation, { entry, released: false });
    return reservation;
  }

  releaseReservation(reservation: VoiceMicrophoneReservation): void {
    const metadata = this.#reservations.get(reservation);
    if (!metadata || metadata.released) return;
    if (metadata.entry.childActive) throw new Error("Cannot release a microphone reservation with an active track.");
    metadata.released = true;
    metadata.entry.released = true;
    this.#releaseEntry(metadata.entry);
  }

  #acquireEntry(owner: VoiceMicrophoneOwner): ActiveEntry {
    if (this.#active) throw new Error(`The microphone is already in use by ${this.#ownerDescription(this.#active.owner)}.`);
    const entry = { owner, generation: ++this.#nextGeneration, childActive: false, released: false };
    this.#active = entry;
    return entry;
  }

  #releaseEntry(entry: ActiveEntry): void {
    if (entry.released && !entry.childActive && this.#active === entry) this.#active = null;
  }

  #ownerDescription(owner: VoiceMicrophoneOwner): string {
    if (owner === "listen") return "one-shot voice listening";
    if (owner === "conversation") return "a realtime voice conversation";
    return "an assistant voice session";
  }
}
