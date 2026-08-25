import { VoiceCaptureService, type VoiceCaptureFactory } from "./voice-capture.js";
import { VoiceMicrophoneArbiter } from "./voice-microphone-arbiter.js";
import { VoicePrivacyIndicator } from "./voice-privacy-indicator.js";

export type VoiceResourceOwnerOptions = {
  readonly microphoneArbiter?: VoiceMicrophoneArbiter;
  readonly privacyIndicator?: VoicePrivacyIndicator;
  readonly privacyIndicatorFactory?: () => VoicePrivacyIndicator;
  readonly captureFactory?: VoiceCaptureFactory;
};

/** Sole owner of shared microphone capture and privacy resources. */
export class VoiceResourceOwner {
  readonly microphoneArbiter: VoiceMicrophoneArbiter;
  readonly privacyIndicator: VoicePrivacyIndicator;
  readonly #captureFactory: VoiceCaptureFactory;
  #capture: VoiceCaptureService | null = null;
  #shutdownPromise: Promise<void> | null = null;

  constructor(options: VoiceResourceOwnerOptions = {}) {
    this.microphoneArbiter = options.microphoneArbiter ?? new VoiceMicrophoneArbiter();
    if (!options.privacyIndicator && !options.privacyIndicatorFactory) throw new Error("A shared voice privacy indicator is required.");
    if (!options.captureFactory) throw new Error("A shared voice capture factory is required.");
    this.privacyIndicator = options.privacyIndicator ?? options.privacyIndicatorFactory!();
    this.#captureFactory = options.captureFactory;
  }

  capture(): VoiceCaptureService {
    if (this.#shutdownPromise) throw new Error("Shared voice resources are shut down.");
    return this.#capture ??= new VoiceCaptureService(this.#captureFactory, this.privacyIndicator, { microphoneArbiter: this.microphoneArbiter });
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownPromise = (async () => {
      await this.#capture?.shutdown().catch(() => undefined);
      this.privacyIndicator.shutdown();
      this.#capture = null;
    })();
    return this.#shutdownPromise;
  }
}
