import type { PetAssistantArchivedMessage } from "./pet-assistant-archive.js";

export type PetAssistantHistoryController = {
  getConversationHistory(): readonly PetAssistantArchivedMessage[];
  deleteConversationHistoryMessage(id: string): boolean;
  clearConversationHistory(): void;
};

export function getConversationHistory(controller: PetAssistantHistoryController | null): readonly PetAssistantArchivedMessage[] {
  if (!controller) throw new Error("Pet Assistant is still starting.");
  return controller.getConversationHistory();
}

export function deleteConversationHistoryMessage(controller: PetAssistantHistoryController | null, id: unknown): { readonly deleted: boolean } {
  if (!isConversationHistoryMessageId(id)) return { deleted: false };
  if (!controller) throw new Error("Pet Assistant is still starting.");
  return { deleted: controller.deleteConversationHistoryMessage(id) };
}

export function clearConversationHistory(controller: PetAssistantHistoryController | null): { readonly cleared: true } {
  if (!controller) throw new Error("Pet Assistant is still starting.");
  controller.clearConversationHistory();
  return { cleared: true };
}

export function isConversationHistoryMessageId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
