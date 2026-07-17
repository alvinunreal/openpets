import { BrowserWindow, session } from "electron";

import { debug } from "./logger.js";
import type { VoicePrivacyIndicator } from "./voice-privacy-indicator.js";

export type VoiceCaptureOwner = "plugin-listen" | "push-to-talk" | "wake";
export type VoiceCaptureResult = { readonly bytes: Uint8Array; readonly mimeType: "audio/webm"; readonly durationMs: number };
export type VoiceCaptureHandle = { readonly owner: VoiceCaptureOwner; readonly result: Promise<VoiceCaptureResult>; stop(): Promise<VoiceCaptureResult>; cancel(reason?: string): Promise<void> };

type ActiveCapture = {
  readonly generation: number;
  readonly owner: VoiceCaptureOwner;
  readonly window: BrowserWindow;
  readonly partition: string;
  readonly startedAt: number;
  readonly result: Promise<VoiceCaptureResult>;
  readonly resolve: (result: VoiceCaptureResult) => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  finishing: Promise<VoiceCaptureResult> | null;
};

export class VoiceCaptureService {
  readonly #indicator: VoicePrivacyIndicator;
  #active: ActiveCapture | null = null;
  #generation = 0;

  constructor(indicator: VoicePrivacyIndicator) {
    this.#indicator = indicator;
  }

  async start(owner: VoiceCaptureOwner, timeoutMs: number): Promise<VoiceCaptureHandle> {
    if (this.#active) throw new Error("A voice capture is already in progress.");
    const duration = Math.min(30_000, Math.max(1_000, Math.round(timeoutMs)));
    const generation = ++this.#generation;
    const partition = `openpets-voice-capture:${Date.now()}:${generation}`;
    const captureSession = session.fromPartition(partition, { cache: false });
    captureSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "media"));
    captureSession.setPermissionCheckHandler((_contents, permission) => permission === "media");
    const window = new BrowserWindow({ show: false, width: 1, height: 1, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition } });
    let resolveResult!: (result: VoiceCaptureResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<VoiceCaptureResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const idleTimer = setTimeout(() => undefined, 15_000);
    idleTimer.unref?.();
    const active: ActiveCapture = { generation, owner, window, partition, startedAt: Date.now(), result, resolve: resolveResult, reject: rejectResult, timer: idleTimer, finishing: null };
    this.#active = active;
    try {
      const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">`;
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      let acquisitionTimer: NodeJS.Timeout | undefined;
      await Promise.race([window.webContents.executeJavaScript(`(async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
        const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        const chunks = [];
        recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
        recorder.start();
        window.__openPetsVoiceCapture = { stream, recorder, chunks };
        return true;
      })()`, true), new Promise<never>((_resolve, reject) => {
        acquisitionTimer = setTimeout(() => reject(new Error("Microphone acquisition timed out.")), 15_000);
        acquisitionTimer.unref?.();
      })]).finally(() => { if (acquisitionTimer) clearTimeout(acquisitionTimer); });
      if (this.#active !== active) throw new Error("Voice capture was cancelled before microphone acquisition.");
      this.#indicator.trackStarted();
      debug("app", "voice capture live", { owner, timeoutMs: duration, generation });
      clearTimeout(active.timer);
      active.timer = setTimeout(() => { void this.#finish(active, false).catch(() => undefined); }, duration);
      return {
        owner,
        result,
        stop: () => this.#finish(active, false),
        cancel: async (reason) => { debug("app", "voice capture cancelled", { owner, reason, generation }); await this.#finish(active, true).then(() => undefined, () => undefined); },
      };
    } catch (error) {
      await this.#teardown(active, false);
      throw error;
    }
  }

  async captureOneShot(owner: VoiceCaptureOwner, timeoutMs: number): Promise<VoiceCaptureResult> {
    return (await this.start(owner, timeoutMs)).result;
  }

  async cancelActive(reason = "shutdown"): Promise<void> {
    const active = this.#active;
    if (!active) return;
    debug("app", "active voice capture cancelled", { owner: active.owner, reason, generation: active.generation });
    await this.#finish(active, true).then(() => undefined, () => undefined);
  }

  async shutdown(): Promise<void> {
    await this.cancelActive("shutdown");
  }

  #finish(active: ActiveCapture, cancelled: boolean): Promise<VoiceCaptureResult> {
    if (active.finishing) return active.finishing;
    active.finishing = (async () => {
      clearTimeout(active.timer);
      try {
        if (active.window.isDestroyed()) throw new Error("Voice capture window closed unexpectedly.");
        const base64 = await active.window.webContents.executeJavaScript(`(async () => {
          const state = window.__openPetsVoiceCapture;
          if (!state) return "";
          const stopped = new Promise((resolve) => { state.recorder.onstop = resolve; });
          if (state.recorder.state !== "inactive") state.recorder.stop(); else state.recorder.onstop();
          await stopped;
          for (const track of state.stream.getTracks()) track.stop();
          if (${cancelled ? "true" : "false"}) return "";
          const blob = new Blob(state.chunks, { type: "audio/webm" });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
          return btoa(binary);
        })()`, true) as string;
        if (cancelled) throw new Error("Voice capture was cancelled.");
        const bytes = Buffer.from(base64, "base64");
        if (bytes.byteLength < 128) throw new Error("Voice capture produced no audio.");
        if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Voice capture is too large.");
        const capture = { bytes, mimeType: "audio/webm" as const, durationMs: Date.now() - active.startedAt };
        active.resolve(capture);
        return capture;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        active.reject(normalized);
        throw normalized;
      } finally {
        await this.#teardown(active, true);
      }
    })();
    return active.finishing;
  }

  async #teardown(active: ActiveCapture, hadLiveTrack: boolean): Promise<void> {
    clearTimeout(active.timer);
    if (this.#active === active) this.#active = null;
    if (hadLiveTrack) this.#indicator.trackStopped();
    if (!active.window.isDestroyed()) active.window.destroy();
    await session.fromPartition(active.partition).clearStorageData().catch(() => undefined);
  }
}
