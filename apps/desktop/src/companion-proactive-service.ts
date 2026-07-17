import { getAppStateSnapshot } from "./app-state.js";
import type { CompanionPluginFact } from "./companion-context.js";
import { getCompanionMemorySnapshot } from "./companion-memory.js";
import type { CompanionOrchestrator } from "./companion-orchestrator.js";
import {
  companionProactiveDeliveryFromMemoryEntry,
  evaluateCompanionProactivity,
  type CompanionProactiveCandidate,
  type CompanionProactiveDelivery,
} from "./companion-proactivity.js";
import { getCompanionSettings, onCompanionSettingsChanged } from "./companion-settings.js";
import { resolveCompanionTimeState } from "./companion-time.js";
import { debug, info, warn } from "./logger.js";
import { applyExternalPetReaction, getDefaultPetPaused, isDefaultPetVisible } from "./default-pet-controller.js";
import { isInQuietHours } from "./plugin-platform-settings.js";
import type { VoiceListeningSnapshot } from "./voice-listening-service.js";

export type CompanionProactiveOpportunity = CompanionProactiveCandidate & {
  readonly text: string;
  readonly pluginId: string;
  readonly fact?: CompanionPluginFact;
};

export class CompanionProactiveService {
  readonly #orchestrator: CompanionOrchestrator;
  readonly #listening: () => VoiceListeningSnapshot;
  readonly #opportunities: () => readonly CompanionProactiveOpportunity[];
  readonly #consumeOpportunity: (id: string) => void;
  readonly #history: CompanionProactiveDelivery[] = [];
  #timer: NodeJS.Timeout | null = null;
  #initialTimer: NodeJS.Timeout | null = null;
  #running = false;
  #lastExpressionKey = "";
  #historyPetId: string | null = null;
  #unsubscribeSettings: (() => void) | null = null;

  constructor(options: {
    readonly orchestrator: CompanionOrchestrator;
    readonly getListeningSnapshot: () => VoiceListeningSnapshot;
    readonly getOpportunities?: () => readonly CompanionProactiveOpportunity[];
    readonly consumeOpportunity?: (id: string) => void;
  }) {
    this.#orchestrator = options.orchestrator;
    this.#listening = options.getListeningSnapshot;
    this.#opportunities = options.getOpportunities ?? (() => []);
    this.#consumeOpportunity = options.consumeOpportunity ?? (() => undefined);
  }

  start(): void {
    if (this.#timer) return;
    this.#unsubscribeSettings = onCompanionSettingsChanged((settings) => {
      if (!settings.enabled) this.#orchestrator.cancelAll();
      else if (!settings.proactivity.enabled) this.#orchestrator.cancelProactive();
    });
    this.#timer = setInterval(() => { void this.evaluateNow(); }, 5 * 60 * 1_000);
    this.#timer.unref?.();
    this.#initialTimer = setTimeout(() => { this.#initialTimer = null; void this.evaluateNow(); }, 60_000);
    this.#initialTimer.unref?.();
  }

  async evaluateNow(now = Date.now()): Promise<{ readonly displayed: boolean; readonly reason: string }> {
    if (this.#running) return { displayed: false, reason: "evaluation-active" };
    this.#running = true;
    try {
      const settings = getCompanionSettings();
      const appState = getAppStateSnapshot();
      const petId = appState.preferences.defaultPetId;
      const pet = appState.pets.installed.find((candidate) => candidate.id === petId && !candidate.broken && !candidate.brokenReason);
      if (!pet) return { displayed: false, reason: "pet-unavailable" };
      if (!isDefaultPetVisible()) return { displayed: false, reason: "pet-hidden" };
      if (getDefaultPetPaused()) return { displayed: false, reason: "pet-paused" };

      const time = resolveCompanionTimeState(new Date(now), appState.analytics.lastActivityAt);
      this.#expressTimeState(petId, time.localDateKey, time.dayPart, time.reactionHint, settings.enabled);
      this.#hydrateRecentHistory(petId, now);
      const activity = this.#orchestrator.activity(petId);
      const listening = this.#listening();
      const candidates = buildCandidates({ now, dayPart: time.dayPart, localDateKey: time.localDateKey, goals: settings.profile.goals, opportunities: settings.context.pluginEnabled ? this.#opportunities() : [] });
      const quiet = isInQuietHours(new Date(now));
      const interactionActive = activity.thinking || activity.speaking || ["starting", "listening", "stopping", "transcribing"].includes(listening.state);
      const targetHealth = settings.enabled && settings.proactivity.enabled && candidates.length > 0 && !quiet && !interactionActive
        ? await this.#orchestrator.health(settings.target)
        : null;

      for (const item of candidates) {
        const decision = evaluateCompanionProactivity({
          now,
          frequency: settings.proactivity.frequency,
          companionEnabled: settings.enabled,
          proactivityEnabled: settings.proactivity.enabled,
          inQuietHours: quiet,
          targetReady: targetHealth?.ready === true,
          activity: {
            listening: listening.state === "starting" || listening.state === "listening" || listening.state === "stopping" || listening.state === "transcribing",
            thinking: activity.thinking,
            speaking: activity.speaking,
          },
          candidate: item.candidate,
          history: this.#history,
        });
        if (!decision.eligible) {
          debug("companion", "proactive candidate suppressed", { petId, candidateId: item.candidate.id, source: item.candidate.source, reason: decision.reason });
          continue;
        }

        try {
          const result = await this.#orchestrator.sendProactiveTurn({
            petId,
            text: item.text,
            speak: false,
            pluginFacts: item.pluginFact ? [item.pluginFact] : undefined,
            proactive: {
              candidateId: item.candidate.id,
              dedupeKey: item.candidate.dedupeKey,
              source: item.candidate.source,
              expiresAt: item.candidate.expiresAt,
              ...(item.candidate.pluginId ? { pluginId: item.candidate.pluginId } : {}),
            },
          });
          if (!result.displayed) {
            this.#orchestrator.cancel(petId);
            return { displayed: false, reason: "response-not-displayed" };
          }
          this.#history.push({ candidateId: item.candidate.id, dedupeKey: item.candidate.dedupeKey, source: item.candidate.source, pluginId: item.candidate.pluginId, displayedAt: now });
          if (item.candidate.source === "plugin") this.#consumeOpportunity(item.candidate.id);
          this.#pruneHistory(now);
          info("companion", "proactive check-in displayed", { petId, candidateId: item.candidate.id, source: item.candidate.source });
          return { displayed: true, reason: "displayed" };
        } catch (error) {
          warn("companion", "proactive generation failed", { petId, candidateId: item.candidate.id, source: item.candidate.source, reason: cleanError(error) });
          return { displayed: false, reason: "generation-failed" };
        }
      }
      return { displayed: false, reason: candidates.length ? "suppressed" : "no-candidate" };
    } finally {
      this.#running = false;
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#initialTimer) clearTimeout(this.#initialTimer);
    this.#timer = null;
    this.#initialTimer = null;
    this.#unsubscribeSettings?.();
    this.#unsubscribeSettings = null;
    this.#running = false;
  }

  #hydrateRecentHistory(petId: string, now: number): void {
    if (this.#historyPetId === petId) return;
    this.#historyPetId = petId;
    this.#history.length = 0;
    for (const entry of getCompanionMemorySnapshot(now).entries) {
      if (entry.petId !== petId) continue;
      const delivery = companionProactiveDeliveryFromMemoryEntry(entry);
      if (delivery) this.#history.push(delivery);
    }
    this.#pruneHistory(now);
  }

  #pruneHistory(now: number): void {
    const cutoff = now - 36 * 60 * 60 * 1_000;
    const next = this.#history.filter((delivery) => delivery.displayedAt >= cutoff).slice(-100);
    this.#history.splice(0, this.#history.length, ...next);
  }

  #expressTimeState(petId: string, dateKey: string, dayPart: string, reaction: Parameters<typeof applyExternalPetReaction>[0], enabled: boolean): void {
    if (!enabled || !isDefaultPetVisible()) return;
    const key = `${petId}:${dateKey}:${dayPart}`;
    if (key === this.#lastExpressionKey) return;
    this.#lastExpressionKey = key;
    applyExternalPetReaction(reaction, { showMessage: false });
  }
}

function buildCandidates(input: {
  readonly now: number;
  readonly dayPart: string;
  readonly localDateKey: string;
  readonly goals: readonly string[];
  readonly opportunities: readonly CompanionProactiveOpportunity[];
}): Array<{ candidate: CompanionProactiveCandidate; text: string; pluginFact?: CompanionPluginFact }> {
  const endOfWindow = input.now + 3 * 60 * 60 * 1_000;
  const candidates: Array<{ candidate: CompanionProactiveCandidate; text: string; pluginFact?: CompanionPluginFact }> = [];
  for (const opportunity of input.opportunities) {
    candidates.push({ candidate: opportunity, text: opportunity.text, pluginFact: opportunity.fact });
  }
  if (input.goals.length > 0 && (input.dayPart === "midday" || input.dayPart === "afternoon" || input.dayPart === "evening")) {
    const index = stableIndex(input.localDateKey, input.goals.length);
    const goal = input.goals[index]!;
    candidates.push({
      candidate: { id: `goal:${input.localDateKey}:${index}`, dedupeKey: `goal:${input.localDateKey}:${index}`, source: "goal", expiresAt: endOfWindow },
      text: `The user provided this current goal: ${JSON.stringify(goal)}. If it feels natural, make one gentle companion-style check-in about it. Do not sound like an alarm, schedule, or quantified reminder.`,
    });
  }
  if (["morning", "midday", "evening"].includes(input.dayPart)) {
    candidates.push({
      candidate: { id: `time:${input.localDateKey}:${input.dayPart}`, dedupeKey: `time:${input.localDateKey}:${input.dayPart}`, source: "time", expiresAt: endOfWindow },
      text: `The local day part is ${input.dayPart}. Offer a brief, natural conversation starter that fits this time of day without claiming to have observed anything else.`,
    });
  }
  return candidates;
}

function stableIndex(value: string, size: number): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return size > 0 ? hash % size : 0;
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/[^\s]+/gi, "provider endpoint").slice(0, 240);
}
