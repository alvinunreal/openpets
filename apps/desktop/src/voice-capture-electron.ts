import { BrowserWindow, session } from "electron";

import { debug } from "./logger.js";
import {
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MIN_AUDIO_BYTES,
  type VoiceCaptureAttempt,
  type VoiceCaptureFactory,
  type VoiceCaptureRecording,
  type VoiceCaptureResult,
} from "./voice-capture.js";

const captureHtml = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">`;

const acquireScript = `(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  if (globalThis.__openPetsVoiceCaptureCancelled === true) {
    for (const track of stream.getTracks()) track.stop();
    return false;
  }
  const state = { stream, recorder: null, chunks: [], stopped: false, resolveStopped: null };
  globalThis.__openPetsVoiceCapture = state;
  return true;
})()`;

const cancelScript = `(() => {
  globalThis.__openPetsVoiceCaptureCancelled = true;
  const state = globalThis.__openPetsVoiceCapture;
  if (state) {
    state.cancelled = true;
    if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
    for (const track of state.stream.getTracks()) track.stop();
    state.resolveStopped?.();
  }
  return true;
})()`;

const stopScript = `(() => {
  const state = globalThis.__openPetsVoiceCapture;
  if (!state) return false;
  if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
  else state.resolveStopped?.();
  return true;
})()`;

function recordScript(durationMs: number): string {
  return `(async () => {
    const state = globalThis.__openPetsVoiceCapture;
    if (!state || globalThis.__openPetsVoiceCaptureCancelled === true) return "";
    const requestedMimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    state.recorder = requestedMimeType ? new MediaRecorder(state.stream, { mimeType: requestedMimeType }) : new MediaRecorder(state.stream);
    state.chunks = [];
    const stopped = new Promise((resolve) => {
      state.resolveStopped = resolve;
      state.recorder.onstop = resolve;
    });
    state.recorder.ondataavailable = (event) => { if (event.data.size > 0) state.chunks.push(event.data); };
    state.recorder.start();
    const timer = setTimeout(() => {
      if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
      else state.resolveStopped?.();
    }, ${durationMs});
    await stopped;
    clearTimeout(timer);
    for (const track of state.stream.getTracks()) track.stop();
    if (state.cancelled || globalThis.__openPetsVoiceCaptureCancelled === true) return "";
    const mimeType = state.recorder.mimeType || "audio/webm";
    const bytes = new Uint8Array(await new Blob(state.chunks, { type: mimeType }).arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return JSON.stringify({ base64: btoa(binary), mimeType });
  })()`;
}

type ElectronCaptureAttempt = VoiceCaptureAttempt & {
  readonly partition: string;
};

export function createElectronVoiceCaptureFactory(): VoiceCaptureFactory {
  return (durationMs, onLive) => {
    const partition = `openpets-voice-capture:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const captureSession = session.fromPartition(partition, { cache: false });
    captureSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "media"));
    captureSession.setPermissionCheckHandler((_contents, permission) => permission === "media");
    const window = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition },
    });
    let cancelled = false;
    let disposed = false;
    let recording: VoiceCaptureRecording | null = null;

    const execute = async <T>(script: string): Promise<T> => {
      if (window.isDestroyed()) throw new Error("Voice capture window closed unexpectedly.");
      return window.webContents.executeJavaScript(script, true) as Promise<T>;
    };
    const destroyWindow = (): void => {
      if (!window.isDestroyed()) window.destroy();
    };

    const attempt: ElectronCaptureAttempt = {
      partition,
      async acquire() {
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(captureHtml)}`);
        const acquired = await execute<boolean>(acquireScript);
        if (!acquired || cancelled || !onLive()) {
          await attempt.cancel();
          throw new Error("Voice capture was cancelled before microphone acquisition.");
        }
        debug("plugin", "voice microphone acquired", { durationMs });
        const recordingResult = execute<string>(recordScript(durationMs)).then((encoded) => {
          let payload: { base64?: unknown; mimeType?: unknown } = {};
          try { payload = JSON.parse(encoded) as { base64?: unknown; mimeType?: unknown }; } catch { /* treat malformed output as empty audio */ }
          const base64 = typeof payload.base64 === "string" ? payload.base64 : "";
          const mimeType = typeof payload.mimeType === "string" && /^audio\/[A-Za-z0-9.+-]+(?:;[A-Za-z0-9=.+_-]+)*$/.test(payload.mimeType) ? payload.mimeType : "audio/webm";
          const bytes = Buffer.from(base64, "base64");
          if (bytes.byteLength < VOICE_MIN_AUDIO_BYTES) throw new Error("Voice capture produced no audio.");
          if (bytes.byteLength > VOICE_MAX_AUDIO_BYTES) throw new Error("Voice capture is too large.");
          return { bytes, mimeType } satisfies VoiceCaptureResult;
        });
        recording = {
          result: recordingResult,
          stop: async () => {
            await execute<boolean>(stopScript).catch(() => false);
            return recordingResult;
          },
          cancel: async () => {
            cancelled = true;
            destroyWindow();
            await execute<boolean>(cancelScript).catch(() => false);
          },
          close: async () => {
            cancelled = true;
            destroyWindow();
            await execute<boolean>(cancelScript).catch(() => false);
          },
        };
        return recording;
      },
      async cancel() {
        cancelled = true;
        destroyWindow();
        await execute<boolean>(cancelScript).catch(() => false);
        if (recording) await recording.cancel().catch(() => undefined);
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        destroyWindow();
        await captureSession.clearStorageData().catch(() => undefined);
      },
    };
    return attempt;
  };
}
