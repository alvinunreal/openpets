import { buildCompanionContext, type CompanionPluginFact } from "./companion-context.js";
import {
  commitCompanionAssistantTurn,
  commitCompanionProactiveTurn,
  commitCompanionUserTurn,
  selectRecentCompanionMemory,
  type CompanionProactiveMemoryMetadata,
} from "./companion-memory.js";
import { getCompanionSettings } from "./companion-settings.js";
import type { CompanionTarget, CompanionTargetHealth, CompanionTargetResult } from "./companion-targets.js";
import { resolveCompanionTimeState } from "./companion-time.js";
import type { CompanionTargetId } from "./companion-types.js";
import type { VoiceOutputService } from "./voice-output-service.js";

type CompanionVoiceOutput = Pick<VoiceOutputService, "speak" | "cancel">;
type CompanionLog = (level: "debug" | "info" | "warn", message: string, fields?: Record<string, unknown>) => void;
type CompanionAppStateSnapshot = {
  readonly pets: { readonly installed: ReadonlyArray<{ readonly id: string; readonly displayName: string; readonly broken?: boolean; readonly brokenReason?: string }> };
  readonly analytics: { readonly lastActivityAt?: number };
};

export type CompanionTurnKind = "typed" | "voice" | "proactive";

export type CompanionProactiveTurnMetadata = CompanionProactiveMemoryMetadata & {
  readonly expiresAt: number;
};

export type CompanionTurnRequest = {
  readonly petId: string;
  readonly text: string;
  readonly kind: CompanionTurnKind;
  readonly speak?: boolean;
  readonly pluginFacts?: readonly CompanionPluginFact[];
  readonly proactive?: CompanionProactiveTurnMetadata;
};

export type CompanionTurnResult = {
  readonly petId: string;
  readonly text: string;
  readonly targetId: CompanionTargetId;
  readonly displayed: boolean;
  readonly spoken: boolean;
  readonly displayToken?: string;
};

export type CompanionActivitySnapshot = {
  readonly thinking: boolean;
  readonly speaking: boolean;
};

type PetRuntime = {
  generation: number;
  targetId?: CompanionTargetId;
  sessionId?: string;
  controller?: AbortController;
  activeKind?: CompanionTurnKind;
  thinking: boolean;
  speaking: boolean;
};

type PendingDisplay = {
  readonly token: string;
  readonly petId: string;
  readonly text: string;
  readonly role: "assistant" | "proactive";
  readonly proactive?: CompanionProactiveMemoryMetadata;
  readonly createdAt: number;
};

export class CompanionOrchestrator {
  readonly #targets: ReadonlyMap<CompanionTargetId, CompanionTarget>;
  readonly #output: CompanionVoiceOutput;
  readonly #pluginFacts: (petId: string) => readonly CompanionPluginFact[];
  readonly #getSettings: typeof getCompanionSettings;
  readonly #getAppState: () => CompanionAppStateSnapshot;
  readonly #showBubble: (petId: string, text: string) => boolean;
  readonly #now: () => number;
  readonly #log: CompanionLog;
  readonly #runtime = new Map<string, PetRuntime>();
  readonly #pendingDisplays = new Map<string, PendingDisplay>();

  constructor(options: {
    readonly targets: readonly CompanionTarget[];
    readonly output: CompanionVoiceOutput;
    readonly getPluginFacts?: (petId: string) => readonly CompanionPluginFact[];
    readonly getSettings?: typeof getCompanionSettings;
    readonly getAppState: () => CompanionAppStateSnapshot;
    readonly showBubble: (petId: string, text: string) => boolean;
    readonly now?: () => number;
    readonly log?: CompanionLog;
  }) {
    this.#targets = new Map(options.targets.map((target) => [target.id, target]));
    this.#output = options.output;
    this.#pluginFacts = options.getPluginFacts ?? (() => []);
    this.#getSettings = options.getSettings ?? getCompanionSettings;
    this.#getAppState = options.getAppState;
    this.#showBubble = options.showBubble;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => undefined);
  }

  async health(targetId = this.#getSettings().target, force = false): Promise<CompanionTargetHealth> {
    const target = this.#targets.get(targetId);
    if (!target) return { targetId, checkedAt: Date.now(), configured: false, ready: false, method: "target registry", reason: "The selected companion provider is unavailable." };
    return target.health(force);
  }

  activity(petId: string): CompanionActivitySnapshot {
    const state = this.#runtime.get(petId);
    return { thinking: state?.thinking === true, speaking: state?.speaking === true };
  }

  async sendUserTurn(request: Omit<CompanionTurnRequest, "kind" | "proactive"> & { readonly kind?: "typed" | "voice" }): Promise<CompanionTurnResult> {
    return this.#send({ ...request, kind: request.kind ?? "typed" });
  }

  async sendProactiveTurn(request: Omit<CompanionTurnRequest, "kind" | "proactive"> & { readonly proactive: CompanionProactiveTurnMetadata }): Promise<CompanionTurnResult> {
    return this.#send({ ...request, kind: "proactive" });
  }

  cancel(petId: string): void {
    const runtime = this.#runtime.get(petId);
    if (runtime) {
      runtime.generation += 1;
      runtime.controller?.abort();
      runtime.controller = undefined;
      runtime.activeKind = undefined;
      runtime.thinking = false;
      runtime.speaking = false;
    }
    this.#output.cancel({ kind: "installed-pet", petId });
    for (const [token, pending] of this.#pendingDisplays) if (pending.petId === petId) this.#pendingDisplays.delete(token);
    this.#log("debug", "turn cancelled", { petId });
  }

  /** Cancel only currently-generating proactive turns, leaving user conversations alone. */
  cancelProactive(petId?: string): void {
    const runtimes = petId === undefined
      ? [...this.#runtime.entries()]
      : [[petId, this.#runtime.get(petId)] as const];
    for (const [runtimePetId, runtime] of runtimes) {
      if (!runtime || runtime.activeKind !== "proactive") continue;
      runtime.generation += 1;
      runtime.controller?.abort();
      runtime.controller = undefined;
      runtime.activeKind = undefined;
      runtime.thinking = false;
      runtime.speaking = false;
      this.#output.cancel({ kind: "installed-pet", petId: runtimePetId });
      this.#log("debug", "proactive turn cancelled", { petId: runtimePetId });
    }
    for (const [token, pending] of this.#pendingDisplays) {
      if (pending.role === "proactive" && (petId === undefined || pending.petId === petId)) this.#pendingDisplays.delete(token);
    }
  }

  acknowledgeDisplay(petId: string, token: string): boolean {
    const pending = this.#pendingDisplays.get(token);
    if (!pending || pending.petId !== petId) return false;
    if (this.#now() - pending.createdAt > 2 * 60_000) {
      this.#pendingDisplays.delete(token);
      return false;
    }
    this.#pendingDisplays.delete(token);
    if (this.#getSettings().memory.enabled) this.#commitDisplayed(pending.petId, pending.text, pending.role, pending.proactive);
    this.#log("debug", "control center response display acknowledged", { petId, role: pending.role });
    return true;
  }

  cancelAll(): void {
    for (const petId of this.#runtime.keys()) this.cancel(petId);
  }

  dispose(): void {
    this.cancelAll();
    this.#pendingDisplays.clear();
    this.#runtime.clear();
    for (const target of this.#targets.values()) target.dispose();
  }

  async #send(request: CompanionTurnRequest): Promise<CompanionTurnResult> {
    const text = normalizeTurnText(request.text);
    const turnNow = this.#now();
    const initialSettings = this.#getSettings();
    if (!initialSettings.enabled || initialSettings.consentVersion !== 1) throw new Error("Enable Companion for this pet before starting a conversation.");
    if (request.kind === "proactive") {
      if (!initialSettings.proactivity.enabled) throw new Error("Proactive companion check-ins are disabled.");
      if (!request.proactive || !Number.isFinite(request.proactive.expiresAt) || turnNow >= request.proactive.expiresAt) {
        throw new Error("The proactive companion opportunity is no longer available.");
      }
    }
    const appState = this.#getAppState();
    const pet = appState.pets.installed.find((candidate) => candidate.id === request.petId && !candidate.broken && !candidate.brokenReason);
    if (!pet) throw new Error("The selected pet is no longer available.");

    const target = this.#targets.get(initialSettings.target);
    if (!target) throw new Error("The selected companion provider is unavailable.");

    const runtime = this.#runtime.get(pet.id) ?? { generation: 0, thinking: false, speaking: false };
    if (runtime.targetId !== target.id) {
      runtime.controller?.abort();
      runtime.generation += 1;
      runtime.targetId = target.id;
      runtime.sessionId = undefined;
    } else {
      runtime.controller?.abort();
      runtime.generation += 1;
    }
    const generation = runtime.generation;
    const controller = new AbortController();
    let timedOut = false;
    const turnTimeout = setTimeout(() => { timedOut = true; controller.abort(); }, 90_000);
    turnTimeout.unref?.();
    runtime.controller = controller;
    runtime.activeKind = request.kind;
    runtime.thinking = true;
    runtime.speaking = false;
    this.#runtime.set(pet.id, runtime);
    this.#output.cancel({ kind: "installed-pet", petId: pet.id });

    try {
      const health = await waitForAbort(target.health(), controller.signal);
      this.#assertCurrentTurn(runtime, generation, controller, target.id, request);
      if (!health.ready) throw new Error(health.reason ?? "The selected companion provider is not ready.");

      const settings = this.#assertCurrentTurn(runtime, generation, controller, target.id, request);
      if (request.kind !== "proactive" && settings.memory.enabled) {
        const commit = commitCompanionUserTurn({ petId: pet.id, text, now: turnNow });
        if (!commit.persisted) this.#log("warn", "user turn retained in memory but not persisted", { petId: pet.id });
      }

      const memory = settings.memory.enabled ? selectRecentCompanionMemory({ petId: pet.id, now: turnNow }) : [];
      const context = buildCompanionContext({
        pet: { id: pet.id, displayName: pet.displayName, personality: settings.pets[pet.id]?.personality },
        profile: settings.profile,
        memory,
        time: resolveCompanionTimeState(new Date(turnNow), appState.analytics.lastActivityAt),
        interaction: { kind: request.kind === "proactive" ? "proactive" : "user", text },
        pluginFacts: settings.context.pluginEnabled ? [...this.#pluginFacts(pet.id), ...(request.pluginFacts ?? [])] : [],
        now: turnNow,
      });

      this.#log("info", "turn started", { petId: pet.id, targetId: target.id, kind: request.kind, inputLength: text.length, promptLength: context.prompt.length, memoryEntries: context.selectedMemory.length, pluginFacts: context.selectedPluginFacts.length, generation });

      let result: CompanionTargetResult;
      try {
        result = await target.send({ prompt: context.prompt, sessionId: runtime.sessionId, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted || !runtime.sessionId || isAbortError(error)) throw error;
        this.#log("warn", "provider session invalidated; retrying stateless", { petId: pet.id, targetId: target.id, generation });
        runtime.sessionId = undefined;
        result = await target.send({ prompt: context.prompt, signal: controller.signal });
      }
      const currentSettings = this.#assertCurrentTurn(runtime, generation, controller, target.id, request);
      const responseText = normalizeResponseText(result.text);
      runtime.sessionId = result.sessionId;
      const displayed = this.#showBubble(pet.id, responseText);
      const role = request.kind === "proactive" ? "proactive" as const : "assistant" as const;
      const proactive = request.proactive ? toMemoryMetadata(request.proactive) : undefined;
      let displayToken: string | undefined;
      if (displayed) {
        if (currentSettings.memory.enabled) this.#commitDisplayed(pet.id, responseText, role, proactive);
      } else {
        const createdAt = this.#now();
        displayToken = `display:${pet.id}:${generation}:${createdAt}`;
        this.#pendingDisplays.set(displayToken, {
          token: displayToken,
          petId: pet.id,
          text: responseText,
          role,
          ...(proactive ? { proactive } : {}),
          createdAt,
        });
      }

      runtime.thinking = false;
      let spoken = false;
      if (request.speak === true && displayed) {
        runtime.speaking = true;
        const speech = await this.#output.speak({ text: responseText, reason: "conversation", target: { kind: "installed-pet", petId: pet.id }, overlapPolicy: "interrupt" });
        if (controller.signal.aborted || runtime.generation !== generation) {
          this.#log("debug", "stale speech completion ignored", { petId: pet.id, generation });
        } else {
          spoken = speech.ok;
          runtime.speaking = false;
          if (!speech.ok) this.#log("warn", "turn displayed but speech failed", { petId: pet.id, attempts: speech.attempts.length });
        }
      }
      this.#log("info", "turn completed", { petId: pet.id, targetId: target.id, kind: request.kind, responseLength: responseText.length, displayed, spoken, generation });
      return { petId: pet.id, text: responseText, targetId: target.id, displayed, spoken, ...(displayToken ? { displayToken } : {}) };
    } catch (error) {
      if (timedOut) throw new Error("The companion provider took too long to respond.");
      throw error;
    } finally {
      clearTimeout(turnTimeout);
      if (runtime.generation === generation) {
        runtime.controller = undefined;
        runtime.activeKind = undefined;
        runtime.thinking = false;
        runtime.speaking = false;
      }
    }
  }

  #assertCurrentTurn(
    runtime: PetRuntime,
    generation: number,
    controller: AbortController,
    targetId: CompanionTargetId,
    request: CompanionTurnRequest,
  ): ReturnType<typeof getCompanionSettings> {
    if (controller.signal.aborted || runtime.generation !== generation) throw abortError();
    const settings = this.#getSettings();
    if (!settings.enabled || settings.consentVersion !== 1 || settings.target !== targetId) throw abortError();
    if (request.kind === "proactive"
      && (!settings.proactivity.enabled
        || !request.proactive
        || !Number.isFinite(request.proactive.expiresAt)
        || this.#now() >= request.proactive.expiresAt)) throw abortError();
    return settings;
  }

  #commitDisplayed(petId: string, text: string, role: "assistant" | "proactive", proactive?: CompanionProactiveMemoryMetadata): void {
    const now = this.#now();
    const commit = role === "proactive"
      ? commitCompanionProactiveTurn({ petId, text, now, ...(proactive ? { proactive } : {}) })
      : commitCompanionAssistantTurn({ petId, text, now });
    if (!commit.persisted) this.#log("warn", "displayed turn retained in memory but not persisted", { petId, role });
  }
}

function normalizeTurnText(value: string): string {
  const text = typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, 2_000) : "";
  if (!text) throw new Error("Write something for your pet first.");
  return text;
}

function normalizeResponseText(value: string): string {
  const text = typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, 2_000) : "";
  if (!text) throw new Error("The companion provider returned an empty response.");
  return text;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Companion conversation was cancelled.");
  error.name = "AbortError";
  return error;
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function toMemoryMetadata(metadata: CompanionProactiveTurnMetadata): CompanionProactiveMemoryMetadata {
  return {
    candidateId: metadata.candidateId,
    dedupeKey: metadata.dedupeKey,
    source: metadata.source,
    ...(metadata.pluginId ? { pluginId: metadata.pluginId } : {}),
  };
}
