import { getAppStateSnapshot } from "./app-state.js";
import { CompanionOrchestrator } from "./companion-orchestrator.js";
import { CompanionProactiveService } from "./companion-proactive-service.js";
import { CodexCompanionTarget } from "./companion-target-codex.js";
import { HostAiCompanionTarget } from "./companion-target-host-ai.js";
import { getDefaultPetWindowForPlugins } from "./default-pet-controller.js";
import { debug, info, warn } from "./logger.js";
import type { ElectronPluginHostCapabilities } from "./plugin-host-capabilities.js";
import { showInstalledPetHostBubble } from "./plugin-pet-registry.js";
import { requestPetWindowSystemVoices } from "./pet-window.js";
import { VoiceCaptureService } from "./voice-capture.js";
import { VoiceListeningService } from "./voice-listening-service.js";
import { VoiceOutputService } from "./voice-output-service.js";
import { VoicePrivacyIndicator } from "./voice-privacy-indicator.js";
import { VoiceProviderRegistry } from "./voice-provider-registry.js";
import { VoiceTranscriptionService } from "./voice-transcription-service.js";
import { VoiceWakeWordService } from "./voice-wake-word-service.js";

type VoicePlatform = {
  readonly providers: VoiceProviderRegistry;
  readonly output: VoiceOutputService;
  readonly capture: VoiceCaptureService;
  readonly listening: VoiceListeningService;
  readonly companion: CompanionOrchestrator;
  readonly proactive: CompanionProactiveService;
  readonly wake: VoiceWakeWordService;
  readonly privacyIndicator: VoicePrivacyIndicator;
};

let activeVoicePlatform: VoicePlatform | null = null;

export function initializeVoicePlatform(capabilities: ElectronPluginHostCapabilities): VoicePlatform {
  shutdownVoicePlatform();
  const providers = new VoiceProviderRegistry({
    secrets: capabilities.secretsStore,
    getDefaultWindow: getDefaultPetWindowForPlugins,
    listSystemVoices: requestPetWindowSystemVoices,
  });
  const output = new VoiceOutputService(providers);
  const privacyIndicator = new VoicePrivacyIndicator();
  const capture = new VoiceCaptureService(privacyIndicator);
  const transcription = new VoiceTranscriptionService(capabilities.aiGateway);
  const contributions = capabilities.companionContributions;
  const companion = new CompanionOrchestrator({
    targets: [new CodexCompanionTarget(), new HostAiCompanionTarget(capabilities.aiGateway)],
    output,
    getAppState: getAppStateSnapshot,
    showBubble: showInstalledPetHostBubble,
    log: (level, message, fields) => {
      if (level === "debug") debug("companion", message, fields);
      else if (level === "warn") warn("companion", message, fields);
      else info("companion", message, fields);
    },
    getPluginFacts: (petId) => {
      if (petId !== getAppStateSnapshot().preferences.defaultPetId) return [];
      return contributions.snapshot().facts.map((fact) => ({ id: fact.id, pluginId: fact.pluginId, sourceLabel: fact.pluginId, text: fact.text, expiresAt: fact.expiresAt }));
    },
  });
  const wake = new VoiceWakeWordService();
  const listening = new VoiceListeningService({ capture, transcription, output, companion });
  const proactive = new CompanionProactiveService({
    orchestrator: companion,
    getListeningSnapshot: () => listening.getSnapshot(),
    getOpportunities: () => contributions.snapshot({ includeFutureOpportunities: true }).opportunities.map((opportunity) => ({
      id: opportunity.id,
      dedupeKey: `${opportunity.pluginId}:${opportunity.dedupeKey}`,
      source: "plugin" as const,
      pluginId: opportunity.pluginId,
      earliestAt: opportunity.earliestAt,
      expiresAt: opportunity.expiresAt,
      cooldownMs: opportunity.cooldownMs,
      text: "An approved plugin has offered a low-urgency conversation opportunity. Decide whether a brief, natural check-in would be welcome; do not repeat plugin wording.",
      fact: { id: opportunity.id, pluginId: opportunity.pluginId, sourceLabel: opportunity.pluginId, text: opportunity.context, expiresAt: opportunity.expiresAt },
    })),
    consumeOpportunity: (id) => { contributions.consumeOpportunity(id); },
  });
  proactive.start();
  activeVoicePlatform = { providers, output, capture, listening, companion, proactive, wake, privacyIndicator };
  info("app", "voice platform initialized");
  return activeVoicePlatform;
}

export function getVoicePlatform(): VoicePlatform | null {
  return activeVoicePlatform;
}

export function getVoiceOutputService(): VoiceOutputService | null {
  return activeVoicePlatform?.output ?? null;
}

export function getVoiceListeningService(): VoiceListeningService | null {
  return activeVoicePlatform?.listening ?? null;
}

export function shutdownVoicePlatform(): void {
  const platform = activeVoicePlatform;
  activeVoicePlatform = null;
  if (!platform) return;
  try { void platform.listening.shutdown(); } catch (error) { warn("app", "voice listening shutdown failed", { reason: error instanceof Error ? error.message : String(error) }); }
  try { platform.proactive.stop(); } catch { /* idempotent cleanup */ }
  try { platform.output.cancelAll(); } catch (error) { warn("app", "voice output shutdown failed", { reason: error instanceof Error ? error.message : String(error) }); }
  try { platform.privacyIndicator.shutdown(); } catch { /* idempotent cleanup */ }
  try { platform.wake.dispose(); } catch { /* idempotent cleanup */ }
  try { platform.companion.dispose(); } catch { /* idempotent cleanup */ }
  try { platform.providers.dispose(); } catch { /* idempotent cleanup */ }
  info("app", "voice platform stopped");
}
