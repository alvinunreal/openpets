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
