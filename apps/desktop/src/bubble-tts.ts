export type BubbleNarrationCandidate = {
  readonly text: string;
  readonly key: string;
};

export type BubbleNarrationDecision = {
  readonly nextKey: string | null;
  readonly shouldSpeak: boolean;
  readonly text?: string;
};

/** Build narration for the visible transient bubble, preferring plugin content. */
export function createOrdinaryBubbleNarrationCandidate(input: {
  readonly message?: string;
  readonly reactionMessage?: string;
  readonly pluginMessage?: string;
  readonly paused: boolean;
}): BubbleNarrationCandidate | null {
  if (input.paused) return null;
  const pluginMessage = normalizeNarrationText(input.pluginMessage);
  const message = normalizeNarrationText(input.message);
  const reactionMessage = normalizeNarrationText(input.reactionMessage);
  const text = pluginMessage || message || reactionMessage;
  return text ? { text, key: text } : null;
}

/**
 * Decide whether a newly presented bubble should speak.
 * New content is marked seen even while narration is off or quiet hours are active,
 * preventing a later refresh from reading stale content.
 */
export function evaluateBubbleNarrationPresentation(input: {
  readonly candidate: BubbleNarrationCandidate | null;
  readonly lastKey: string | null;
  readonly enabled: boolean;
  readonly quietHours: boolean;
}): BubbleNarrationDecision {
  if (!input.candidate) return { nextKey: null, shouldSpeak: false };
  if (input.candidate.key === input.lastKey) {
    return { nextKey: input.candidate.key, shouldSpeak: false };
  }
  if (!input.enabled || input.quietHours) {
    return { nextKey: input.candidate.key, shouldSpeak: false };
  }
  return { nextKey: input.candidate.key, shouldSpeak: true, text: input.candidate.text };
}

function normalizeNarrationText(value: string | undefined): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}
