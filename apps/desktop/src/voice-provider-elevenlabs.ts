import { createEvidence, endpoint, readBoundedAudioResponse, sanitizeProviderError, withTimeout, type VoiceInfo, type VoiceProviderAdapter } from "./voice-provider.js";
import { getVoiceSecret } from "./voice-secrets.js";

export const elevenLabsVoiceProvider: VoiceProviderAdapter = {
  id: "elevenlabs",
  async health(context) {
    const config = context.settings.providers.elevenlabs;
    const key = await getVoiceSecret(context.secrets, "elevenlabs");
    if (!key) return createEvidence("elevenlabs", { configured: Boolean(config.voiceId), reachable: false, authenticated: false, discoverySupported: true, synthesisTested: false, ready: false, method: "credentials", reason: "An ElevenLabs API key is required." });
    try {
      const result = await listElevenLabsVoices(context, key, 1);
      return createEvidence("elevenlabs", { configured: Boolean(config.voiceId), reachable: true, authenticated: true, discoverySupported: true, discoveryOk: true, synthesisTested: false, ready: Boolean(config.voiceId), method: "voices-api", reason: config.voiceId ? undefined : "Select an ElevenLabs voice." , version: result.version });
    } catch (error) {
      return createEvidence("elevenlabs", { configured: Boolean(config.voiceId), reachable: false, authenticated: false, discoverySupported: true, discoveryOk: false, synthesisTested: false, ready: false, method: "voices-api", reason: sanitizeProviderError(error) });
    }
  },
  async listVoices(context) {
    const key = await getVoiceSecret(context.secrets, "elevenlabs");
    if (!key) return { supported: true, voices: [], evidence: await this.health(context) };
    try {
      const result = await listElevenLabsVoices(context, key, 5);
      return { supported: true, voices: result.voices, evidence: createEvidence("elevenlabs", { configured: true, reachable: true, authenticated: true, discoverySupported: true, discoveryOk: true, synthesisTested: false, ready: true, method: "voices-api", version: result.version }) };
    } catch (error) {
      return { supported: true, voices: [], evidence: createEvidence("elevenlabs", { configured: true, reachable: false, authenticated: false, discoverySupported: true, discoveryOk: false, synthesisTested: false, ready: false, method: "voices-api", reason: sanitizeProviderError(error) }) };
    }
  },
  async synthesize(request, context) {
    const config = context.settings.providers.elevenlabs;
    const key = await getVoiceSecret(context.secrets, "elevenlabs");
    if (!key) throw new Error("An ElevenLabs API key is required.");
    const voiceId = request.useProviderDefault ? config.voiceId : request.voiceId ?? config.voiceId;
    if (!voiceId) throw new Error("Select an ElevenLabs voice.");
    const timeout = withTimeout(request.signal, 45_000);
    try {
      const url = new URL(endpoint(config.baseUrl, `/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`));
      url.searchParams.set("output_format", config.outputFormat);
      const response = await (context.fetchImpl ?? fetch)(url, { method: "POST", headers: { "content-type": "application/json", "xi-api-key": key }, body: JSON.stringify({ text: request.text, model_id: request.model ?? config.model }), signal: timeout.signal, redirect: "error" });
      const audio = await readBoundedAudioResponse(response);
      return { kind: "audio", ...audio };
    } finally {
      timeout.dispose();
    }
  },
};

async function listElevenLabsVoices(context: Parameters<VoiceProviderAdapter["health"]>[0], key: string, pageLimit: number): Promise<{ voices: VoiceInfo[]; version?: string }> {
  const voices: VoiceInfo[] = [];
  let nextPageToken: string | undefined;
  let version: string | undefined;
  for (let page = 0; page < pageLimit && voices.length < 200; page += 1) {
    const url = new URL(endpoint(context.settings.providers.elevenlabs.baseUrl, "/v2/voices"));
    url.searchParams.set("page_size", "100");
    if (nextPageToken) url.searchParams.set("page_token", nextPageToken);
    const controller = new AbortController();
    const timeout = withTimeout(controller.signal, 8_000);
    try {
      const response = await (context.fetchImpl ?? fetch)(url, { headers: { "xi-api-key": key }, signal: timeout.signal, redirect: "error" });
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}.`);
      const body = await response.json() as { voices?: Array<{ voice_id?: unknown; name?: unknown; labels?: Record<string, unknown> }>; next_page_token?: unknown };
      version = response.headers.get("x-api-version") ?? undefined;
      for (const voice of body.voices ?? []) {
        if (typeof voice.voice_id !== "string" || typeof voice.name !== "string") continue;
        voices.push({ id: voice.voice_id.slice(0, 200), label: voice.name.slice(0, 160), language: typeof voice.labels?.language === "string" ? voice.labels.language.slice(0, 40) : undefined });
        if (voices.length >= 200) break;
      }
      nextPageToken = typeof body.next_page_token === "string" ? body.next_page_token : undefined;
      if (!nextPageToken) break;
    } finally {
      timeout.dispose();
    }
  }
  return { voices, version };
}
