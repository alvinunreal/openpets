import type { OpenPetsReaction } from "./local-ipc-protocol.js";

export type ComposablePetTransientDisplay = {
  readonly reaction?: OpenPetsReaction;
  readonly message?: string;
  readonly reactionMessage?: string;
  readonly suppressReactionMessage?: boolean;
  readonly dismissToken?: string;
  readonly mediaPath?: string;
  readonly displayDurationMs?: number;
  readonly clickUrl?: string;
};

/** Overlay voice animation without taking ownership of another display's content. */
export function composeVoiceActivityDisplay(external: ComposablePetTransientDisplay | null, voiceReaction: OpenPetsReaction | null, terminalReaction: OpenPetsReaction | null = null): ComposablePetTransientDisplay | null {
  const reaction = terminalReaction ?? voiceReaction;
  if (!reaction) return external;
  return {
    ...(external ?? {}),
    reaction,
    suppressReactionMessage: true,
  };
}

export function composeVoiceActivityBadge(external: OpenPetsReaction | null, voiceReaction: OpenPetsReaction | null, terminalReaction: OpenPetsReaction | null = null): OpenPetsReaction | null {
  return terminalReaction ?? voiceReaction ?? external;
}
