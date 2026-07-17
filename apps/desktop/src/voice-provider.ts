import type { BrowserWindow } from "electron";

import type { PluginSecretsStore } from "./plugin-secrets.js";
import type { VoiceProviderId, VoiceSettings } from "./voice-settings.js";

export const maxVoiceAudioBytes = 10 * 1024 * 1024;

export type VoiceCapabilityEvidence = {
  readonly providerId: VoiceProviderId;
  readonly checkedAt: number;
  readonly expiresAt: number;
  readonly configured: boolean;
  readonly reachable: boolean;
  readonly authenticated?: boolean;
  readonly discoverySupported: boolean;
  readonly discoveryOk?: boolean;
  readonly synthesisTested: boolean;
  readonly ready: boolean;
  readonly method: string;
  readonly version?: string;
  readonly reason?: string;
};

export type VoiceInfo = { readonly id: string; readonly label: string; readonly language?: string };
export type VoiceSynthesisResult =
  | { readonly kind: "system"; readonly text: string; readonly voiceId?: string; readonly rate?: number }
  | { readonly kind: "audio"; readonly bytes: Uint8Array; readonly mimeType: string };

export type VoiceProviderContext = {
  readonly settings: VoiceSettings;
  readonly secrets: PluginSecretsStore;
  readonly targetWindow?: BrowserWindow;
  readonly fetchImpl?: typeof fetch;
  readonly listSystemVoices?: (window: BrowserWindow) => Promise<VoiceInfo[]>;
};

export type VoiceSynthesisRequest = {
  readonly text: string;
  readonly voiceId?: string;
  readonly model?: string;
  readonly rate?: number;
  readonly useProviderDefault?: boolean;
  readonly signal: AbortSignal;
};

export interface VoiceProviderAdapter {
  readonly id: VoiceProviderId;
  health(context: VoiceProviderContext): Promise<VoiceCapabilityEvidence>;
  listVoices(context: VoiceProviderContext): Promise<{ readonly supported: boolean; readonly voices: VoiceInfo[]; readonly evidence: VoiceCapabilityEvidence }>;
  synthesize(request: VoiceSynthesisRequest, context: VoiceProviderContext): Promise<VoiceSynthesisResult>;
}

export function createEvidence(providerId: VoiceProviderId, input: Omit<VoiceCapabilityEvidence, "providerId" | "checkedAt" | "expiresAt">): VoiceCapabilityEvidence {
  const checkedAt = Date.now();
  return { providerId, checkedAt, expiresAt: checkedAt + 30_000, ...input };
}

export async function readBoundedAudioResponse(response: Response): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}.`);
  const mimeType = (response.headers.get("content-type") ?? "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
  if (!mimeType.startsWith("audio/") && mimeType !== "application/octet-stream") throw new Error("Provider returned a non-audio response.");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxVoiceAudioBytes) throw new Error("Provider audio response is too large.");
  if (!response.body) throw new Error("Provider returned empty audio.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxVoiceAudioBytes) {
        await reader.cancel("Provider audio response is too large.");
        throw new Error("Provider audio response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("Provider returned empty audio.");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, mimeType };
}

export function sanitizeProviderError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Voice request was cancelled.";
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/gi, "provider endpoint").replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]").slice(0, 240);
}

export function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export function withTimeout(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Voice provider timed out.")), timeoutMs);
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener("abort", abort); } };
}
