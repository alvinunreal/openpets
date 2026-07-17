import type { VoiceCaptureResult } from "./voice-capture.js";

type VoiceTranscriptionGateway = {
  transcribe(audio: Uint8Array, mimeType: string, options?: { readonly signal?: AbortSignal }): Promise<string>;
};

export class VoiceTranscriptionService {
  readonly #gateway: VoiceTranscriptionGateway;

  constructor(gateway: VoiceTranscriptionGateway) {
    this.#gateway = gateway;
  }

  async transcribe(capture: VoiceCaptureResult, signal?: AbortSignal): Promise<string> {
    const text = (await this.#gateway.transcribe(capture.bytes, capture.mimeType, { signal })).trim();
    if (!text) throw new Error("No speech was recognized.");
    return text.slice(0, 8_000);
  }
}
