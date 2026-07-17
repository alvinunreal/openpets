import type { BrowserWindow } from "electron";

import { getAppStateSnapshot } from "./app-state.js";
import { getDefaultPetWindowForPlugins } from "./default-pet-controller.js";
import { debug, warn } from "./logger.js";
import { playPetWindowVoiceAudio, speakPetWindowVoiceTts, stopPetWindowVoice } from "./pet-window.js";
import { resolveInstalledPetVoiceTarget, resolvePluginPetVoiceTarget } from "./plugin-pet-registry.js";
import type { VoiceProviderRegistry } from "./voice-provider-registry.js";
import { sanitizeProviderError } from "./voice-provider.js";
import { getVoiceSettings, resolveVoiceAttemptPlan, resolveVoiceSelection, type VoiceOverlapPolicy, type VoiceProviderId, type VoiceSelection } from "./voice-settings.js";

export type VoiceTarget =
  | { readonly kind: "default" }
  | { readonly kind: "plugin-pet"; readonly pluginId: string; readonly petHandleId: string }
  | { readonly kind: "installed-pet"; readonly petId: string }
  | { readonly kind: "window"; readonly petId: string; readonly window: BrowserWindow };

export type VoiceSpeakRequest = {
  readonly text: string;
  readonly target: VoiceTarget;
  readonly reason: "bubble-narration" | "plugin" | "settings-test" | "conversation";
  readonly requestedVoiceId?: string;
  readonly requestedProviderId?: VoiceProviderId;
  readonly requestedModel?: string;
  readonly requestedRate?: number;
  readonly overlapPolicy?: VoiceOverlapPolicy;
};

export type VoiceSpeakAttempt = {
  readonly providerId: VoiceProviderId;
  readonly voiceId?: string;
  readonly model?: string;
  readonly started: boolean;
  readonly fallbackReason?: string;
  readonly errorType?: "configuration" | "authentication" | "reachability" | "capability" | "synthesis" | "target";
  readonly message?: string;
};

export type VoiceSpeakResult = { readonly ok: boolean; readonly attempts: VoiceSpeakAttempt[] };

type ResolvedTarget = { readonly key: string; readonly petId: string; readonly window: BrowserWindow };
type QueuedJob = {
  readonly target: ResolvedTarget;
  readonly request: VoiceSpeakRequest;
  readonly selection: VoiceSelection;
  readonly resolve: (result: VoiceSpeakResult) => void;
};
type ActiveJob = { readonly generation: number; readonly controller: AbortController; readonly window: BrowserWindow };
type PetVoiceState = { generation: number; active?: ActiveJob; queue: QueuedJob[] };

export class VoiceOutputService {
  readonly #providers: VoiceProviderRegistry;
  readonly #states = new Map<string, PetVoiceState>();

  constructor(providers: VoiceProviderRegistry) {
    this.#providers = providers;
  }

  async speak(request: VoiceSpeakRequest): Promise<VoiceSpeakResult> {
    const text = request.text.trim();
    if (!text || text.length > 4_000) return { ok: false, attempts: [{ providerId: "system", started: false, errorType: "configuration", message: "Speech text must contain 1–4000 characters." }] };
    const normalizedRequest: VoiceSpeakRequest = { ...request, text };
    let target: ResolvedTarget;
    try {
      target = this.#resolveTarget(normalizedRequest.target);
    } catch (error) {
      return { ok: false, attempts: [{ providerId: "system", started: false, errorType: "target", message: sanitizeProviderError(error) }] };
    }

    const baseSelection = resolveVoiceSelection(getVoiceSettings(), target.petId);
    const providerId = normalizedRequest.requestedProviderId ?? baseSelection.providerId;
    const providerChanged = normalizedRequest.requestedProviderId !== undefined && providerId !== baseSelection.providerId;
    const selection: VoiceSelection = {
      ...baseSelection,
      providerId,
      voiceId: normalizedRequest.requestedVoiceId ?? (providerChanged ? undefined : baseSelection.voiceId),
      model: normalizedRequest.requestedModel ?? (providerChanged ? undefined : baseSelection.model),
    };
    const policy = normalizedRequest.overlapPolicy ?? selection.overlapPolicy;
    const state = this.#state(target.key);
    if (state.active) {
      if (policy === "ignore") return { ok: false, attempts: [{ providerId: selection.providerId, started: false, errorType: "capability", message: "Voice output is already active for this pet." }] };
      if (policy === "queue") {
        return new Promise((resolve) => {
          if (state.queue.length >= 5) state.queue.shift()?.resolve({ ok: false, attempts: [{ providerId: selection.providerId, started: false, errorType: "capability", message: "Voice queue limit reached." }] });
          state.queue.push({ target, request: normalizedRequest, selection, resolve });
        });
      }
      this.#cancelState(target.key, state);
    }
    return this.#run(target, normalizedRequest, selection, state);
  }

  cancel(target: VoiceTarget): void {
    const resolved = this.#resolveTarget(target);
    this.#cancelState(resolved.key, this.#state(resolved.key));
  }

  cancelAll(): void {
    for (const [key, state] of this.#states) this.#cancelState(key, state);
    this.#states.clear();
  }

  async #run(target: ResolvedTarget, request: VoiceSpeakRequest, selection: VoiceSelection, state: PetVoiceState): Promise<VoiceSpeakResult> {
    const generation = ++state.generation;
    const controller = new AbortController();
    state.active = { generation, controller, window: target.window };
    const attempts: VoiceSpeakAttempt[] = [];
    const chosenVoice = request.requestedVoiceId ?? selection.voiceId;
    const attemptsToRun = resolveVoiceAttemptPlan(selection, chosenVoice, request.reason !== "settings-test");

    try {
      for (let index = 0; index < attemptsToRun.length; index += 1) {
        const { providerId, useProviderDefault, fallbackReason } = attemptsToRun[index];
        try {
          const result = await this.#providers.synthesize(providerId, {
            text: request.text,
            voiceId: useProviderDefault ? undefined : chosenVoice,
            model: providerId === selection.providerId ? selection.model : undefined,
            rate: request.requestedRate,
            useProviderDefault,
            signal: controller.signal,
          }, target.window);
          if (!this.#isCurrent(target.key, generation) || controller.signal.aborted) return { ok: false, attempts };
          attempts.push({ providerId, voiceId: useProviderDefault ? undefined : chosenVoice, model: selection.model, started: true, fallbackReason });
          debug("pet.window", "voice output started", { providerId, petId: target.petId, reason: request.reason, fallback: index > 0 });
          if (result.kind === "system") await speakPetWindowVoiceTts(target.window, result.text, { voice: result.voiceId, rate: result.rate }, generation);
          else await playPetWindowVoiceAudio(target.window, { bytes: result.bytes, mimeType: result.mimeType, volume: 1 }, generation);
          if (!this.#isCurrent(target.key, generation)) return { ok: false, attempts };
          return { ok: true, attempts };
        } catch (error) {
          if (controller.signal.aborted) return { ok: false, attempts };
          const message = sanitizeProviderError(error);
          attempts.push({ providerId, voiceId: useProviderDefault ? undefined : chosenVoice, model: selection.model, started: false, fallbackReason, errorType: "synthesis", message });
          warn("pet.window", "voice provider failed", { providerId, petId: target.petId, reason: request.reason, message });
        }
      }
      return { ok: false, attempts };
    } finally {
      if (this.#isCurrent(target.key, generation)) {
        state.active = undefined;
        const next = state.queue.shift();
        if (next) {
          void this.#run(next.target, next.request, next.selection, state).then(next.resolve);
        } else if (!state.active) {
          this.#states.delete(target.key);
        }
      }
    }
  }

  #cancelState(key: string, state: PetVoiceState): void {
    state.generation += 1;
    state.active?.controller.abort();
    if (state.active?.window && !state.active.window.isDestroyed()) stopPetWindowVoice(state.active.window);
    state.active = undefined;
    for (const queued of state.queue.splice(0)) queued.resolve({ ok: false, attempts: [] });
    this.#states.delete(key);
  }

  #isCurrent(key: string, generation: number): boolean {
    return this.#states.get(key)?.active?.generation === generation;
  }

  #state(key: string): PetVoiceState {
    const existing = this.#states.get(key);
    if (existing) return existing;
    const state: PetVoiceState = { generation: 0, queue: [] };
    this.#states.set(key, state);
    return state;
  }

  #resolveTarget(target: VoiceTarget): ResolvedTarget {
    if (target.kind === "window") {
      if (target.window.isDestroyed()) throw new Error("Target pet is not available.");
      return { key: `${target.petId}:${target.window.id}`, petId: target.petId, window: target.window };
    }
    if (target.kind === "plugin-pet") return resolvePluginPetVoiceTarget(target.pluginId, target.petHandleId);
    if (target.kind === "installed-pet") return resolveInstalledPetVoiceTarget(target.petId);
    const window = getDefaultPetWindowForPlugins();
    if (!window || window.isDestroyed()) throw new Error("Show the default pet before speaking.");
    const petId = getAppStateSnapshot().preferences.defaultPetId;
    return { key: `${petId}:${window.id}`, petId, window };
  }
}
