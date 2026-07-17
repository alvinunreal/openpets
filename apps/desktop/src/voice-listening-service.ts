import type { BrowserWindow } from "electron";

import { getDefaultPetWindowForPlugins } from "./default-pet-controller.js";
import type { CompanionOrchestrator } from "./companion-orchestrator.js";
import { getCompanionSettings } from "./companion-settings.js";
import { debug, warn } from "./logger.js";
import { playPetVoiceCue, setPetVoiceListeningState } from "./pet-window.js";
import { resolveInstalledPetVoiceTarget } from "./plugin-pet-registry.js";
import { VoiceCaptureStartGuard } from "./voice-capture-start-guard.js";
import type { VoiceCaptureHandle, VoiceCaptureService } from "./voice-capture.js";
import type { VoiceOutputService } from "./voice-output-service.js";
import { getVoiceSettings } from "./voice-settings.js";
import type { VoiceTranscriptionService } from "./voice-transcription-service.js";

export type VoiceListeningState = "idle" | "starting" | "listening" | "stopping" | "transcribing" | "complete" | "cancelled" | "error";
export type VoiceListeningSnapshot = { readonly state: VoiceListeningState; readonly owner?: "plugin-listen" | "push-to-talk"; readonly petId?: string; readonly startedAt?: number; readonly transcript?: string; readonly response?: string; readonly displayed?: boolean; readonly displayToken?: string; readonly error?: string };

type ActivePushToTalk = { readonly petId: string; readonly handle: VoiceCaptureHandle; readonly window: BrowserWindow };

export class VoiceListeningService {
  readonly #capture: VoiceCaptureService;
  readonly #transcription: VoiceTranscriptionService;
  readonly #output: VoiceOutputService;
  readonly #companion: CompanionOrchestrator;
  readonly #startGuard = new VoiceCaptureStartGuard();
  #snapshot: VoiceListeningSnapshot = { state: "idle" };
  #activePtt: ActivePushToTalk | null = null;
  #transcriptionController: AbortController | null = null;

  constructor(input: { capture: VoiceCaptureService; transcription: VoiceTranscriptionService; output: VoiceOutputService; companion: CompanionOrchestrator }) {
    this.#capture = input.capture;
    this.#transcription = input.transcription;
    this.#output = input.output;
    this.#companion = input.companion;
  }

  getSnapshot(): VoiceListeningSnapshot {
    return this.#snapshot;
  }

  async listenOncePlugin(timeoutMs: number): Promise<{ text: string }> {
    if (this.#startGuard.pending || this.#activePtt || this.#transcriptionController) throw new Error("Another voice activity is already active.");
    const window = getDefaultPetWindowForPlugins();
    const pending = this.#startGuard.begin("plugin-listen");
    let handle: VoiceCaptureHandle | undefined;
    this.#set({ state: "starting", owner: "plugin-listen", startedAt: Date.now() });
    try {
      handle = await this.#capture.start("plugin-listen", timeoutMs);
      if (!await this.#startGuard.accept(pending, handle)) throw abortError();
      if (window) { setPetVoiceListeningState(window, "listening"); playPetVoiceCue(window, "voice-start"); }
      this.#set({ state: "listening", owner: "plugin-listen", startedAt: Date.now() });
      const capture = await handle.result;
      if (window) { playPetVoiceCue(window, "voice-stop"); setPetVoiceListeningState(window, "transcribing"); }
      this.#set({ state: "transcribing", owner: "plugin-listen" });
      const controller = new AbortController();
      this.#transcriptionController = controller;
      const text = await this.#transcription.transcribe(capture, controller.signal);
      this.#set({ state: "complete", owner: "plugin-listen", transcript: text });
      return { text };
    } catch (error) {
      if (handle && this.#snapshot.state === "starting") await handle.cancel("voice-start-failed").catch(() => undefined);
      this.#startGuard.clear(pending);
      this.#set(pending.cancelled || isAbortError(error) || (this.#snapshot.state === "cancelled" && this.#snapshot.owner === "plugin-listen")
        ? { state: "cancelled", owner: "plugin-listen" }
        : { state: "error", owner: "plugin-listen", error: cleanError(error) });
      throw error;
    } finally {
      this.#transcriptionController = null;
      if (window) setPetVoiceListeningState(window, "idle");
      setTimeout(() => { if (this.#snapshot.owner === "plugin-listen") this.#set({ state: "idle" }); }, 1_000).unref?.();
    }
  }

  async startPushToTalk(petId: string): Promise<VoiceListeningSnapshot> {
    if (this.#startGuard.pending || this.#activePtt || this.#transcriptionController) throw new Error("Another voice activity is already active.");
    if (!getCompanionSettings().enabled) throw new Error("Enable Companion before using push-to-talk.");
    const target = resolveInstalledPetVoiceTarget(petId);
    const settings = getVoiceSettings();
    const pending = this.#startGuard.begin("push-to-talk", petId);
    let handle: VoiceCaptureHandle | undefined;
    this.#set({ state: "starting", owner: "push-to-talk", petId, startedAt: Date.now() });
    try {
      if (settings.listening.bargeIn) {
        this.#companion.cancel(petId);
        this.#output.cancel({ kind: "installed-pet", petId });
      }
      handle = await this.#capture.start("push-to-talk", settings.listening.timeoutMs);
      if (!await this.#startGuard.accept(pending, handle)) throw abortError();
      this.#activePtt = { petId, handle, window: target.window };
      setPetVoiceListeningState(target.window, "listening");
      playPetVoiceCue(target.window, "voice-start");
      this.#set({ state: "listening", owner: "push-to-talk", petId, startedAt: Date.now() });
      void handle.result.then(() => this.stopPushToTalk()).catch((error) => this.#failPtt(error));
      return this.#snapshot;
    } catch (error) {
      if (handle && this.#snapshot.state === "starting") await handle.cancel("voice-start-failed").catch(() => undefined);
      this.#startGuard.clear(pending);
      this.#set(pending.cancelled || isAbortError(error)
        ? { state: "cancelled", owner: "push-to-talk", petId }
        : { state: "error", owner: "push-to-talk", petId, error: cleanError(error) });
      throw error;
    }
  }

  async stopPushToTalk(): Promise<VoiceListeningSnapshot> {
    const active = this.#activePtt;
    if (!active) return this.#snapshot;
    this.#activePtt = null;
    this.#set({ state: "stopping", owner: "push-to-talk", petId: active.petId });
    try {
      const capture = await active.handle.stop();
      playPetVoiceCue(active.window, "voice-stop");
      setPetVoiceListeningState(active.window, "transcribing");
      this.#set({ state: "transcribing", owner: "push-to-talk", petId: active.petId });
      const controller = new AbortController();
      this.#transcriptionController = controller;
      const transcript = await this.#transcription.transcribe(capture, controller.signal);
      setPetVoiceListeningState(active.window, "thinking");
      const conversation = await this.#companion.sendUserTurn({ petId: active.petId, text: transcript, kind: "voice", speak: true });
      if (controller.signal.aborted) throw abortError();
      const response = conversation.text;
      this.#set({
        state: "complete",
        owner: "push-to-talk",
        petId: active.petId,
        transcript,
        response,
        displayed: conversation.displayed,
        ...(conversation.displayToken ? { displayToken: conversation.displayToken } : {}),
      });
      return this.#snapshot;
    } catch (error) {
      this.#set(isAbortError(error)
        ? { state: "cancelled", owner: "push-to-talk", petId: active.petId }
        : { state: "error", owner: "push-to-talk", petId: active.petId, error: cleanError(error) });
      throw error;
    } finally {
      this.#transcriptionController = null;
      setPetVoiceListeningState(active.window, "idle");
    }
  }

  async cancel(reason = "cancelled"): Promise<VoiceListeningSnapshot> {
    const pending = this.#startGuard.cancel(reason);
    const active = this.#activePtt;
    this.#activePtt = null;
    this.#transcriptionController?.abort();
    this.#transcriptionController = null;
    const petId = active?.petId ?? (this.#snapshot.owner === "push-to-talk" ? this.#snapshot.petId : undefined);
    if (petId) {
      try { this.#companion.cancel(petId); }
      catch (error) { warn("app", "voice companion cancellation failed", { reason: cleanError(error), petId }); }
    }
    if (active) {
      await active.handle.cancel(reason).catch(() => undefined);
      setPetVoiceListeningState(active.window, "idle");
      this.#set({ state: "cancelled", owner: "push-to-talk", petId: active.petId });
    } else {
      await this.#capture.cancelActive(reason).catch(() => undefined);
      const owner = pending?.owner ?? this.#snapshot.owner;
      if (owner) this.#set({ state: "cancelled", owner, ...(petId ? { petId } : {}) });
    }
    return this.#snapshot;
  }

  async shutdown(): Promise<void> {
    await this.cancel("shutdown");
    this.#set({ state: "idle" });
  }

  #failPtt(error: unknown): void {
    const active = this.#activePtt;
    if (!active && this.#snapshot.owner === "push-to-talk" && this.#snapshot.state === "cancelled") return;
    this.#activePtt = null;
    if (active) setPetVoiceListeningState(active.window, "idle");
    warn("app", "push-to-talk capture failed", { reason: cleanError(error) });
    this.#set({ state: "error", owner: "push-to-talk", petId: active?.petId, error: cleanError(error) });
  }

  #set(snapshot: VoiceListeningSnapshot): void {
    this.#snapshot = snapshot;
    debug("app", "voice listening state", { state: snapshot.state, owner: snapshot.owner, petId: snapshot.petId });
  }
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/[^\s]+/g, "provider endpoint").slice(0, 240);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Voice activity was cancelled.");
  error.name = "AbortError";
  return error;
}
