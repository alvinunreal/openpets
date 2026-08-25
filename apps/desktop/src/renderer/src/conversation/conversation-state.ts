import { PET_ASSISTANT_CONVERSATION_ID, type ConversationActionItem, type ConversationEvent, type ConversationItem, type ConversationSnapshot } from "./conversation-types.js";

export function emptyConversationSnapshot(): ConversationSnapshot {
  return {
    conversationId: PET_ASSISTANT_CONVERSATION_ID,
    items: [],
    activity: "idle",
    lastSequence: 0,
    revision: 0,
  };
}

export function isConversationSnapshot(value: unknown): value is ConversationSnapshot {
  if (!isRecord(value) || value.conversationId !== PET_ASSISTANT_CONVERSATION_ID || !Array.isArray(value.items)) return false;
  if (!isActivity(value.activity) || !isNonNegativeInteger(value.lastSequence) || !isNonNegativeInteger(value.revision)) return false;
  if (value.activeTurnId !== undefined && typeof value.activeTurnId !== "string") return false;
  if (value.activeToolName !== undefined && typeof value.activeToolName !== "string") return false;
  if (value.terminal !== undefined && !isTerminal(value.terminal)) return false;
  return value.items.every(isConversationItem);
}

export function isConversationEvent(value: unknown): value is ConversationEvent {
  if (!isRecord(value) || value.type !== "snapshot" || typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1) return false;
  return isConversationSnapshot(value.snapshot);
}

export function applyConversationEvent(current: ConversationSnapshot, value: unknown): ConversationSnapshot {
  if (!isConversationEvent(value) || value.snapshot.revision <= current.revision) return current;
  return value.snapshot;
}

export function applyConversationSnapshot(current: ConversationSnapshot, value: unknown): ConversationSnapshot {
  if (!isConversationSnapshot(value)) return current;
  if (value.revision < current.revision || (value.revision === current.revision && value.lastSequence < current.lastSequence)) return current;
  return value;
}

function isConversationItem(value: unknown): value is ConversationItem {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.turnId !== "string") return false;
  if (value.kind === "message") {
    return (value.role === "user" || value.role === "assistant")
      && (value.source === "typed" || value.source === "voice")
      && typeof value.text === "string" && value.text.length > 0
      && (value.partial === undefined || typeof value.partial === "boolean");
  }
  if (value.kind !== "action" || typeof value.toolName !== "string" || !isActionStatus(value.status)) return false;
  return value.reason === undefined || typeof value.reason === "string";
}

function isTerminal(value: unknown): boolean {
  if (!isRecord(value) || typeof value.turnId !== "string") return false;
  if (value.status !== "completed" && value.status !== "cancelled" && value.status !== "failed") return false;
  return value.error === undefined || typeof value.error === "string";
}

function isActivity(value: unknown): value is ConversationSnapshot["activity"] {
  return value === "idle" || value === "thinking" || value === "acting" || value === "responding" || value === "cancelled" || value === "failed";
}

function isActionStatus(value: unknown): value is ConversationActionItem["status"] {
  return value === "pending" || value === "running" || value === "completed" || value === "unavailable" || value === "rejected" || value === "indeterminate";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
