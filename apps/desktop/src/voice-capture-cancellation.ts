export const VOICE_RENDERER_CANCELLATION_TIMEOUT_MS = 500;

export function createVoiceCaptureCancellation(
  cancelRenderer: () => Promise<void>,
  destroyWindow: () => void,
  rendererCancellationTimeoutMs = VOICE_RENDERER_CANCELLATION_TIMEOUT_MS,
): () => Promise<void> {
  let cancellation: Promise<void> | null = null;
  return () => {
    if (!cancellation) {
      cancellation = (async () => {
        let rendererCancellation: Promise<void>;
        try {
          rendererCancellation = Promise.resolve(cancelRenderer()).catch(() => undefined);
        } catch {
          rendererCancellation = Promise.resolve();
        }
        let timeout: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, rendererCancellationTimeoutMs);
        });
        try {
          await Promise.race([rendererCancellation, timeoutPromise]);
        } finally {
          if (timeout) clearTimeout(timeout);
          try { destroyWindow(); } catch { /* the window may already be gone */ }
        }
      })();
    }
    return cancellation;
  };
}
