import { createEvidence, type VoiceProviderAdapter } from "./voice-provider.js";

export const systemVoiceProvider: VoiceProviderAdapter = {
  id: "system",
  async health(context) {
    const ready = Boolean(context.targetWindow && !context.targetWindow.isDestroyed());
    return createEvidence("system", { configured: true, reachable: ready, discoverySupported: true, discoveryOk: ready, synthesisTested: false, ready, method: "renderer-speech-synthesis", reason: ready ? undefined : "Show a pet before checking System Voice." });
  },
  async listVoices(context) {
    if (!context.targetWindow || context.targetWindow.isDestroyed() || !context.listSystemVoices) {
      const evidence = await this.health(context);
      return { supported: true, voices: [], evidence };
    }
    try {
      const voices = await context.listSystemVoices(context.targetWindow);
      return { supported: true, voices, evidence: createEvidence("system", { configured: true, reachable: true, discoverySupported: true, discoveryOk: true, synthesisTested: false, ready: true, method: "renderer-speech-synthesis" }) };
    } catch (error) {
      return { supported: true, voices: [], evidence: createEvidence("system", { configured: true, reachable: false, discoverySupported: true, discoveryOk: false, synthesisTested: false, ready: false, method: "renderer-speech-synthesis", reason: error instanceof Error ? error.message.slice(0, 200) : "System voice discovery failed." }) };
    }
  },
  async synthesize(request, context) {
    if (!context.targetWindow || context.targetWindow.isDestroyed()) throw new Error("Target pet is not available for System Voice.");
    const configured = context.settings.providers.system;
    return { kind: "system", text: request.text, voiceId: request.useProviderDefault ? configured.voiceId : request.voiceId ?? configured.voiceId, rate: request.rate ?? configured.rate };
  },
};
