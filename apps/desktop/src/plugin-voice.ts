import { getDefaultPetWindowForPlugins } from "./default-pet-controller.js";
import { playPetWindowTtsAudio, speakPetWindowTts, stopPetWindowTts, stopPetWindowTtsAudio } from "./pet-window.js";
import type { PluginAiGateway } from "./plugin-ai-gateway.js";
import { VoiceConversationService, type VoiceConversationSnapshot, type VoiceRealtimeSessionConfig } from "./voice-conversation.js";
import { createElectronVoiceRealtimeTransportFactory } from "./voice-realtime-electron.js";
import { createElectronVoiceCaptureFactory } from "./voice-capture-electron.js";
import { createElectronVoicePrivacyIndicator } from "./voice-privacy-indicator-electron.js";
import type { VoiceCaptureService } from "./voice-capture.js";
import { VoiceListeningService } from "./voice-listening-service.js";
import { VoiceOperationState, type VoiceOperationSnapshot } from "./voice-operation-state.js";
import { VoiceResourceOwner } from "./voice-resource-owner.js";
import type { VoiceMicrophoneArbiter } from "./voice-microphone-arbiter.js";

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
let conversationService: VoiceConversationService | null = null;
let conversationStartReservation: symbol | null = null;
const voiceResources = new VoiceResourceOwner({ captureFactory: createElectronVoiceCaptureFactory(), privacyIndicatorFactory: createElectronVoicePrivacyIndicator });
const voiceOperationState = new VoiceOperationState();
let pluginVoiceShutdownPromise: Promise<void> | null = null;

export function getPluginVoiceOperation(): VoiceOperationSnapshot | null {
  return voiceOperationState.snapshot();
}

export function subscribePluginVoiceOperation(listener: () => void): () => void {
  return voiceOperationState.subscribe(listener);
}

/** Shared host-owned resources used by every voice lane. */
export function getSharedVoiceMicrophoneArbiter(): VoiceMicrophoneArbiter {
  return voiceResources.microphoneArbiter;
}

export function getSharedVoiceCaptureService(): VoiceCaptureService {
  return voiceResources.capture();
}

export async function pluginVoiceListen(gateway: PluginAiGateway, opts: { timeoutMs: number; pluginId?: string }): Promise<{ text: string }> {
  if (activeListeningService) throw new Error("A voice capture is already in progress.");
  const reservation = voiceOperationState.reserve();
  activePluginId = opts.pluginId;
  try {
    const transcribe = await gateway.beginTranscriptionOperation();
    const service = new VoiceListeningService(
      voiceResources.capture(),
      (capture, signal) => transcribe(capture.bytes, capture.mimeType, signal),
      { onPhaseChange: (phase) => voiceOperationState.setPhase(phase) },
    );
    activeListeningService = service;
    voiceOperationState.begin(() => service.cancel(), reservation);
    return await service.listenOnce(opts.timeoutMs);
  } finally {
    if (activeListeningService) {
      activeListeningService = null;
      activePluginId = undefined;
      voiceOperationState.settle();
    } else {
      voiceOperationState.releaseReservation(reservation);
      activePluginId = undefined;
    }
  }
}

export async function cancelPluginVoiceListen(pluginId?: string, reason = "Voice capture was cancelled."): Promise<void> {
  if (!activeListeningService) return;
  if (pluginId && activePluginId && activePluginId !== pluginId) return;
  await activeListeningService.cancel(reason).catch(() => undefined);
}

/** Host-private realtime foundation; intentionally not wired into the plugin SDK. */
export async function startPluginVoiceConversation(gateway: PluginAiGateway): Promise<VoiceConversationSnapshot> {
  if (conversationStartReservation || conversationService?.snapshot().phase !== "idle") throw new Error("A realtime voice conversation is already in progress.");
  const reservation = Symbol("plugin-voice-conversation");
  conversationStartReservation = reservation;
  try {
    const negotiator = await gateway.beginRealtimeOperation();
    if (conversationStartReservation !== reservation) throw new Error("Voice conversation startup was cancelled.");
    const service = createConversationService(negotiator);
    conversationService = service;
    return await service.start();
  } finally {
    if (conversationStartReservation === reservation) conversationStartReservation = null;
  }
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
    conversationStartReservation = null;
    voiceOperationState.cancelReservation();
    if (conversationService) await conversationService.shutdown().catch(() => undefined);
    if (activeListeningService) await activeListeningService.shutdown().catch(() => undefined);
    await voiceResources.shutdown();
    conversationService = null;
    activeListeningService = null;
    activePluginId = undefined;
  })();
  return pluginVoiceShutdownPromise;
}

function createConversationService(negotiator: (sdp: string, session: VoiceRealtimeSessionConfig, signal?: AbortSignal) => Promise<string>): VoiceConversationService {
  return new VoiceConversationService({
    microphoneArbiter: voiceResources.microphoneArbiter,
    privacyIndicator: voiceResources.privacyIndicator,
    transportFactory: createElectronVoiceRealtimeTransportFactory({ negotiate: negotiator }),
  });
}
