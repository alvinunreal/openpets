import { getDefaultPetWindowForPlugins } from "./default-pet-controller.js";
import { speakPetWindowTts, stopPetWindowTts } from "./pet-window.js";
import type { PluginAiGateway } from "./plugin-ai-gateway.js";
import { VoiceCaptureService } from "./voice-capture.js";
import { createElectronVoiceCaptureFactory } from "./voice-capture-electron.js";
import { createElectronVoicePrivacyIndicator } from "./voice-privacy-indicator-electron.js";
import { VoiceListeningService } from "./voice-listening-service.js";

/**
 * Plugin voice (§13.5). TTS speaks through the pet window's renderer
 * speechSynthesis (the OS voice). STT is strictly one-shot push-to-talk: a
 * dedicated capture window records a bounded clip in its own session (the only
 * session granted microphone permission), and the clip is transcribed through
 * the user's configured AI provider. Never ambient.
 */

export async function pluginVoiceSpeak(text: string, opts: { voice?: string; rate?: number }): Promise<void> {
  const window = getDefaultPetWindowForPlugins();
  if (!window) throw new Error("No pet window is available for speech.");
  speakPetWindowTts(window, text, opts);
}

export function pluginVoiceStop(): void {
  const window = getDefaultPetWindowForPlugins();
  if (window) stopPetWindowTts(window);
}

let activeListeningService: VoiceListeningService | null = null;
let activePluginId: string | undefined;
let captureService: VoiceCaptureService | null = null;

export async function pluginVoiceListen(gateway: PluginAiGateway, opts: { timeoutMs: number; pluginId?: string }): Promise<{ text: string }> {
  if (activeListeningService) throw new Error("A voice capture is already in progress.");
  const service = new VoiceListeningService(
    getCaptureService(),
    (capture, signal) => gateway.transcribe(capture.bytes, capture.mimeType, signal),
  );
  activeListeningService = service;
  activePluginId = opts.pluginId;
  try {
    return await service.listenOnce(opts.timeoutMs);
  } finally {
    if (activeListeningService === service) {
      activeListeningService = null;
      activePluginId = undefined;
    }
  }
}

export async function cancelPluginVoiceListen(pluginId?: string, reason = "Voice capture was cancelled."): Promise<void> {
  if (!activeListeningService) return;
  if (pluginId && activePluginId && activePluginId !== pluginId) return;
  await activeListeningService.cancel(reason).catch(() => undefined);
}

export async function shutdownPluginVoice(): Promise<void> {
  if (activeListeningService) await activeListeningService.shutdown().catch(() => undefined);
  else await captureService?.shutdown().catch(() => undefined);
  activeListeningService = null;
  activePluginId = undefined;
}

function getCaptureService(): VoiceCaptureService {
  if (!captureService) {
    const indicator = createElectronVoicePrivacyIndicator();
    captureService = new VoiceCaptureService(createElectronVoiceCaptureFactory(), indicator);
  }
  return captureService;
}
