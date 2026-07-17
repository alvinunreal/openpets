import { CodexConversationTarget } from "./voice-conversation-codex.js";
import type { CompanionTarget, CompanionTargetHealth, CompanionTargetRequest, CompanionTargetResult } from "./companion-targets.js";

export class CodexCompanionTarget implements CompanionTarget {
  readonly id = "codex" as const;
  readonly #target: CodexConversationTarget;

  constructor(target: CodexConversationTarget = new CodexConversationTarget()) {
    this.#target = target;
  }

  async health(force = false): Promise<CompanionTargetHealth> {
    const health = await this.#target.health(force);
    return {
      ...health,
      targetId: "codex",
      configured: health.ready,
    };
  }

  async send(request: CompanionTargetRequest): Promise<CompanionTargetResult> {
    const result = await this.#target.sendText({
      text: request.prompt,
      sessionId: request.sessionId,
      signal: request.signal,
      onEvent: request.onEvent,
    });
    return result;
  }

  dispose(): void {
    this.#target.dispose();
  }
}
