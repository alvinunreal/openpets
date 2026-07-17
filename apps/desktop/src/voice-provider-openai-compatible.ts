import { createEvidence, endpoint, readBoundedAudioResponse, withTimeout, type VoiceProviderAdapter } from "./voice-provider.js";
import { getVoiceSecret } from "./voice-secrets.js";

export const openAiCompatibleVoiceProvider: VoiceProviderAdapter = {
  id: "openai-compatible",
  async health(context) {
    const config = context.settings.providers["openai-compatible"];
    const key = await getVoiceSecret(context.secrets, "openai-compatible");
    const configured = Boolean(config.baseUrl && config.model && config.voiceId);
    return createEvidence("openai-compatible", { configured, reachable: false, authenticated: key ? undefined : false, discoverySupported: false, synthesisTested: false, ready: configured, method: "configuration", reason: configured ? (key ? undefined : "No API key is stored; keyless local endpoints may still work.") : "Base URL, model, and voice are required." });
  },
  async listVoices(context) {
    return { supported: false, voices: [], evidence: await this.health(context) };
  },
  async synthesize(request, context) {
    const config = context.settings.providers["openai-compatible"];
    const key = await getVoiceSecret(context.secrets, "openai-compatible");
    const timeout = withTimeout(request.signal, 45_000);
    try {
      const response = await (context.fetchImpl ?? fetch)(endpoint(config.baseUrl, "/audio/speech"), {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: request.model ?? config.model, input: request.text, voice: request.useProviderDefault ? config.voiceId : request.voiceId ?? config.voiceId, response_format: "mp3" }),
        signal: timeout.signal,
        redirect: "error",
      });
      const audio = await readBoundedAudioResponse(response);
      return { kind: "audio", ...audio };
    } finally {
      timeout.dispose();
    }
  },
};
