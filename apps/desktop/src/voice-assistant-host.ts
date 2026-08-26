import { applyExternalPetReaction, applyExternalPetSay, applyExternalPetStatusReaction, getDefaultPetWindowForPlugins, setDefaultPetVoiceActivity, setDefaultPetVoiceTerminalFeedback } from "./default-pet-controller.js";
import { info } from "./logger.js";
import type { PetAssistantService } from "./pet-assistant-service.js";
import { getPetAssistantConversationController, getPetAssistantModalityCoordinator } from "./pet-assistant-host.js";
import { PET_ASSISTANT_CONVERSATION_ID } from "./pet-assistant-conversation.js";
import { PetAssistantFeedbackReducer } from "./pet-assistant-feedback.js";
import type { HostProviderOperations } from "./provider-service.js";
import { playPetWindowTtsAudio, speakPetWindowTts, stopPetWindowTts, stopPetWindowTtsAudio, subscribePetWindowSpeechCompletion } from "./pet-window.js";
import type { VoiceAssistantPlayer, VoiceAssistantSpeech } from "./voice-assistant-session.js";
import { VoiceAssistantSession, type VoiceAssistantSessionSnapshot } from "./voice-assistant-session.js";
import { getVoicePlaybackTimeoutMs, VoiceAssistantPlaybackCoordinator } from "./voice-assistant-playback.js";
import { installWindowLossHandlers } from "./voice-playback-window.js";
import { HostVoiceInput, PetAssistantVoiceAdapter, ProviderVoiceSynthesizer, VoiceAssistantHostController, type VoiceAssistantHostEvent } from "./voice-assistant-host-core.js";
import type { VoiceCaptureService } from "./voice-capture.js";
import { getSharedVoiceCaptureService, getSharedVoiceMicrophoneArbiter } from "./plugin-voice.js";
import type { VoiceMicrophoneArbiter } from "./voice-microphone-arbiter.js";
import type { PetAssistantModalityCoordinator } from "./pet-assistant-modality.js";
import { getVoiceAssistantShortcutSnapshot } from "./voice-assistant-shortcut.js";
import type { VoiceAssistantShortcutSnapshot } from "./voice-assistant-shortcut.js";
import { shutdownVoiceAssistantResources, shutdownVoiceAssistantWithCleanup } from "./voice-assistant-host-cleanup.js";
import { getPluginPlatformSettings } from "./plugin-platform-settings.js";
import { createElectronVoiceRealtimeTransportFactory } from "./voice-realtime-electron.js";
import { OpenAIRealtimeVoiceAssistantSession } from "./voice-realtime-assistant.js";
import { getSharedVoicePrivacyIndicator } from "./plugin-voice.js";

export type VoiceAssistantHostOptions = {
  readonly sessionId: number;
  readonly provider: HostProviderOperations;
  readonly assistant: PetAssistantService;
  readonly microphoneArbiter?: VoiceMicrophoneArbiter;
  readonly capture?: VoiceCaptureService;
  readonly feedbackReducer?: PetAssistantFeedbackReducer;
  readonly modalityCoordinator?: PetAssistantModalityCoordinator;
};

/** Single main-process Talk contract used by IPC, preload, and host controls. */
export type VoiceAssistantTalkSnapshot = VoiceAssistantSessionSnapshot & {
  readonly sessionId: number;
  readonly shortcut: VoiceAssistantShortcutSnapshot["accelerator"];
  readonly shortcutStatus: VoiceAssistantShortcutSnapshot["status"];
  readonly shortcutReason: string | null;
};
export type VoiceAssistantTalkEvent = (Exclude<VoiceAssistantHostEvent, { readonly type: "snapshot" }> & { readonly sessionId: number }) | {
  readonly type: "snapshot";
  readonly sequence: number;
  readonly sessionId: number;
  readonly snapshot: VoiceAssistantTalkSnapshot;
};

/** Host-private composition of bounded voice I/O, Pet Assistant, and pet speech. */
export class VoiceAssistantHost {
  readonly sessionId: number;
  readonly #player: PetWindowVoicePlayer;
  readonly #session: import("./voice-assistant-session.js").VoiceAssistantSessionLike;
  readonly #unsubscribeSession: () => void;
  readonly #feedbackReducer?: PetAssistantFeedbackReducer;
  readonly #conversationController = getPetAssistantConversationController();

  constructor(options: VoiceAssistantHostOptions) {
    this.sessionId = options.sessionId;
    this.#feedbackReducer = options.feedbackReducer;
    const input = new HostVoiceInput(options.provider, options.capture ?? getSharedVoiceCaptureService());
    const adapter = new PetAssistantVoiceAdapter(options.assistant);
    const synthesizer = new ProviderVoiceSynthesizer(options.provider);
    this.#player = new PetWindowVoicePlayer();
    const microphoneArbiter = options.microphoneArbiter ?? getSharedVoiceMicrophoneArbiter();
    const modalityCoordinator = options.modalityCoordinator ?? getPetAssistantModalityCoordinator();
    this.#session = isNativeRealtimeSelected()
      ? new OpenAIRealtimeVoiceAssistantSession({
        provider: options.provider,
        assistant: options.assistant,
        microphoneArbiter,
        privacyIndicator: getSharedVoicePrivacyIndicator(),
        modalityCoordinator,
        transportFactory: (provider) => createElectronVoiceRealtimeTransportFactory({
          negotiate: (sdp, session, signal) => options.provider.negotiateRealtime(provider, sdp, session, signal),
        }),
        turnIdPrefix: `voice-session-${options.sessionId}`,
      })
      : new VoiceAssistantSession({
        conversationId: PET_ASSISTANT_CONVERSATION_ID,
        turnIdPrefix: `voice-session-${options.sessionId}`,
        microphoneArbiter,
        input,
        assistant: adapter,
        synthesizer,
        player: this.#player,
        modalityCoordinator,
      });
    this.#unsubscribeSession = this.#session.subscribe((event) => {
      this.#feedbackReducer?.applyVoiceEvent(event);
      if (event.type === "transcript") {
        this.#conversationController?.applyNormalizedVoiceTranscript({
          type: "transcript",
          sequence: nextVoiceProjectionSequence(),
          conversationId: PET_ASSISTANT_CONVERSATION_ID,
          turnId: event.turnId,
          entryId: `voice-${event.sequence}-${event.turnId}-${event.speaker}`,
          speaker: event.speaker,
          text: event.text,
          status: event.kind,
        });
      }
    });
  }

  get session(): import("./voice-assistant-session.js").VoiceAssistantSessionLike { return this.#session; }

  async shutdown(): Promise<void> {
    await shutdownVoiceAssistantResources(
      () => this.#session.shutdown(),
      this.#unsubscribeSession,
      () => this.#player.shutdown(),
    );
  }

}

let activeHost: VoiceAssistantHostController | null = null;
let stopping: Promise<void> | null = null;
const voiceEventListeners = new Set<(event: VoiceAssistantTalkEvent) => void>();
const voiceEventUnsubscribers = new Map<(event: VoiceAssistantTalkEvent) => void, () => void>();
let voiceProjectionSequence = 0;
let voiceSessionOrdinal = 0;
let activeSessionId = 0;
let feedbackReducer: PetAssistantFeedbackReducer | null = null;
let unsubscribeAssistantFeedback: (() => void) | null = null;

export function startVoiceAssistantHost(provider: HostProviderOperations, assistant: PetAssistantService): VoiceAssistantHostController {
  if (activeHost) return activeHost;
  if (stopping) throw new Error("Voice assistant host shutdown is in progress.");
  feedbackReducer = new PetAssistantFeedbackReducer(defaultPetFeedbackTarget);
  unsubscribeAssistantFeedback = assistant.subscribe((event) => feedbackReducer?.applyAssistantEvent(event));
  activeHost = new VoiceAssistantHostController(() => {
    activeSessionId = ++voiceSessionOrdinal;
    return new VoiceAssistantHost({ provider, assistant, feedbackReducer: feedbackReducer!, sessionId: activeSessionId });
  });
  for (const listener of voiceEventListeners) voiceEventUnsubscribers.set(listener, activeHost.subscribe((event) => listener(addShortcutToEvent(event))));
  info("app", "Voice assistant host ready");
  return activeHost;
}

function isNativeRealtimeSelected(): boolean {
  const settings = getPluginPlatformSettings();
  const selected = settings.selections.text;
  return selected !== null && settings.profiles[selected]?.adapter === "openai-realtime";
}

export function stopVoiceAssistantHost(): Promise<void> {
  if (stopping) return stopping;
  const host = activeHost;
  if (!host) return Promise.resolve();
  stopping = shutdownVoiceAssistantWithCleanup(
    () => host.shutdown(),
    () => {
      for (const unsubscribe of voiceEventUnsubscribers.values()) unsubscribe();
      voiceEventUnsubscribers.clear();
      unsubscribeAssistantFeedback?.();
      unsubscribeAssistantFeedback = null;
      feedbackReducer?.clear();
      feedbackReducer = null;
      getPetAssistantModalityCoordinator().releaseModality("voice");
      setDefaultPetVoiceTerminalFeedback(null);
      if (activeHost === host) activeHost = null;
      activeSessionId = 0;
      info("app", "Voice assistant host stopped");
    },
  ).finally(() => { stopping = null; });
  return stopping!;
}

export function getVoiceAssistantSnapshot(): VoiceAssistantTalkSnapshot {
  return addShortcutSnapshot(activeHost?.session?.snapshot() ?? createIdleVoiceAssistantSnapshot(), activeSessionId);
}

export function onVoiceAssistantEvent(listener: (event: VoiceAssistantTalkEvent) => void): () => void {
  voiceEventListeners.add(listener);
  const unsubscribe = activeHost?.subscribe((event) => listener(addShortcutToEvent(event)));
  if (unsubscribe) voiceEventUnsubscribers.set(listener, unsubscribe);
  else listener({ type: "snapshot", sequence: 0, sessionId: activeSessionId, snapshot: getVoiceAssistantSnapshot() });
  return () => {
    voiceEventListeners.delete(listener);
    voiceEventUnsubscribers.get(listener)?.();
    voiceEventUnsubscribers.delete(listener);
  };
}

export async function startVoiceAssistant(): Promise<VoiceAssistantTalkSnapshot> {
  const host = activeHost;
  if (!host) throw new Error("Voice assistant is still starting.");
  const session = await host.activate();
  const { openControlCenterWindow } = await import("./windows.js");
  openControlCenterWindow("conversation");
  return addShortcutSnapshot(session.snapshot(), activeSessionId);
}

export async function toggleVoiceAssistant(): Promise<VoiceAssistantTalkSnapshot> {
  const host = activeHost;
  if (!host) throw new Error("Voice assistant is still starting.");
  const { openControlCenterWindow } = await import("./windows.js");
  const session = await host.toggle();
  openControlCenterWindow("conversation");
  return addShortcutSnapshot(session?.snapshot() ?? createIdleVoiceAssistantSnapshot(), activeSessionId);
}

export async function muteVoiceAssistant(): Promise<VoiceAssistantTalkSnapshot> {
  return runVoiceAssistantControl((session) => session.mute());
}

export async function unmuteVoiceAssistant(): Promise<VoiceAssistantTalkSnapshot> {
  return runVoiceAssistantControl((session) => session.unmute());
}

export async function interruptVoiceAssistant(): Promise<VoiceAssistantTalkSnapshot> {
  return runVoiceAssistantControl((session) => session.interrupt());
}

export async function endVoiceAssistant(): Promise<VoiceAssistantTalkSnapshot> {
  const host = activeHost;
  if (!host) return getVoiceAssistantSnapshot();
  const { openControlCenterWindow } = await import("./windows.js");
  openControlCenterWindow("conversation");
  await host.end();
  return getVoiceAssistantSnapshot();
}

async function runVoiceAssistantControl(operation: (session: NonNullable<VoiceAssistantHostController["session"]>) => Promise<void>): Promise<VoiceAssistantTalkSnapshot> {
  const host = activeHost;
  if (!host?.session) throw new Error("Voice assistant is not active.");
  const { openControlCenterWindow } = await import("./windows.js");
  openControlCenterWindow("conversation");
  await operation(host.session);
  return getVoiceAssistantSnapshot();
}

function createIdleVoiceAssistantSnapshot(): VoiceAssistantSessionSnapshot {
  return Object.freeze({ status: "ended", activity: null, muted: false, conversationId: PET_ASSISTANT_CONVERSATION_ID, generation: 0, turnId: null, userTranscript: null, assistantTranscript: null, interruptionCount: 0, error: null });
}

function addShortcutSnapshot(snapshot: VoiceAssistantSessionSnapshot, sessionId: number): VoiceAssistantTalkSnapshot {
  const shortcut = getVoiceAssistantShortcutSnapshot();
  return Object.freeze({ ...snapshot, sessionId, shortcut: shortcut.accelerator, shortcutStatus: shortcut.status, shortcutReason: shortcut.reason ?? null });
}

function addShortcutToEvent(event: VoiceAssistantHostEvent): VoiceAssistantTalkEvent {
  return event.type === "snapshot" ? { ...event, snapshot: addShortcutSnapshot(event.snapshot, event.sessionId) } : event;
}

function nextVoiceProjectionSequence(): number { voiceProjectionSequence += 1; return voiceProjectionSequence; }

const defaultPetFeedbackTarget = {
  setActivity: (reaction: import("./local-ipc-protocol.js").OpenPetsReaction | null) => setDefaultPetVoiceActivity(reaction),
  showReaction: (reaction: import("./local-ipc-protocol.js").OpenPetsReaction, message?: string) => {
    if (message) applyExternalPetSay(message, reaction); else applyExternalPetReaction(reaction);
    setDefaultPetVoiceTerminalFeedback(reaction);
  },
  setStatus: (reaction: import("./local-ipc-protocol.js").OpenPetsReaction | null) => applyExternalPetStatusReaction(reaction),
};

class PetWindowVoicePlayer implements VoiceAssistantPlayer {
  readonly #coordinator = new VoiceAssistantPlaybackCoordinator();
  readonly #unsubscribe = subscribePetWindowSpeechCompletion((completion) => {
    this.#coordinator.complete({ owner: completion.window, requestId: completion.requestId, kind: completion.kind, outcome: completion.outcome });
  });

  play(requestId: string, speech: VoiceAssistantSpeech, signal: AbortSignal, onStarted?: () => void): Promise<void> {
    const window = getDefaultPetWindowForPlugins();
    if (!window) return Promise.reject(new Error("No pet window is available for speech."));
    if (signal.aborted) return Promise.reject(new Error("Voice playback was cancelled."));
    const kind = speech.kind;
    const cleanupWindow = installWindowLossHandlers(window, () => this.#coordinator.failOwner(window));
    const playback = this.#coordinator.play(requestId, kind, window, {
      start: () => {
        onStarted?.();
        if (speech.kind === "audio") playPetWindowTtsAudio(window, `data:${speech.mimeType};base64,${Buffer.from(speech.bytes).toString("base64")}`, requestId);
        else speakPetWindowTts(window, speech.text, { requestId });
      },
      stop: () => {
        if (kind === "audio") stopPetWindowTtsAudio(window, requestId);
        else stopPetWindowTts(window, requestId);
      },
    }, getVoicePlaybackTimeoutMs(speech));
    const abort = () => { this.#coordinator.stop(requestId); };
    signal.addEventListener("abort", abort, { once: true });
    void playback.then(() => { signal.removeEventListener("abort", abort); cleanupWindow(); }, () => { signal.removeEventListener("abort", abort); cleanupWindow(); });
    return playback;
  }

  async stop(requestId: string): Promise<void> {
    this.#coordinator.stop(requestId);
  }

  async shutdown(): Promise<void> {
    this.#coordinator.shutdown();
    this.#unsubscribe();
  }
}
