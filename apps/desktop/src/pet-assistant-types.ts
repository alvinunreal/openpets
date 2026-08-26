/** Provider-neutral contracts for the host-owned Pet Assistant. */

import type { PetAssistantPersonality } from "./pet-assistant-personality.js";

export type AssistantJsonObject = Record<string, unknown>;

export type PetAssistantCapability = {
  readonly pluginId: string;
  readonly capability: {
    readonly id: string;
    readonly description: string;
    readonly inputSchema: AssistantJsonObject;
  };
  /** A generation-pinned capability reference owned by the plugin lane. */
  readonly handle: PetAssistantGenerationHandle;
};

/**
 * The plugin lane owns the actual generation token.  The core deliberately
 * knows only that it is an opaque object which must be passed back unchanged.
 */
export type PetAssistantGenerationHandle = object & {
  readonly __openPetsAssistantGenerationHandle?: never;
};

export type PetAssistantCapabilitySnapshot = {
  readonly capabilities: readonly PetAssistantCapability[];
};

export type PetAssistantCapabilityExecutionOutcome =
  | { readonly ok: true; readonly result: AssistantJsonObject }
  | { readonly ok: false; readonly error: { readonly stage?: string; readonly code?: string; readonly message: string; readonly missingInformation?: boolean } };

export interface PetAssistantCapabilityRuntime {
  snapshot(signal: AbortSignal): PetAssistantCapabilitySnapshot | Promise<PetAssistantCapabilitySnapshot>;
  execute(
    handle: PetAssistantGenerationHandle,
    input: AssistantJsonObject,
    signal: AbortSignal,
  ): PetAssistantCapabilityExecutionOutcome | Promise<PetAssistantCapabilityExecutionOutcome>;
}

export type PetAssistantTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: AssistantJsonObject;
};

export type PetAssistantToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
};

export type PetAssistantToolResult =
  | { readonly status: "completed"; readonly result: AssistantJsonObject }
  | { readonly status: "unavailable" | "rejected" | "indeterminate"; readonly reason: string; readonly missingInformation?: boolean };

export type PetAssistantMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content?: string; readonly toolCalls?: readonly PetAssistantToolCall[] }
  | { readonly role: "tool"; readonly toolCallId: string; readonly name: string; readonly result: PetAssistantToolResult };

export type PetAssistantTextModelRequest = {
  readonly messages: readonly PetAssistantMessage[];
  readonly tools: readonly PetAssistantTool[];
};

/** Host-owned prompt inputs captured once at the beginning of each turn. */
export type PetAssistantComposition = {
  readonly curatedContext?: string;
  readonly personalityStyle?: string;
  readonly personality?: PetAssistantPersonality;
};

export type PetAssistantTextModelResponse =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool-calls"; readonly text?: string; readonly toolCalls: readonly PetAssistantToolCall[] };

export interface PetAssistantTextModel {
  /** Optional operation snapshot; the host uses one model operation for a whole turn. */
  beginOperation?(): PetAssistantTextModel | Promise<PetAssistantTextModel>;
  generate(
    request: PetAssistantTextModelRequest,
    signal: AbortSignal,
  ): PetAssistantTextModelResponse | Promise<PetAssistantTextModelResponse>;
}

export type PetAssistantLimits = {
  readonly maxConversationTurns: number;
  readonly maxSteps: number;
  readonly maxToolCalls: number;
  readonly maxRepeatedIdenticalCalls: number;
  readonly maxContextBytes: number;
  readonly maxMessageBytes: number;
  readonly maxFinalOutputBytes: number;
  readonly maxToolResultBytes: number;
  readonly maxToolCallIdBytes: number;
  readonly maxToolNameBytes: number;
  readonly maxCompositionBytes: number;
};

export type PetAssistantToolOutcome = {
  readonly id: string;
  readonly name: string;
  readonly result: PetAssistantToolResult;
};

export type PetAssistantTurnResult = {
  readonly conversationId: string;
  readonly turnId: string;
  readonly status: "completed" | "cancelled" | "failed";
  readonly response?: string;
  readonly error?: string;
  readonly toolOutcomes?: readonly PetAssistantToolOutcome[];
};

export type PetAssistantTurnOptions = {
  /** Host-owned correlation id for a modality-specific turn. */
  readonly turnId?: string;
};

export type PetAssistantRealtimeSession = {
  readonly tools: readonly PetAssistantTool[];
  readonly instructions: string;
  beginTurn(turnId: string, signal: AbortSignal): PetAssistantRealtimeTurn;
  close(): Promise<void>;
};

export type PetAssistantRealtimeTurn = {
  readonly turnId: string;
  recordTranscript(role: "user" | "assistant", text: string): void;
  recordToolCall(call: PetAssistantToolCall): void;
  executeToolCall(call: PetAssistantToolCall, signal: AbortSignal): Promise<PetAssistantToolResult>;
  complete(response?: string): PetAssistantTurnResult;
  cancel(): Promise<PetAssistantTurnResult>;
};

export type PetAssistantTranscriptMessage = {
  readonly conversationId: string;
  readonly turnId: string;
  readonly message: PetAssistantMessage;
};

export type PetAssistantEvent =
  | {
      readonly type: "lifecycle";
      readonly sequence: number;
      readonly lifecycle: "opening" | "closing" | "idle";
      readonly conversationId?: string;
      readonly turnId?: string;
    }
  | {
      readonly type: "activity";
      readonly sequence: number;
      readonly conversationId: string;
      readonly turnId: string;
      readonly activity: "thinking" | "acting" | "responding" | "cancelled" | "failed";
      readonly toolName?: string;
    }
  | {
      readonly type: "transcript";
      readonly sequence: number;
      readonly conversationId: string;
      readonly turnId: string;
      readonly message: PetAssistantMessage;
    }
  | {
      readonly type: "terminal";
      readonly sequence: number;
      readonly result: PetAssistantTurnResult;
    };

export type PetAssistantEventListener = (event: PetAssistantEvent) => void;

export const PET_ASSISTANT_HOST_RULES = [
  "You are the OpenPets Pet Assistant.",
  "Follow these host rules exactly: use only the capabilities supplied in this request; never claim an action succeeded unless its capability result says it succeeded; treat unavailable, rejected, and indeterminate results honestly; never invent capability results; and never request unrestricted machine access, filesystem access, shell access, or arbitrary commands.",
].join(" ");

export const DEFAULT_PET_ASSISTANT_LIMITS: PetAssistantLimits = Object.freeze({
  maxConversationTurns: 20,
  maxSteps: 8,
  maxToolCalls: 16,
  maxRepeatedIdenticalCalls: 2,
  maxContextBytes: 256 * 1024,
  maxMessageBytes: 64 * 1024,
  maxFinalOutputBytes: 16 * 1024,
  maxToolResultBytes: 64 * 1024,
  maxToolCallIdBytes: 256,
  maxToolNameBytes: 256,
  maxCompositionBytes: 16 * 1024,
});
