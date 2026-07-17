import type { PluginAiGateway } from "./plugin-ai-gateway.js";
import { getVoiceListeningService, getVoiceOutputService } from "./voice-platform.js";

/**
 * Plugin voice (§13.5). TTS routes through the host voice platform. STT remains
 * strictly one-shot: the shared capture service owns the only temporary media
 * session and the always-visible privacy indicator. Never ambient.
 */

export async function pluginVoiceSpeak(text: string, opts: { pluginId: string; voice?: string; rate?: number; petHandleId?: string }): Promise<void> {
  const output = getVoiceOutputService();
  if (!output) throw new Error("Voice platform is unavailable.");
  const result = await output.speak({
    text,
    reason: "plugin",
    target: opts.petHandleId ? { kind: "plugin-pet", pluginId: opts.pluginId, petHandleId: opts.petHandleId } : { kind: "default" },
    requestedVoiceId: opts.voice,
    requestedRate: opts.rate,
  });
  if (!result.ok) throw new Error(result.attempts.at(-1)?.message ?? "Voice output failed.");
}

export function pluginVoiceStop(): void {
  getVoiceOutputService()?.cancel({ kind: "default" });
}

let listenInProgress = false;

export async function pluginVoiceListen(_gateway: PluginAiGateway, opts: { timeoutMs: number }): Promise<{ text: string }> {
  if (listenInProgress) throw new Error("A voice capture is already in progress.");
  listenInProgress = true;
  try {
    const listening = getVoiceListeningService();
    if (!listening) throw new Error("Voice listening is unavailable.");
    return await listening.listenOncePlugin(opts.timeoutMs);
  } finally {
    listenInProgress = false;
  }
}
