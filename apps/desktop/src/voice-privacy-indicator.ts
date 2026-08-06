export interface VoicePrivacyIndicatorSurface {
  show(): void;
  hide(): void;
  destroy(): void;
}

/** Tracks live microphone ownership without coupling lifecycle tests to Electron. */
export class VoicePrivacyIndicator {
  readonly #createSurface: () => VoicePrivacyIndicatorSurface;
  #surface: VoicePrivacyIndicatorSurface | null = null;
  #liveTracks = 0;

  constructor(createSurface: () => VoicePrivacyIndicatorSurface) {
    this.#createSurface = createSurface;
  }

  get liveTracks(): number {
    return this.#liveTracks;
  }

  trackStarted(): void {
    this.#liveTracks += 1;
    if (this.#liveTracks !== 1) return;
    try {
      this.#surface ??= this.#createSurface();
      this.#surface.show();
    } catch {
      // A privacy surface must not prevent microphone cleanup or transcription.
    }
  }

  trackStopped(): void {
    if (this.#liveTracks === 0) return;
    this.#liveTracks -= 1;
    if (this.#liveTracks !== 0) return;
    try { this.#surface?.hide(); } catch { /* best effort */ }
  }

  shutdown(): void {
    this.#liveTracks = 0;
    const surface = this.#surface;
    this.#surface = null;
    if (!surface) return;
    try { surface.destroy(); } catch { /* best effort */ }
  }
}
