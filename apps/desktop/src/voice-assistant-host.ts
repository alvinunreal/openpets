import { getDefaultPetWindowForPlugins, setDefaultPetVoiceActivity } from "./default-pet-controller.js";
import { info, warn } from "./logger.js";
import type { PetAssistantService } from "./pet-assistant-service.js";
import type { HostProviderOperations } from "./provider-service.js";
import { playPetWindowTtsAudio, speakPetWindowTts, stopPetWindowTts, stopPetWindowTtsAudio, subscribePetWindowSpeechCompletion } from "./pet-window.js";
import type { VoiceAssistantPlayer, VoiceAssistantSpeech } from "./voice-assistant-session.js";
import { VoiceAssistantSession, type VoiceAssistantActivity } from "./voice-assistant-session.js";
import { getVoicePlaybackTimeoutMs, VoiceAssistantPlaybackCoordinator } from "./voice-assistant-playback.js";
import { installWindowLossHandlers } from "./voice-playback-window.js";
import { HostVoiceInput, PetAssistantVoiceAdapter, ProviderVoiceSynthesizer, reactionForVoiceActivity, VoiceAssistantHostController } from "./voice-assistant-host-core.js";
import type { VoiceCaptureService } from "./voice-capture.js";
import { getSharedVoiceCaptureService, getSharedVoiceMicrophoneArbiter } from "./plugin-voice.js";
import type { VoiceMicrophoneArbiter } from "./voice-microphone-arbiter.js";

export type VoiceAssistantHostOptions = {
  readonly provider: HostProviderOperations;
  readonly assistant: PetAssistantService;
  readonly microphoneArbiter?: VoiceMicrophoneArbiter;
  readonly capture?: VoiceCaptureService;
  readonly activityReaction?: (activity: VoiceAssistantActivity | null) => void;
};

/** Host-private composition of bounded voice I/O, Pet Assistant, and pet speech. */
export class VoiceAssistantHost {
  readonly #player: PetWindowVoicePlayer;
  readonly #session: VoiceAssistantSession;
  readonly #activityReaction: (activity: VoiceAssistantActivity | null) => void;
  readonly #unsubscribeSession: () => void;

  constructor(options: VoiceAssistantHostOptions) {
    this.#activityReaction = options.activityReaction ?? ((activity) => setDefaultPetVoiceActivity(activity ? reactionForVoiceActivity(activity) : null));
    const input = new HostVoiceInput(options.provider, options.capture ?? getSharedVoiceCaptureService());
    const adapter = new PetAssistantVoiceAdapter(options.assistant);
    const synthesizer = new ProviderVoiceSynthesizer(options.provider);
    this.#player = new PetWindowVoicePlayer();
    this.#session = new VoiceAssistantSession({
      microphoneArbiter: options.microphoneArbiter ?? getSharedVoiceMicrophoneArbiter(),
      input,
      assistant: adapter,
      synthesizer,
      player: this.#player,
    });
    this.#unsubscribeSession = this.#session.subscribe((event) => {
      if (event.type === "snapshot") this.#setActivity(event.snapshot.activity);
    });
  }

  get session(): VoiceAssistantSession { return this.#session; }

  async shutdown(): Promise<void> {
    await this.#session.shutdown();
    this.#unsubscribeSession();
    await this.#player.shutdown();
  }

  #setActivity(activity: VoiceAssistantActivity | null): void {
    try { this.#activityReaction(activity); } catch (error) { warn("app", "Voice assistant activity reaction failed", { activity, reason: error instanceof Error ? error.message : "unknown" }); }
  }
}

let activeHost: VoiceAssistantHostController | null = null;
let stopping: Promise<void> | null = null;

export function startVoiceAssistantHost(provider: HostProviderOperations, assistant: PetAssistantService): VoiceAssistantHostController {
  if (activeHost) return activeHost;
  if (stopping) throw new Error("Voice assistant host shutdown is in progress.");
  activeHost = new VoiceAssistantHostController(() => new VoiceAssistantHost({ provider, assistant }));
  info("app", "Voice assistant host ready");
  return activeHost;
}

export function stopVoiceAssistantHost(): Promise<void> {
  if (stopping) return stopping;
  const host = activeHost;
  if (!host) return Promise.resolve();
  stopping = host.shutdown().then(() => {
    if (activeHost === host) activeHost = null;
    info("app", "Voice assistant host stopped");
  }).finally(() => { stopping = null; });
  return stopping;
}

class PetWindowVoicePlayer implements VoiceAssistantPlayer {
  readonly #coordinator = new VoiceAssistantPlaybackCoordinator();
  readonly #unsubscribe = subscribePetWindowSpeechCompletion((completion) => {
    this.#coordinator.complete({ owner: completion.window, requestId: completion.requestId, kind: completion.kind, outcome: completion.outcome });
  });

  play(requestId: string, speech: VoiceAssistantSpeech, signal: AbortSignal): Promise<void> {
    const window = getDefaultPetWindowForPlugins();
    if (!window) return Promise.reject(new Error("No pet window is available for speech."));
    if (signal.aborted) return Promise.reject(new Error("Voice playback was cancelled."));
    const kind = speech.kind;
    const cleanupWindow = installWindowLossHandlers(window, () => this.#coordinator.failOwner(window));
    const playback = this.#coordinator.play(requestId, kind, window, {
      start: () => {
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
