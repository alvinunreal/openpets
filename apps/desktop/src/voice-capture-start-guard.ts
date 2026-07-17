export type VoiceCaptureStartAttempt = {
  readonly owner: "plugin-listen" | "push-to-talk";
  readonly petId?: string;
  cancelled: boolean;
  cancelReason: string;
};

type CancellableCaptureHandle = {
  cancel(reason?: string): Promise<void>;
};

/**
 * Coordinates the gap between requesting microphone access and receiving the
 * capture handle. Cancellation cannot abort every host implementation while
 * acquisition is pending, so a handle that arrives late must be rejected and
 * torn down before callers can mark it live.
 */
export class VoiceCaptureStartGuard {
  #pending: VoiceCaptureStartAttempt | null = null;

  get pending(): VoiceCaptureStartAttempt | null {
    return this.#pending;
  }

  begin(owner: VoiceCaptureStartAttempt["owner"], petId?: string): VoiceCaptureStartAttempt {
    if (this.#pending) throw new Error("Another voice activity is already active.");
    const attempt: VoiceCaptureStartAttempt = {
      owner,
      ...(petId ? { petId } : {}),
      cancelled: false,
      cancelReason: "cancelled",
    };
    this.#pending = attempt;
    return attempt;
  }

  cancel(reason: string): VoiceCaptureStartAttempt | null {
    const attempt = this.#pending;
    if (attempt) {
      attempt.cancelled = true;
      attempt.cancelReason = reason;
    }
    return attempt;
  }

  async accept(attempt: VoiceCaptureStartAttempt, handle: CancellableCaptureHandle): Promise<boolean> {
    if (this.#pending === attempt && !attempt.cancelled) {
      this.#pending = null;
      return true;
    }
    await handle.cancel(attempt.cancelReason).catch(() => undefined);
    return false;
  }

  clear(attempt: VoiceCaptureStartAttempt): void {
    if (this.#pending === attempt) this.#pending = null;
  }
}
