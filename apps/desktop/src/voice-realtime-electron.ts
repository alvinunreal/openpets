import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, ipcMain, session, type IpcMainEvent } from "electron";

import type {
  VoiceConversationEvent,
  VoiceConversationTransport,
  VoiceConversationTransportContext,
  VoiceConversationTransportFactory,
  VoiceRealtimeSessionConfig,
} from "./voice-conversation.js";

const VOICE_REALTIME_PARTITION_PREFIX = "openpets-voice-realtime-";
const VOICE_REALTIME_COMMAND_CHANNEL = "openpets:voice-realtime-command";
const VOICE_REALTIME_EVENT_CHANNEL = "openpets:voice-realtime-event";
const VOICE_REALTIME_MAX_SDP_BYTES = 256 * 1024;

export const VOICE_REALTIME_RENDERER_CLOSE_TIMEOUT_MS = 500;

export type VoiceRealtimeNegotiator = (sdp: string, session: VoiceRealtimeSessionConfig, signal: AbortSignal) => Promise<string>;

export type ElectronVoiceRealtimeTransportOptions = {
  readonly negotiate: VoiceRealtimeNegotiator;
  readonly rendererCloseTimeoutMs?: number;
};

export function createElectronVoiceRealtimeTransportFactory(options: ElectronVoiceRealtimeTransportOptions): VoiceConversationTransportFactory {
  return (context) => new ElectronVoiceRealtimeTransport(context, options);
}

class ElectronVoiceRealtimeTransport implements VoiceConversationTransport {
  readonly #context: VoiceConversationTransportContext;
  readonly #options: ElectronVoiceRealtimeTransportOptions;
  readonly #window: BrowserWindow;
  readonly #voiceSession: Electron.Session;
  readonly #documentUrl: string;
  readonly #rendererClosed: Promise<void>;
  readonly #resolveRendererClosed: () => void;
  readonly #startCompletion: Promise<void>;
  readonly #resolveStart: () => void;
  readonly #rejectStartCompletion: (error: unknown) => void;
  readonly #eventHandler: (event: IpcMainEvent, payload: unknown) => void;
  #startSettled = false;
  #startCalled = false;
  #loaded = false;
  #microphoneReady = false;
  #desiredMuted = false;
  #closing = false;
  #closePromise: Promise<void> | null = null;

  constructor(context: VoiceConversationTransportContext, options: ElectronVoiceRealtimeTransportOptions) {
    this.#context = context;
    this.#options = options;
    const htmlPath = join(app.getAppPath(), "assets", "voice-realtime.html");
    const preloadPath = join(app.getAppPath(), "voice-realtime-preload.cjs");
    this.#documentUrl = pathToFileURL(htmlPath).toString();
    const partition = `${VOICE_REALTIME_PARTITION_PREFIX}${context.sessionId}`;
    this.#voiceSession = session.fromPartition(partition, { cache: false });
    this.#voiceSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(permission === "media" && contents?.getURL() === this.#documentUrl && isAudioOnlyMediaRequest(details));
    });
    this.#voiceSession.setPermissionCheckHandler((contents, permission, _requestingOrigin, details) =>
      permission === "media" && contents?.getURL() === this.#documentUrl && details?.mediaType === "audio");
    this.#window = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        preload: preloadPath,
        partition,
      },
    });
    this.#window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.#window.webContents.on("will-navigate", (event) => event.preventDefault());
    this.#window.webContents.on("will-redirect", (event) => event.preventDefault());

    let resolveRendererClosed!: () => void;
    this.#rendererClosed = new Promise<void>((resolve) => { resolveRendererClosed = resolve; });
    this.#resolveRendererClosed = resolveRendererClosed;
    let resolveStart!: () => void;
    let rejectStart!: (error: unknown) => void;
    this.#startCompletion = new Promise<void>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    this.#resolveStart = resolveStart;
    this.#rejectStartCompletion = rejectStart;
    void this.#startCompletion.catch(() => undefined);

    this.#eventHandler = (event, payload) => this.#handleRendererEvent(event, payload);
    ipcMain.on(VOICE_REALTIME_EVENT_CHANNEL, this.#eventHandler);
    this.#window.once("closed", () => {
      this.#resolveRendererClosed();
      if (!this.#closing) this.#context.emit({ type: "closed", reason: "The realtime voice renderer closed unexpectedly." });
    });
    this.#window.webContents.on("render-process-gone", () => {
      this.#resolveRendererClosed();
      if (!this.#closing) this.#fail(new Error("The realtime voice renderer exited unexpectedly."));
    });
  }

  async start(): Promise<void> {
    if (this.#startCalled) throw new Error("The realtime voice transport has already started.");
    this.#startCalled = true;
    if (this.#context.signal.aborted) throw new Error("Voice realtime transport was cancelled.");

    const startPromise = this.#startInternal();
    void startPromise.catch(() => undefined);
    let abortListener: (() => void) | null = null;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(new Error("Voice realtime transport was cancelled."));
      if (this.#context.signal.aborted) abortListener();
      else this.#context.signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      await Promise.race([startPromise, this.#startCompletion, abortPromise]);
    } finally {
      if (abortListener) this.#context.signal.removeEventListener("abort", abortListener);
    }
  }

  setMuted(muted: boolean): void {
    this.#desiredMuted = muted;
    this.#sendMuteIfReady();
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#rejectStartOnce(new Error("Voice realtime transport was closed."));
    this.#closePromise = (async () => {
      try {
        if (this.#loaded && !this.#window.isDestroyed()) {
          try { this.#window.webContents.send(VOICE_REALTIME_COMMAND_CHANNEL, { type: "close", sessionId: this.#context.sessionId }); } catch { /* renderer may already be gone */ }
          await Promise.race([this.#rendererClosed, delay(this.#options.rendererCloseTimeoutMs ?? VOICE_REALTIME_RENDERER_CLOSE_TIMEOUT_MS)]);
        }
      } finally {
        if (!this.#window.isDestroyed()) this.#window.destroy();
        ipcMain.removeListener(VOICE_REALTIME_EVENT_CHANNEL, this.#eventHandler);
        await this.#voiceSession.clearStorageData().catch(() => undefined);
      }
    })();
    await this.#closePromise;
  }

  async #startInternal(): Promise<void> {
    try {
      await this.#window.loadFile(join(app.getAppPath(), "assets", "voice-realtime.html"));
      if (this.#closing || this.#context.signal.aborted) throw new Error("Voice realtime transport was cancelled.");
      this.#loaded = true;
      this.#window.webContents.send(VOICE_REALTIME_COMMAND_CHANNEL, { type: "start", sessionId: this.#context.sessionId });
      await this.#startCompletion;
    } catch (error) {
      throw normalizeError(error);
    }
  }

  #handleRendererEvent(event: IpcMainEvent, payload: unknown): void {
    if (event.sender !== this.#window.webContents || !isRecord(payload) || payload.sessionId !== this.#context.sessionId || this.#closing) return;
    const type = payload.type;
    if (type === "microphone-acquired") {
      this.#microphoneReady = true;
      this.#sendMuteIfReady();
      this.#context.emit({ type: "microphone-acquired" });
      return;
    }
    if (type === "negotiating") {
      this.#context.emit({ type: "negotiating" });
      return;
    }
    if (type === "offer") {
      if (typeof payload.sdp !== "string" || !isValidSdp(payload.sdp)) {
        this.#fail(new Error("The realtime voice renderer produced an invalid session description."));
        return;
      }
      void this.#negotiate(payload.sdp);
      return;
    }
    if (type === "connected") {
      this.#resolveStartOnce();
      this.#context.emit({ type: "connected" });
      return;
    }
    if (type === "error") {
      this.#fail(typeof payload.error === "string" ? payload.error : "Realtime voice renderer failed.");
      return;
    }
    if (type === "closed") {
      this.#resolveRendererClosed();
      this.#rejectStartOnce(new Error("The realtime voice renderer closed unexpectedly."));
      this.#context.emit({ type: "closed", reason: "The realtime voice renderer closed unexpectedly." });
      return;
    }
    if (type === "microphone-released") {
      this.#context.emit({ type: "microphone-released" });
      return;
    }
    if (isConversationEvent(type)) this.#context.emit({ type } as VoiceConversationEvent);
  }

  async #negotiate(offer: string): Promise<void> {
    if (this.#closing || this.#context.signal.aborted) return;
    try {
      const answer = await this.#options.negotiate(offer, this.#context.session, this.#context.signal);
      if (this.#closing || this.#context.signal.aborted) return;
      if (!isValidSdp(answer)) throw new Error("OpenAI realtime negotiation returned an invalid session description.");
      this.#window.webContents.send(VOICE_REALTIME_COMMAND_CHANNEL, { type: "answer", sessionId: this.#context.sessionId, sdp: answer });
    } catch (error) {
      this.#fail(error);
    }
  }

  #fail(error: unknown): void {
    if (this.#closing) return;
    const normalized = normalizeError(error);
    this.#rejectStartOnce(normalized);
    this.#context.emit({ type: "error", error: normalized });
  }

  #resolveStartOnce(): void {
    if (this.#startSettled) return;
    this.#startSettled = true;
    this.#resolveStart();
  }

  #rejectStartOnce(error: unknown): void {
    if (this.#startSettled) return;
    this.#startSettled = true;
    this.#rejectStartCompletion(error);
  }

  #sendMuteIfReady(): void {
    if (!this.#microphoneReady || this.#closing || this.#window.isDestroyed()) return;
    this.#window.webContents.send(VOICE_REALTIME_COMMAND_CHANNEL, { type: "mute", sessionId: this.#context.sessionId, muted: this.#desiredMuted });
  }
}

function isConversationEvent(value: unknown): value is Exclude<VoiceConversationEvent["type"], "microphone-acquired" | "microphone-released" | "negotiating" | "connected" | "error" | "closed"> {
  return value === "speech-started"
    || value === "speech-stopped"
    || value === "response-started"
    || value === "response-audio-started"
    || value === "response-audio-stopped"
    || value === "response-completed"
    || value === "interrupted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAudioOnlyMediaRequest(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.mediaTypes)) return false;
  return value.mediaTypes.length === 1 && value.mediaTypes[0] === "audio";
}

function isValidSdp(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= VOICE_REALTIME_MAX_SDP_BYTES && /^v=0(?:\r?\n|$)/.test(value) && !value.includes("\0");
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}
