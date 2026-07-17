export type VoiceWakeHealth = {
  readonly checkedAt: number;
  readonly ready: false;
  readonly enabled: false;
  readonly method: "packaging-gate";
  readonly reason: string;
};

const unavailableReason = "Wake word is not available: no approved local runtime and model are packaged with OpenPets yet.";

export class VoiceWakeWordService {
  health(): VoiceWakeHealth {
    return { checkedAt: Date.now(), ready: false, enabled: false, method: "packaging-gate", reason: unavailableReason };
  }

  start(): never {
    throw new Error(unavailableReason);
  }

  stop(): void {
    // Deliberately inert until a runtime passes packaging, license, and teardown validation.
  }

  dispose(): void {
    this.stop();
  }
}
