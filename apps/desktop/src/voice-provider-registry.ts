import type { BrowserWindow } from "electron";

import type { PluginSecretsStore } from "./plugin-secrets.js";
import { elevenLabsVoiceProvider } from "./voice-provider-elevenlabs.js";
import { openAiCompatibleVoiceProvider } from "./voice-provider-openai-compatible.js";
import { pocketTtsVoiceProvider } from "./voice-provider-pockettts.js";
import { systemVoiceProvider } from "./voice-provider-system.js";
import { createEvidence, sanitizeProviderError, type VoiceCapabilityEvidence, type VoiceInfo, type VoiceProviderAdapter, type VoiceSynthesisRequest, type VoiceSynthesisResult } from "./voice-provider.js";
import { getVoiceSettings, onVoiceSettingsChanged, type VoiceProviderId } from "./voice-settings.js";
import type { VoiceSecretProviderId } from "./voice-secrets.js";

const adapters = new Map<VoiceProviderId, VoiceProviderAdapter>([
  [systemVoiceProvider.id, systemVoiceProvider],
  [pocketTtsVoiceProvider.id, pocketTtsVoiceProvider],
  [openAiCompatibleVoiceProvider.id, openAiCompatibleVoiceProvider],
  [elevenLabsVoiceProvider.id, elevenLabsVoiceProvider],
]);

export class VoiceProviderRegistry {
  readonly #secrets: PluginSecretsStore;
  readonly #getDefaultWindow: () => BrowserWindow | null;
  readonly #listSystemVoices: (window: BrowserWindow) => Promise<VoiceInfo[]>;
  readonly #evidence = new Map<VoiceProviderId, VoiceCapabilityEvidence>();
  readonly #removeSettingsListener: () => void;

  constructor(input: { secrets: PluginSecretsStore; getDefaultWindow(): BrowserWindow | null; listSystemVoices(window: BrowserWindow): Promise<VoiceInfo[]> }) {
    this.#secrets = input.secrets;
    this.#getDefaultWindow = input.getDefaultWindow;
    this.#listSystemVoices = input.listSystemVoices;
    this.#removeSettingsListener = onVoiceSettingsChanged(() => this.invalidate());
  }

  invalidate(providerId?: VoiceProviderId | VoiceSecretProviderId): void {
    if (providerId) this.#evidence.delete(providerId);
    else this.#evidence.clear();
  }

  async health(providerId: VoiceProviderId, targetWindow?: BrowserWindow): Promise<VoiceCapabilityEvidence> {
    const cached = this.#evidence.get(providerId);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const evidence = await this.#adapter(providerId).health(this.#context(targetWindow));
    this.#evidence.set(providerId, evidence);
    return evidence;
  }

  async listVoices(providerId: VoiceProviderId, targetWindow?: BrowserWindow): Promise<{ readonly supported: boolean; readonly voices: VoiceInfo[]; readonly evidence: VoiceCapabilityEvidence }> {
    const result = await this.#adapter(providerId).listVoices(this.#context(targetWindow));
    this.#evidence.set(providerId, result.evidence);
    return result;
  }

  async synthesize(providerId: VoiceProviderId, request: VoiceSynthesisRequest, targetWindow: BrowserWindow): Promise<VoiceSynthesisResult> {
    try {
      const result = await this.#adapter(providerId).synthesize(request, this.#context(targetWindow));
      const previous = this.#evidence.get(providerId);
      this.#evidence.set(providerId, createEvidence(providerId, {
        configured: true,
        reachable: true,
        authenticated: previous?.authenticated,
        discoverySupported: previous?.discoverySupported ?? (providerId === "system" || providerId === "elevenlabs"),
        discoveryOk: previous?.discoveryOk,
        synthesisTested: true,
        ready: true,
        method: "synthesis-test",
        version: previous?.version,
      }));
      return result;
    } catch (error) {
      const previous = this.#evidence.get(providerId);
      this.#evidence.set(providerId, createEvidence(providerId, {
        configured: previous?.configured ?? true,
        reachable: previous?.reachable ?? false,
        authenticated: previous?.authenticated,
        discoverySupported: previous?.discoverySupported ?? (providerId === "system" || providerId === "elevenlabs"),
        discoveryOk: previous?.discoveryOk,
        synthesisTested: true,
        ready: false,
        method: "synthesis-test",
        version: previous?.version,
        reason: sanitizeProviderError(error),
      }));
      throw error;
    }
  }

  dispose(): void {
    this.#removeSettingsListener();
    this.#evidence.clear();
  }

  #context(targetWindow?: BrowserWindow) {
    const window = targetWindow && !targetWindow.isDestroyed() ? targetWindow : this.#getDefaultWindow() ?? undefined;
    return { settings: getVoiceSettings(), secrets: this.#secrets, targetWindow: window, listSystemVoices: this.#listSystemVoices };
  }

  #adapter(providerId: VoiceProviderId): VoiceProviderAdapter {
    const adapter = adapters.get(providerId);
    if (!adapter) throw new Error(`Unsupported voice provider: ${providerId}`);
    return adapter;
  }
}
