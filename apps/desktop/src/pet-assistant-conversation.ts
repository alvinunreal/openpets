import type {
  PetAssistantEvent,
  PetAssistantMessage,
  PetAssistantTurnResult,
} from "./pet-assistant-types.js";
import type { PetAssistantService } from "./pet-assistant-service.js";

export const PET_ASSISTANT_CONVERSATION_ID = "openpets-control-center-current";
export const MAX_CONVERSATION_MESSAGE_BYTES = 64 * 1024;
export const MAX_CONVERSATION_ITEMS = 200;

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

export type PetAssistantConversationSnapshot = {
  readonly conversationId: string;
  readonly items: readonly ConversationItem[];
  readonly activity: ConversationActivity;
  readonly activeTurnId?: string;
  readonly activeToolName?: string;
  readonly terminal?: ConversationTerminalState;
  readonly lastSequence: number;
  readonly revision: number;
};

export type PetAssistantNormalizedVoiceTranscriptEvent = {
  /** Provider-neutral seam for #147; #148 does not create or own voice lifecycle. */
  readonly type: "transcript";
  readonly sequence: number;
  readonly conversationId: string;
  readonly turnId: string;
  readonly entryId: string;
  readonly speaker: "user" | "assistant";
  readonly text: string;
  readonly status: "partial" | "final";
};

export type PetAssistantConversationEvent = {
  readonly type: "snapshot";
  readonly sequence: number;
  readonly snapshot: PetAssistantConversationSnapshot;
};

export type PetAssistantConversationListener = (event: PetAssistantConversationEvent) => void;

export type PetAssistantConversationTurnResult = {
  readonly conversationId: string;
  readonly turnId: string;
  readonly status: "completed" | "cancelled" | "failed";
  readonly error?: string;
};

export function createEmptyPetAssistantConversationSnapshot(): PetAssistantConversationSnapshot {
  return freezeSnapshot({
    conversationId: PET_ASSISTANT_CONVERSATION_ID,
    items: [],
    activity: "idle",
    lastSequence: 0,
    revision: 0,
  });
}

export function validateConversationMessageInput(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("Conversation message must not be empty.");
  if (Buffer.byteLength(value, "utf8") > MAX_CONVERSATION_MESSAGE_BYTES) throw new Error("Conversation message is too large.");
  return value;
}

export class PetAssistantConversationProjection {
  #snapshot = createEmptyPetAssistantConversationSnapshot();
  #lastVoiceSequence = 0;
  readonly #listeners = new Set<PetAssistantConversationListener>();

  getSnapshot(): PetAssistantConversationSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: PetAssistantConversationListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  applyAssistantEvent(event: PetAssistantEvent): boolean {
    if (!isAssistantEventForConversation(event) || event.sequence <= this.#snapshot.lastSequence) return false;

    let items = [...this.#snapshot.items];
    let activity = this.#snapshot.activity;
    let activeTurnId = this.#snapshot.activeTurnId;
    let activeToolName = this.#snapshot.activeToolName;
    let terminal = this.#snapshot.terminal;

    if (event.type === "lifecycle") {
      if (event.lifecycle === "opening") {
        activeTurnId = event.turnId;
        activeToolName = undefined;
        terminal = undefined;
        activity = "idle";
      } else if (event.lifecycle === "idle" || event.lifecycle === "closing") {
        activeTurnId = undefined;
        activeToolName = undefined;
        if (event.lifecycle === "closing") activity = "idle";
      }
    } else if (event.type === "activity") {
      activity = event.activity;
      activeTurnId = event.turnId;
      activeToolName = event.toolName;
      if (event.activity === "acting" && event.toolName) {
        const actionIndex = findActionIndex(items, event.turnId, event.toolName);
        if (actionIndex >= 0) {
          const action = items[actionIndex] as ConversationActionItem;
          items[actionIndex] = { ...action, status: "running" };
        }
      }
      if (event.activity === "cancelled" || event.activity === "failed") activeToolName = undefined;
    } else if (event.type === "transcript") {
      const result = projectTranscript(items, event.conversationId, event.turnId, event.message, event.sequence);
      items = result.items;
    } else {
      if (event.result.conversationId !== PET_ASSISTANT_CONVERSATION_ID || event.result.turnId.trim() === "") return false;
      terminal = {
        turnId: event.result.turnId,
        status: event.result.status,
        ...(event.result.status === "failed" ? { error: "Pet Assistant turn failed." } : {}),
      };
      if (event.result.status === "cancelled") {
        const reason = displaySafeToolResultReason("indeterminate");
        items = items.map((item) => item.kind === "action"
          && item.turnId === event.result.turnId
          && (item.status === "pending" || item.status === "running")
          ? { ...item, status: "indeterminate", ...(reason ? { reason } : {}) }
          : item);
      }
      activeTurnId = undefined;
      activeToolName = undefined;
      activity = event.result.status === "cancelled" ? "cancelled" : event.result.status === "failed" ? "failed" : "idle";
    }

    this.#snapshot = freezeSnapshot({
      conversationId: PET_ASSISTANT_CONVERSATION_ID,
      items: retainRecentItems(items),
      activity,
      ...(activeTurnId ? { activeTurnId } : {}),
      ...(activeToolName ? { activeToolName } : {}),
      ...(terminal ? { terminal } : {}),
      lastSequence: event.sequence,
      revision: this.#snapshot.revision + 1,
    });
    this.#emit(event.sequence);
    return true;
  }

  /**
   * Consume only #147's future normalized transcript seam. Provider events and
   * voice lifecycle state stay owned by the voice conversation implementation.
   * Voice sequence values are monotonic within the normalized voice source and
   * are intentionally independent from the canonical assistant sequence.
   */
  applyNormalizedVoiceTranscript(event: PetAssistantNormalizedVoiceTranscriptEvent): boolean {
    if (!isNormalizedVoiceEvent(event) || event.conversationId !== PET_ASSISTANT_CONVERSATION_ID || event.sequence <= this.#lastVoiceSequence) return false;
    this.#lastVoiceSequence = event.sequence;
    const role = event.speaker;
    const matchingIndex = this.#snapshot.items.findIndex((item) => item.kind === "message" && item.turnId === event.turnId && item.role === role && (item.source === "voice" || role === "user"));
    const nextMessage: ConversationMessageItem = {
      kind: "message",
      id: `voice:${event.entryId}`,
      turnId: event.turnId,
      role,
      source: "voice",
      text: event.text,
      ...(event.status === "partial" ? { partial: true } : {}),
    };
    const items = [...this.#snapshot.items];
    if (matchingIndex >= 0) items[matchingIndex] = { ...nextMessage, id: (items[matchingIndex] as ConversationMessageItem).id };
    else items.push(nextMessage);
    this.#snapshot = freezeSnapshot({ ...this.#snapshot, items: retainRecentItems(items), revision: this.#snapshot.revision + 1 });
    this.#emit(event.sequence);
    return true;
  }

  dispose(): void {
    this.#listeners.clear();
  }

  #emit(sequence: number): void {
    const event: PetAssistantConversationEvent = { type: "snapshot", sequence, snapshot: this.#snapshot };
    for (const listener of [...this.#listeners]) {
      try { listener(event); } catch { /* presentation listeners are observational */ }
    }
  }
}

export class PetAssistantConversationController {
  readonly #service: PetAssistantService;
  readonly #projection: PetAssistantConversationProjection;
  readonly #unsubscribeService: () => void;
  #activeTypedTurn: AbortController | null = null;

  constructor(service: PetAssistantService, projection = new PetAssistantConversationProjection()) {
    this.#service = service;
    this.#projection = projection;
    this.#unsubscribeService = service.subscribe((event) => { this.#projection.applyAssistantEvent(event); });
  }

  getSnapshot(): PetAssistantConversationSnapshot { return this.#projection.getSnapshot(); }

  subscribe(listener: PetAssistantConversationListener): () => void { return this.#projection.subscribe(listener); }

  async sendTypedMessage(text: unknown): Promise<PetAssistantConversationTurnResult> {
    const message = validateConversationMessageInput(text);
    if (this.#activeTypedTurn) throw new Error("A typed conversation turn is already active.");
    const controller = new AbortController();
    this.#activeTypedTurn = controller;
    try {
      return sanitizeTurnResult(await this.#service.startTurn(PET_ASSISTANT_CONVERSATION_ID, message, controller.signal));
    } finally {
      if (this.#activeTypedTurn === controller) this.#activeTypedTurn = null;
    }
  }

  cancelTypedTurn(): boolean {
    if (!this.#activeTypedTurn) return false;
    this.#activeTypedTurn.abort();
    return true;
  }

  applyNormalizedVoiceTranscript(event: PetAssistantNormalizedVoiceTranscriptEvent): boolean {
    return this.#projection.applyNormalizedVoiceTranscript(event);
  }

  dispose(): void {
    this.#activeTypedTurn?.abort();
    this.#activeTypedTurn = null;
    this.#unsubscribeService();
    this.#projection.dispose();
  }
}

function projectTranscript(
  currentItems: readonly ConversationItem[],
  conversationId: string,
  turnId: string,
  message: PetAssistantMessage,
  sequence: number,
): { readonly items: ConversationItem[] } {
  if (conversationId !== PET_ASSISTANT_CONVERSATION_ID || turnId.trim() === "") return { items: [...currentItems] };
  const items = [...currentItems];
  if (message.role === "user" || message.role === "assistant") {
    if (typeof message.content === "string" && message.content.trim() !== "") {
      const existingVoice = items.findIndex((item) => item.kind === "message" && item.turnId === turnId && item.role === message.role && item.source === "voice");
      const nextMessage: ConversationMessageItem = {
        kind: "message",
        id: `message:${turnId}:${sequence}`,
        turnId,
        role: message.role,
        source: existingVoice >= 0 ? "voice" : "typed",
        text: safeDisplayText(message.content),
      };
      if (existingVoice >= 0) items[existingVoice] = { ...nextMessage, id: (items[existingVoice] as ConversationMessageItem).id };
      else items.push(nextMessage);
    }
    for (const call of message.role === "assistant" ? message.toolCalls ?? [] : []) {
      if (!isSafeToolCall(call.id, call.name) || items.some((item) => item.kind === "action" && item.id === call.id)) continue;
      items.push({ kind: "action", id: call.id, turnId, toolName: safeDisplayText(call.name), status: "pending" });
    }
  } else if (message.role === "tool" && isToolResultStatus(message.result.status)) {
    const actionIndex = items.findIndex((item) => item.kind === "action" && item.id === message.toolCallId);
    const reason = displaySafeToolResultReason(message.result.status);
    if (actionIndex >= 0) {
      const action = items[actionIndex] as ConversationActionItem;
      items[actionIndex] = { ...action, status: message.result.status, ...(reason ? { reason } : {}) };
    }
  }
  return { items };
}

function findActionIndex(items: readonly ConversationItem[], turnId: string, toolName: string): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "action" && item.turnId === turnId && item.toolName === toolName && (item.status === "pending" || item.status === "running")) return index;
  }
  return -1;
}

function isAssistantEventForConversation(event: PetAssistantEvent): boolean {
  if (!event || typeof event !== "object" || !Number.isSafeInteger(event.sequence) || event.sequence < 1) return false;
  if (event.type === "transcript" || event.type === "activity") return event.conversationId === PET_ASSISTANT_CONVERSATION_ID;
  if (event.type === "lifecycle") return event.conversationId === undefined || event.conversationId === PET_ASSISTANT_CONVERSATION_ID;
  return event.type === "terminal" && event.result.conversationId === PET_ASSISTANT_CONVERSATION_ID;
}

function isNormalizedVoiceEvent(event: PetAssistantNormalizedVoiceTranscriptEvent): boolean {
  return Boolean(event && typeof event === "object"
    && event.type === "transcript"
    && Number.isSafeInteger(event.sequence) && event.sequence > 0
    && typeof event.conversationId === "string"
    && typeof event.turnId === "string" && event.turnId.trim() !== ""
    && typeof event.entryId === "string" && event.entryId.trim() !== ""
    && (event.speaker === "user" || event.speaker === "assistant")
    && typeof event.text === "string" && event.text.trim() !== ""
    && (event.status === "partial" || event.status === "final")
    && Buffer.byteLength(event.text, "utf8") <= MAX_CONVERSATION_MESSAGE_BYTES);
}

function isSafeToolCall(id: unknown, name: unknown): id is string {
  return typeof id === "string" && id.trim() !== "" && typeof name === "string" && name.trim() !== "" && id.length <= 256 && name.length <= 256;
}

function isToolResultStatus(value: unknown): value is ConversationActionStatus {
  return value === "completed" || value === "unavailable" || value === "rejected" || value === "indeterminate";
}

function safeDisplayText(value: string): string {
  return value.length > MAX_CONVERSATION_MESSAGE_BYTES ? value.slice(0, MAX_CONVERSATION_MESSAGE_BYTES) : value;
}

function displaySafeToolResultReason(status: ConversationActionStatus): string | undefined {
  if (status === "unavailable") return "Capability is unavailable.";
  if (status === "rejected") return "Capability request was rejected.";
  if (status === "indeterminate") return "Capability result was unavailable.";
  return undefined;
}

function retainRecentItems(items: readonly ConversationItem[]): ConversationItem[] {
  return items.length > MAX_CONVERSATION_ITEMS ? items.slice(-MAX_CONVERSATION_ITEMS) : [...items];
}

function sanitizeTurnResult(result: PetAssistantTurnResult): PetAssistantConversationTurnResult {
  return {
    conversationId: PET_ASSISTANT_CONVERSATION_ID,
    turnId: result.turnId,
    status: result.status,
    ...(result.status === "failed" ? { error: "Pet Assistant turn failed." } : {}),
  };
}

function freezeSnapshot(snapshot: PetAssistantConversationSnapshot): PetAssistantConversationSnapshot {
  return Object.freeze({
    ...snapshot,
    items: Object.freeze(snapshot.items.map((item) => Object.freeze({ ...item }))),
  });
}
