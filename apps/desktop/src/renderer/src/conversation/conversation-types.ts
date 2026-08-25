export const PET_ASSISTANT_CONVERSATION_ID = "openpets-control-center-current";

export type ConversationActivity = "idle" | "thinking" | "acting" | "responding" | "cancelled" | "failed";
export type ConversationActionStatus = "pending" | "running" | "completed" | "unavailable" | "rejected" | "indeterminate";

export type ConversationMessageItem = {
  readonly kind: "message";
  readonly id: string;
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly source: "typed" | "voice";
  readonly text: string;
  readonly partial?: boolean;
};

export type ConversationActionItem = {
  readonly kind: "action";
  readonly id: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly status: ConversationActionStatus;
  readonly reason?: string;
};

export type ConversationItem = ConversationMessageItem | ConversationActionItem;

export type ConversationTerminalState = {
  readonly turnId: string;
  readonly status: "completed" | "cancelled" | "failed";
  readonly error?: string;
};

export type ConversationSnapshot = {
  readonly conversationId: string;
  readonly items: readonly ConversationItem[];
  readonly activity: ConversationActivity;
  readonly activeTurnId?: string;
  readonly activeToolName?: string;
  readonly terminal?: ConversationTerminalState;
  readonly lastSequence: number;
  readonly revision: number;
};

export type ConversationEvent = {
  readonly type: "snapshot";
  readonly sequence: number;
  readonly snapshot: ConversationSnapshot;
};

export type VoiceAssistantActivity = "listening" | "thinking" | "acting" | "speaking";
export type VoiceAssistantSessionStatus = "idle" | "active" | "muted" | "paused" | "ending" | "ended";
export type VoiceAssistantErrorScope = "input" | "assistant" | "synthesis" | "playback" | "session";
export type VoiceAssistantShortcutStatus = "registered" | "conflict" | "unavailable" | "invalid";

export type VoiceAssistantSessionSnapshot = {
  readonly status: VoiceAssistantSessionStatus;
  readonly activity: VoiceAssistantActivity | null;
  readonly muted: boolean;
  readonly conversationId: string;
  readonly generation: number;
  readonly turnId: string | null;
  readonly userTranscript: string | null;
  readonly assistantTranscript: string | null;
  readonly interruptionCount: number;
  readonly error: { readonly scope: VoiceAssistantErrorScope; readonly message: string } | null;
  readonly shortcut: string;
  readonly shortcutStatus: VoiceAssistantShortcutStatus;
  readonly shortcutReason: string | null;
};

export type VoiceAssistantTalkEvent =
  | { readonly type: "snapshot"; readonly sequence: number; readonly snapshot: VoiceAssistantSessionSnapshot }
  | { readonly type: "transcript"; readonly sequence: number; readonly turnId: string; readonly speaker: "user" | "assistant"; readonly kind: "partial" | "final"; readonly text: string }
  | { readonly type: "error"; readonly sequence: number; readonly scope: VoiceAssistantErrorScope; readonly message: string; readonly turnId?: string }
  | { readonly type: "interrupted"; readonly sequence: number; readonly generation: number; readonly turnId: string | null }
  | { readonly type: "turn-settled"; readonly sequence: number; readonly turnId: string; readonly outcome: "completed" | "cancelled" | "failed" }
  | { readonly type: "ended"; readonly sequence: number; readonly reason: "ended" | "shutdown" };

export function createVoiceSnapshotOrdering(): {
  beginInitialRequest(): number;
  noteEvent(): void;
  shouldApplyInitialSnapshot(requestVersion: number): boolean;
} {
  let version = 0;
  return {
    beginInitialRequest: () => version,
    noteEvent: () => { version += 1; },
    shouldApplyInitialSnapshot: (requestVersion) => requestVersion === 0 && version === 0,
  };
}

export function voiceStatusLabel(status: VoiceAssistantSessionStatus, activity: VoiceAssistantActivity | null, muted: boolean): string {
  if (status === "ending") return "Ending…";
  if (muted) return "Voice Muted";
  if (activity === "listening") return "Listening...";
  if (activity === "thinking") return "Thinking...";
  if (activity === "acting") return "Working...";
  if (activity === "speaking") return "Speaking...";
  if (status === "active") return "Active";
  if (status === "paused") return "Paused";
  if (status === "ended") return "Ended";
  return "Ready";
}

export function voiceBadgeClass(status: VoiceAssistantSessionStatus, activity: VoiceAssistantActivity | null, muted: boolean): string {
  if (status === "ending") return "voice-badge-neutral";
  if (muted) return "voice-badge-muted";
  if (activity === "speaking") return "voice-badge-speaking";
  if (activity === "listening" || activity === "thinking" || activity === "acting" || status === "active") return "voice-badge-active";
  return "voice-badge-neutral";
}
