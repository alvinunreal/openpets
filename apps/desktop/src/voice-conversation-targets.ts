export type VoiceConversationHealth = {
  readonly targetId: "codex";
  readonly checkedAt: number;
  readonly ready: boolean;
  readonly method: string;
  readonly version?: string;
  readonly reason?: string;
};

export type VoiceConversationEvent =
  | { readonly type: "session"; readonly sessionId: string }
  | { readonly type: "text"; readonly text: string; readonly final: boolean }
  | { readonly type: "error"; readonly message: string };

export type VoiceConversationRequest = {
  readonly text: string;
  readonly sessionId?: string;
  readonly signal: AbortSignal;
  readonly onEvent?: (event: VoiceConversationEvent) => void;
};

export type VoiceConversationResult = { readonly sessionId: string; readonly text: string };

export interface VoiceConversationTarget {
  readonly id: "codex";
  health(force?: boolean): Promise<VoiceConversationHealth>;
  sendText(request: VoiceConversationRequest): Promise<VoiceConversationResult>;
  dispose(): void;
}
