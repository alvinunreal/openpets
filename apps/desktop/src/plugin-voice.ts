import { getDefaultPetWindowForPlugins } from "./default-pet-controller.js";
import { playPetWindowTtsAudio, speakPetWindowTts, stopPetWindowTts, stopPetWindowTtsAudio } from "./pet-window.js";
import type { PluginAiGateway } from "./plugin-ai-gateway.js";
import { VoiceConversationService, type VoiceConversationSnapshot } from "./voice-conversation.js";
import { VoiceCaptureService } from "./voice-capture.js";
import { createElectronVoiceCaptureFactory } from "./voice-capture-electron.js";
import { createElectronVoiceRealtimeTransportFactory } from "./voice-realtime-electron.js";
import { createElectronVoicePrivacyIndicator } from "./voice-privacy-indicator-electron.js";
import { VoiceMicrophoneArbiter } from "./voice-microphone-arbiter.js";
import { VoicePrivacyIndicator } from "./voice-privacy-indicator.js";
import { VoiceListeningService } from "./voice-listening-service.js";
import { VoiceOperationState, type VoiceOperationSnapshot } from "./voice-operation-state.js";

/**
 * Plugin voice (§13.5). TTS uses configured MiniMax speech synthesis when
 * available, with the renderer's OS voice as a fallback. STT is strictly
 * one-shot push-to-talk: a
 * dedicated capture window records a bounded clip in its own session (the only
 * session granted microphone permission), and the clip is transcribed through
 * the user's configured AI provider. Never ambient.
 */

let ttsRequestGeneration = 0;

export async function pluginVoiceSpeak(gateway: PluginAiGateway, text: string, opts: { voice?: string; rate?: number }): Promise<void> {
  const window = getDefaultPetWindowForPlugins();
  if (!window) throw new Error("No pet window is available for speech.");
  const requestGeneration = ++ttsRequestGeneration;
  const speech = await gateway.synthesizeSpeech(text, opts);
  if (requestGeneration !== ttsRequestGeneration) return;
  if (speech) {
    stopPetWindowTts(window);
    playPetWindowTtsAudio(window, `data:${speech.mimeType};base64,${Buffer.from(speech.bytes).toString("base64")}`);
    return;
  }
  stopPetWindowTtsAudio(window);
  speakPetWindowTts(window, text, opts);
}

export function pluginVoiceStop(): void {
  ttsRequestGeneration++;
  const window = getDefaultPetWindowForPlugins();
  if (window) {
    stopPetWindowTts(window);
    stopPetWindowTtsAudio(window);
  }
}

let activeListeningService: VoiceListeningService | null = null;
let activePluginId: string | undefined;
let captureService: VoiceCaptureService | null = null;
let conversationService: VoiceConversationService | null = null;
let privacyIndicator: VoicePrivacyIndicator | null = null;
const microphoneArbiter = new VoiceMicrophoneArbiter();
const voiceOperationState = new VoiceOperationState();
let pluginVoiceShutdownPromise: Promise<void> | null = null;

export function getPluginVoiceOperation(): VoiceOperationSnapshot | null {
  return voiceOperationState.snapshot();
}

export function subscribePluginVoiceOperation(listener: () => void): () => void {
  return voiceOperationState.subscribe(listener);
}

export async function pluginVoiceListen(gateway: PluginAiGateway, opts: { timeoutMs: number; pluginId?: string }): Promise<{ text: string }> {
  if (activeListeningService) throw new Error("A voice capture is already in progress.");
  const service = new VoiceListeningService(
    getCaptureService(),
    (capture, signal) => gateway.transcribe(capture.bytes, capture.mimeType, signal),
    { onPhaseChange: (phase) => voiceOperationState.setPhase(phase) },
  );
  activeListeningService = service;
  activePluginId = opts.pluginId;
  voiceOperationState.begin(() => service.cancel());
  try {
    return await service.listenOnce(opts.timeoutMs);
  } finally {
    if (activeListeningService === service) {
      activeListeningService = null;
      activePluginId = undefined;
    }
    voiceOperationState.settle();
  }
}

export async function cancelPluginVoiceListen(pluginId?: string, reason = "Voice capture was cancelled."): Promise<void> {
  if (!activeListeningService) return;
  if (pluginId && activePluginId && activePluginId !== pluginId) return;
  await activeListeningService.cancel(reason).catch(() => undefined);
}

/** Host-private realtime foundation; intentionally not wired into the plugin SDK. */
export async function startPluginVoiceConversation(gateway: PluginAiGateway): Promise<VoiceConversationSnapshot> {
  return getConversationService(gateway).start();
}

export function getPluginVoiceConversationSnapshot(): VoiceConversationSnapshot | null {
  return conversationService?.snapshot() ?? null;
}

export async function closePluginVoiceConversation(): Promise<void> {
  await conversationService?.close();
}

export async function mutePluginVoiceConversation(): Promise<void> {
  await conversationService?.mute();
}

export async function unmutePluginVoiceConversation(): Promise<void> {
  await conversationService?.unmute();
}

export function shutdownPluginVoice(): Promise<void> {
  if (pluginVoiceShutdownPromise) return pluginVoiceShutdownPromise;
  pluginVoiceShutdownPromise = (async () => {
    if (conversationService) await conversationService.shutdown().catch(() => undefined);
    if (activeListeningService) await activeListeningService.shutdown().catch(() => undefined);
    else await captureService?.shutdown().catch(() => undefined);
    conversationService = null;
    captureService = null;
    privacyIndicator = null;
    activeListeningService = null;
    activePluginId = undefined;
  })();
  return pluginVoiceShutdownPromise;
}

function getCaptureService(): VoiceCaptureService {
  if (!captureService) {
    captureService = new VoiceCaptureService(createElectronVoiceCaptureFactory(), getPrivacyIndicator(), { microphoneArbiter });
  }
  return captureService;
}

function getConversationService(gateway: PluginAiGateway): VoiceConversationService {
  if (!conversationService) {
    conversationService = new VoiceConversationService({
      microphoneArbiter,
      privacyIndicator: getPrivacyIndicator(),
      transportFactory: createElectronVoiceRealtimeTransportFactory({
        negotiate: (sdp, session, signal) => gateway.negotiateRealtime(sdp, session, signal),
      }),
    });
  }
  return conversationService;
}

function getPrivacyIndicator(): VoicePrivacyIndicator {
  return privacyIndicator ??= createElectronVoicePrivacyIndicator();
}
