import { info, warn } from "./logger.js";
import { getAppStateSnapshot } from "./app-state.js";
import type { PluginAssistantCapabilityExecutionOutcome, PluginAssistantCapabilityHandle } from "./plugin-sdk-assistant.js";
import type { PluginService } from "./plugin-service.js";
import type { PluginSecretsStore } from "./plugin-secrets.js";
import { PetAssistantService } from "./pet-assistant-service.js";
import type { PetAssistantConversationArchive } from "./pet-assistant-archive.js";
import { PetAssistantConversationController } from "./pet-assistant-conversation.js";
import { TextModelClient } from "./text-model-client.js";
import type { HostProviderOperations } from "./provider-service.js";
import type {
  AssistantJsonObject,
  PetAssistantComposition,
  PetAssistantCapabilityRuntime,
  PetAssistantGenerationHandle,
} from "./pet-assistant-types.js";
import { PetAssistantModalityCoordinator } from "./pet-assistant-modality.js";

let assistantService: PetAssistantService | null = null;
let conversationController: PetAssistantConversationController | null = null;
let stopping: Promise<void> | null = null;
const modalityCoordinator = new PetAssistantModalityCoordinator();
const conversationControllerReadyListeners = new Set<(controller: PetAssistantConversationController) => void>();

type HostCapabilityHandle = PetAssistantGenerationHandle & { readonly pluginHandle: PluginAssistantCapabilityHandle };
export type PetAssistantHostOptions = {
  readonly compositionProvider?: () => PetAssistantComposition;
  readonly providerOperations?: HostProviderOperations;
  readonly conversationArchive?: PetAssistantConversationArchive;
};

/** Construct the host assistant only after the plugin runtime has started. */
export function startPetAssistantHost(pluginService: PluginService, secrets: PluginSecretsStore, options: PetAssistantHostOptions = {}): PetAssistantService {
  if (assistantService) return assistantService;
  if (stopping) throw new Error("Pet Assistant shutdown is in progress.");
  const runtime: PetAssistantCapabilityRuntime = {
    snapshot: (signal) => {
      if (signal.aborted) throw new Error("Pet Assistant capability discovery was cancelled.");
      return {
        capabilities: pluginService.getAssistantCapabilities().map((entry) => ({
          pluginId: entry.pluginId,
          capability: entry.capability,
          handle: Object.freeze({ pluginHandle: entry.handle }),
        })),
      };
    },
    execute: (handle, input, signal) => executeCapability(pluginService, handle, input, signal),
  };
  const service = new PetAssistantService(new TextModelClient(options.providerOperations ?? secrets), runtime, {
    // App state is host-owned and synchronous; the service snapshots this
    // profile before each turn without coupling itself to Electron state.
    compositionProvider: options.compositionProvider ?? (() => ({ personality: getAppStateSnapshot().preferences.personality })),
    conversationArchive: options.conversationArchive,
    onConversationArchiveError: (error) => warn("app", "Pet Assistant conversation archive write failed", { reason: error instanceof Error ? error.message : "unknown" }),
  });
  service.subscribe((event) => {
    if (event.type === "terminal" && event.result.status === "failed") warn("app", "Pet Assistant turn failed", { reason: event.result.error });
  });
  conversationController = new PetAssistantConversationController(service, undefined, modalityCoordinator);
  assistantService = service;
  for (const listener of [...conversationControllerReadyListeners]) listener(conversationController);
  conversationControllerReadyListeners.clear();
  info("app", "Pet Assistant host ready");
  return service;
}

/** Host-internal getter reserved for future chat and voice surfaces. */
export function getPetAssistantService(): PetAssistantService | null {
  return assistantService;
}

/** Host-owned current-session presentation used by chat and future voice UI. */
export function getPetAssistantConversationController(): PetAssistantConversationController | null {
  return conversationController;
}

export function getPetAssistantModalityCoordinator(): PetAssistantModalityCoordinator {
  return modalityCoordinator;
}

export function onPetAssistantConversationControllerReady(listener: (controller: PetAssistantConversationController) => void): () => void {
  if (conversationController) {
    listener(conversationController);
    return () => {};
  }
  conversationControllerReadyListeners.add(listener);
  return () => { conversationControllerReadyListeners.delete(listener); };
}

/** Stop the assistant before the plugin runtime is torn down. */
export async function stopPetAssistantHost(): Promise<void> {
  if (stopping) return stopping;
  const service = assistantService;
  if (!service) return;
  const presentation = conversationController;
  stopping = service.stop().then(() => {
    info("app", "Pet Assistant host stopped");
  }).catch((error: unknown) => {
    warn("app", "Pet Assistant host stop failed", { reason: error instanceof Error ? error.message : "unknown" });
    throw error;
  }).finally(() => {
    modalityCoordinator.releaseAll();
    presentation?.dispose();
    if (conversationController === presentation) conversationController = null;
    if (assistantService === service) assistantService = null;
    stopping = null;
  });
  return stopping;
}

async function executeCapability(
  pluginService: PluginService,
  handle: PetAssistantGenerationHandle,
  input: AssistantJsonObject,
  signal: AbortSignal,
): Promise<PluginAssistantCapabilityExecutionOutcome> {
  if (signal.aborted) throw new Error("Pet Assistant capability invocation was cancelled before it started.");
  if (!isHostCapabilityHandle(handle)) return { ok: false, error: { stage: "handle", code: "invalid_handle", message: "Assistant capability handle is invalid." } };
  const current = pluginService.getAssistantCapabilities();
  const isCurrent = current.some((entry) => entry.handle === handle.pluginHandle);
  if (!isCurrent) {
    return { ok: false as const, error: { stage: "lifecycle" as const, code: "stale_generation" as const, message: "Assistant capability is no longer active." } };
  }
  const outcome = await raceAbort(pluginService.executeAssistantCapability(handle.pluginHandle, input), signal);
  if (outcome.ok) return outcome;
  // The handle was current when invocation began. A later disable/reload is
  // therefore indeterminate, not an unavailable pre-invocation rejection.
  if (outcome.error.stage === "lifecycle" || outcome.error.stage === "handle") {
    return { ok: false as const, error: { stage: "handler" as const, code: "internal_error" as const, message: outcome.error.message, ...(outcome.error.missingInformation === true ? { missingInformation: true } : {}) } };
  }
  return outcome;
}

function isHostCapabilityHandle(value: PetAssistantGenerationHandle): value is HostCapabilityHandle {
  return typeof value === "object" && value !== null && "pluginHandle" in value
    && typeof value.pluginHandle === "object" && value.pluginHandle !== null;
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Pet Assistant capability invocation was cancelled."));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => { if (!settled) { settled = true; reject(new Error("Pet Assistant capability invocation was cancelled.")); } };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => { if (!settled) { settled = true; signal.removeEventListener("abort", abort); resolve(value); } },
      (error: unknown) => { if (!settled) { settled = true; signal.removeEventListener("abort", abort); reject(error); } },
    );
  });
}
