import { debug, warn } from "./logger.js";
import { showInstalledPetHostBubble } from "./plugin-pet-registry.js";
import type { VoiceOutputService } from "./voice-output-service.js";
import { getVoiceSettings } from "./voice-settings.js";
import type { VoiceConversationHealth, VoiceConversationTarget } from "./voice-conversation-targets.js";

type PetConversation = { sessionId?: string; generation: number; active?: AbortController };

export class VoiceConversationManager {
  readonly #codex: VoiceConversationTarget;
  readonly #output: VoiceOutputService;
  readonly #sessions = new Map<string, PetConversation>();

  constructor(input: { codex: VoiceConversationTarget; output: VoiceOutputService }) {
    this.#codex = input.codex;
    this.#output = input.output;
  }

  health(force = false): Promise<VoiceConversationHealth> {
    return this.#codex.health(force);
  }

  async sendTranscript(petId: string, transcript: string): Promise<{ transcript: string; response?: string }> {
    if (getVoiceSettings().conversation.target !== "codex") return { transcript };
    const state = this.#state(petId);
    state.active?.abort();
    const controller = new AbortController();
    const generation = ++state.generation;
    state.active = controller;
    debug("app", "voice conversation request started", { petId, generation, target: "codex", resumed: Boolean(state.sessionId) });
    try {
      let result;
      try {
        result = await this.#codex.sendText({ text: transcript, sessionId: state.sessionId, signal: controller.signal });
      } catch (error) {
        const settings = getVoiceSettings();
        if (!state.sessionId || !settings.conversation.allowStatelessFallback || controller.signal.aborted) throw error;
        warn("app", "voice conversation resume failed; retrying stateless", { petId, reason: cleanError(error) });
        state.sessionId = undefined;
        result = await this.#codex.sendText({ text: transcript, signal: controller.signal });
      }
      if (state.generation !== generation || controller.signal.aborted) throw abortError();
      state.sessionId = result.sessionId;
      showInstalledPetHostBubble(petId, result.text);
      void this.#output.speak({ text: result.text, reason: "conversation", target: { kind: "installed-pet", petId }, overlapPolicy: "interrupt" })
        .then((speech) => { if (!speech.ok) warn("app", "voice conversation speech failed", { petId, attempts: speech.attempts.length }); })
        .catch((error) => warn("app", "voice conversation speech failed", { petId, reason: cleanError(error) }));
      debug("app", "voice conversation response completed", { petId, generation, target: "codex" });
      return { transcript, response: result.text };
    } finally {
      if (state.generation === generation) state.active = undefined;
    }
  }

  cancel(petId: string): void {
    const state = this.#sessions.get(petId);
    if (!state) return;
    state.generation += 1;
    state.active?.abort();
    state.active = undefined;
    try { this.#output.cancel({ kind: "installed-pet", petId }); } catch { /* pet may already be gone */ }
  }

  dispose(): void {
    for (const [petId] of this.#sessions) this.cancel(petId);
    this.#sessions.clear();
    this.#codex.dispose();
  }

  #state(petId: string): PetConversation {
    const current = this.#sessions.get(petId);
    if (current) return current;
    const created: PetConversation = { generation: 0 };
    this.#sessions.set(petId, created);
    return created;
  }
}

function abortError(): Error {
  const error = new Error("Conversation was cancelled.");
  error.name = "AbortError";
  return error;
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}
