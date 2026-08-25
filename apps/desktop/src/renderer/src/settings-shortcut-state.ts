import type { VoiceAssistantShortcutStatus } from "./conversation/conversation-types.js";

export type ShortcutSaveResponse = {
  readonly preferences: { readonly voiceAssistantShortcut?: string };
  readonly voiceAssistantShortcutStatus?: {
    readonly accelerator: string;
    readonly status: VoiceAssistantShortcutStatus;
    readonly reason?: string;
  };
};

export type ShortcutSaveOutcome = {
  readonly accepted: boolean;
  readonly savedAccelerator: string;
  readonly reason?: string;
};

export function resolveShortcutSaveOutcome(requested: string, response: ShortcutSaveResponse): ShortcutSaveOutcome {
  const savedAccelerator = response.preferences.voiceAssistantShortcut ?? "";
  const status = response.voiceAssistantShortcutStatus;
  const accepted = savedAccelerator === requested
    && (!status || (status.status === "registered" && status.accelerator === requested && !status.reason));
  if (accepted) return { accepted: true, savedAccelerator };
  return {
    accepted: false,
    savedAccelerator,
    reason: status?.reason ?? `Pet Talk shortcut was not activated (${status?.status ?? "unknown"}).`,
  };
}
