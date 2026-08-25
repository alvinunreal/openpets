export async function shutdownVoiceAssistantResources(
  shutdownSession: () => Promise<void>,
  unsubscribeSession: () => void,
  shutdownPlayer: () => Promise<void>,
): Promise<void> {
  let failure: unknown;
  let failed = false;
  try {
    await shutdownSession();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    unsubscribeSession();
    try {
      await shutdownPlayer();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
}

export async function shutdownVoiceAssistantWithCleanup(
  shutdown: () => Promise<void>,
  cleanup: () => void,
): Promise<void> {
  try {
    await shutdown();
  } finally {
    cleanup();
  }
}
