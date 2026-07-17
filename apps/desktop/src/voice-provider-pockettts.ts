import { createEvidence, endpoint, readBoundedAudioResponse, sanitizeProviderError, withTimeout, type VoiceProviderAdapter } from "./voice-provider.js";

export const pocketTtsVoiceProvider: VoiceProviderAdapter = {
  id: "pockettts",
  async health(context) {
    const baseUrl = context.settings.providers.pockettts.baseUrl;
    if (!isLoopbackHttpUrl(baseUrl)) return createEvidence("pockettts", { configured: false, reachable: false, discoverySupported: false, synthesisTested: false, ready: false, method: "loopback-probe", reason: "PocketTTS must use a loopback HTTP URL." });
    const controller = new AbortController();
    const timeout = withTimeout(controller.signal, 2_500);
    try {
      await (context.fetchImpl ?? fetch)(baseUrl, { method: "GET", signal: timeout.signal, redirect: "error" });
      return createEvidence("pockettts", { configured: true, reachable: true, discoverySupported: false, synthesisTested: false, ready: true, method: "loopback-probe" });
    } catch (error) {
      return createEvidence("pockettts", { configured: true, reachable: false, discoverySupported: false, synthesisTested: false, ready: false, method: "loopback-probe", reason: sanitizeProviderError(error) });
    } finally {
      timeout.dispose();
    }
  },
  async listVoices(context) {
    return { supported: false, voices: [], evidence: await this.health(context) };
  },
  async synthesize(request, context) {
    const config = context.settings.providers.pockettts;
    if (!isLoopbackHttpUrl(config.baseUrl)) throw new Error("PocketTTS must use a loopback HTTP URL.");
    const form = new FormData();
    form.set("text", request.text);
    form.set("voice_url", request.useProviderDefault ? config.voiceId : request.voiceId ?? config.voiceId);
    const timeout = withTimeout(request.signal, 60_000);
    try {
      const response = await (context.fetchImpl ?? fetch)(endpoint(config.baseUrl, "/tts"), { method: "POST", body: form, signal: timeout.signal, redirect: "error" });
      const audio = await readBoundedAudioResponse(response);
      return { kind: "audio", ...audio };
    } finally {
      timeout.dispose();
    }
  },
};

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}
