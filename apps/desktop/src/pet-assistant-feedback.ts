import type { OpenPetsReaction } from "./local-ipc-protocol.js";
import type { PetAssistantEvent } from "./pet-assistant-types.js";
import type { VoiceAssistantSessionEvent } from "./voice-assistant-session.js";

export type PetAssistantFeedbackState = "listening" | "thinking" | "acting" | "speaking" | "missing-information" | "success" | "failure";

export type PetAssistantFeedback = {
  readonly state: PetAssistantFeedbackState;
  readonly reaction: OpenPetsReaction;
  readonly message?: string;
};

export type PetAssistantFeedbackTarget = {
  setActivity(reaction: OpenPetsReaction | null): void;
  showReaction(reaction: OpenPetsReaction, message?: string): void;
  setStatus(reaction: OpenPetsReaction | null): void;
};

export function feedbackForVoiceActivity(activity: "listening" | "thinking" | "acting" | "speaking"): PetAssistantFeedback {
  if (activity === "listening") return { state: "listening", reaction: "waiting" };
  if (activity === "acting") return { state: "acting", reaction: "working" };
  if (activity === "speaking") return { state: "speaking", reaction: "running" };
  return { state: "thinking", reaction: "thinking" };
}

export function feedbackForAssistantEvent(event: PetAssistantEvent): PetAssistantFeedback | null {
  if (event.type === "activity") {
    if (event.activity === "thinking" || event.activity === "responding") return { state: "thinking", reaction: "thinking" };
    if (event.activity === "acting") return { state: "acting", reaction: "working" };
    if (event.activity === "failed") return null;
    return null;
  }
  if (event.type !== "terminal") return null;
  if (event.result.status === "cancelled") return null;
  if (event.result.status === "failed") return { state: "failure", reaction: "error", message: "I couldn't complete that." };
  const outcomes = event.result.toolOutcomes ?? [];
  if (outcomes.some((outcome) => outcome.result.status !== "completed" && outcome.result.missingInformation === true)) {
    return { state: "missing-information", reaction: "waiting", message: "I need more information to finish that." };
  }
  if (outcomes.some((outcome) => outcome.result.status !== "completed")) {
    return { state: "failure", reaction: "error", message: "I couldn't complete that." };
  }
  return { state: "success", reaction: "success", message: "Done." };
}

export function applyPetAssistantFeedback(target: PetAssistantFeedbackTarget, feedback: PetAssistantFeedback | null): void {
  if (!feedback) return;
  if (feedback.state === "listening" || feedback.state === "thinking" || feedback.state === "acting" || feedback.state === "speaking") {
    target.setActivity(feedback.reaction);
    return;
  }
  target.setActivity(null);
  target.setStatus(feedback.reaction);
  target.showReaction(feedback.reaction, feedback.message);
}

/** One host-owned reducer for typed canonical events and the active voice lane. */
export class PetAssistantFeedbackReducer {
  readonly #target: PetAssistantFeedbackTarget;
  readonly #voiceTurns = new Set<string>();
  readonly #settledVoiceTurns = new Set<string>();
  readonly #pendingVoiceTerminal = new Map<string, PetAssistantFeedback | null>();
  readonly #voiceErrors = new Set<string>();
  static readonly #maxTrackedVoiceTurns = 64;

  constructor(target: PetAssistantFeedbackTarget) {
    this.#target = target;
  }

  applyAssistantEvent(event: PetAssistantEvent): void {
    if (event.type === "activity" && this.#voiceTurns.has(event.turnId)) {
      if (event.activity === "cancelled") this.#target.setActivity(null);
      else if (event.activity === "failed") this.#voiceErrors.add(event.turnId);
      else applyPetAssistantFeedback(this.#target, feedbackForAssistantEvent(event));
      return;
    }
    if (event.type === "terminal" && this.#voiceTurns.has(event.result.turnId)) {
      if (this.#settledVoiceTurns.has(event.result.turnId)) return;
      this.#pendingVoiceTerminal.set(event.result.turnId, feedbackForAssistantEvent(event));
      return;
    }
    if (event.type === "activity" && event.activity === "cancelled") {
      this.#target.setActivity(null);
      return;
    }
    if (event.type === "terminal" && event.result.status === "cancelled") {
      this.#target.setActivity(null);
      return;
    }
    applyPetAssistantFeedback(this.#target, feedbackForAssistantEvent(event));
  }

  applyVoiceEvent(event: VoiceAssistantSessionEvent): void {
    if (event.type === "snapshot") {
      const turnId = event.snapshot.turnId;
      if (turnId) {
        this.#remember(this.#voiceTurns, turnId);
        if (this.#settledVoiceTurns.has(turnId)) {
          this.#target.setActivity(null);
          return;
        }
      }
      if (event.snapshot.activity) applyPetAssistantFeedback(this.#target, feedbackForVoiceActivity(event.snapshot.activity));
      else this.#target.setActivity(null);
      return;
    }
    if (event.type === "turn-settled") {
      if (this.#settledVoiceTurns.has(event.turnId)) return;
      this.#remember(this.#settledVoiceTurns, event.turnId);
      const pending = this.#pendingVoiceTerminal.get(event.turnId);
      this.#pendingVoiceTerminal.delete(event.turnId);
      const hadVoiceError = this.#voiceErrors.delete(event.turnId);
      const failed = event.outcome === "failed" || hadVoiceError;
      if (event.outcome === "cancelled") {
        this.#target.setActivity(null);
      } else {
        applyPetAssistantFeedback(this.#target, failed ? { state: "failure", reaction: "error", message: "I couldn't complete that." } : (pending ?? null));
      }
      return;
    }
    if (event.type === "ended" || event.type === "interrupted") {
      if (event.type === "ended") {
        for (const turnId of this.#voiceTurns) this.#remember(this.#settledVoiceTurns, turnId);
        this.#pendingVoiceTerminal.clear();
        this.#voiceErrors.clear();
      }
      if (event.type === "interrupted" && event.turnId) {
        this.#pendingVoiceTerminal.delete(event.turnId);
        this.#voiceErrors.delete(event.turnId);
        this.#remember(this.#settledVoiceTurns, event.turnId);
      }
      this.#target.setActivity(null);
      return;
    }
    if (event.type === "error") {
      if (event.turnId && this.#voiceTurns.has(event.turnId)) {
        this.#voiceErrors.add(event.turnId);
        this.#target.setActivity(null);
        return;
      }
      this.#target.setActivity(null);
    }
  }

  clear(): void {
    this.#target.setActivity(null);
    this.#voiceTurns.clear();
    this.#settledVoiceTurns.clear();
    this.#pendingVoiceTerminal.clear();
    this.#voiceErrors.clear();
  }

  #remember(set: Set<string>, value: string): void {
    set.add(value);
    while (set.size > PetAssistantFeedbackReducer.#maxTrackedVoiceTurns) set.delete(set.values().next().value!);
  }
}
