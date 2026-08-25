export type PetAssistantModality = "typed" | "voice";

export class PetAssistantModalityBusyError extends Error {
  readonly name = "PetAssistantModalityBusyError";

  constructor(
    readonly requested: PetAssistantModality,
    readonly active: PetAssistantModality,
  ) {
    super(`Cannot start a ${requested} Pet Assistant turn while a ${active} turn is active.`);
  }
}

export type PetAssistantModalityLease = {
  readonly modality: PetAssistantModality;
  release(): void;
};

/** Serializes typed and Talk turns for the shared canonical conversation. */
export class PetAssistantModalityCoordinator {
  #owner: { readonly modality: PetAssistantModality; readonly token: object } | null = null;

  get activeModality(): PetAssistantModality | null { return this.#owner?.modality ?? null; }

  acquire(modality: PetAssistantModality): PetAssistantModalityLease {
    if (this.#owner) throw new PetAssistantModalityBusyError(modality, this.#owner.modality);
    const token = {};
    this.#owner = { modality, token };
    let released = false;
    return {
      modality,
      release: () => {
        if (released) return;
        released = true;
        if (this.#owner?.token === token) this.#owner = null;
      },
    };
  }

  releaseAll(): void { this.#owner = null; }

  releaseModality(modality: PetAssistantModality): void {
    if (this.#owner?.modality === modality) this.#owner = null;
  }
}
