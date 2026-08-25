import type { LocalConversationHistoryMessage } from "./conversation-types.js";

export function isLocalConversationHistory(value: unknown): value is readonly LocalConversationHistoryMessage[] {
  return Array.isArray(value) && value.every(isLocalConversationHistoryMessage);
}

export function removeLocalConversationHistoryMessage(
  history: readonly LocalConversationHistoryMessage[],
  id: string,
): readonly LocalConversationHistoryMessage[] {
  return history.filter((message) => message.id !== id);
}

export function clearLocalConversationHistory(): readonly LocalConversationHistoryMessage[] {
  return [];
}

function isLocalConversationHistoryMessage(value: unknown): value is LocalConversationHistoryMessage {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && value.id.trim().length > 0
    && value.id.length <= 256
    && value.conversationId === "openpets-control-center-current"
    && typeof value.turnId === "string"
    && value.turnId.trim().length > 0
    && typeof value.role === "string"
    && (value.role === "user" || value.role === "assistant")
    && typeof value.text === "string"
    && value.text.trim().length > 0
    && typeof value.createdAt === "number"
    && Number.isSafeInteger(value.createdAt)
    && value.createdAt > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
