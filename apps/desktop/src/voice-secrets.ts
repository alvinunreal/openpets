import type { PluginSecretsStore } from "./plugin-secrets.js";

export const voiceSecretsOwner = "__openpets-host";
export const voiceOpenAiCompatibleApiKeySecret = "voice-openai-compatible-api-key";
export const voiceElevenLabsApiKeySecret = "voice-elevenlabs-api-key";

export type VoiceSecretProviderId = "openai-compatible" | "elevenlabs";
export type VoiceSecretStatus = Record<VoiceSecretProviderId, { readonly hasKey: boolean }>;

export async function getVoiceSecretStatus(store: PluginSecretsStore): Promise<VoiceSecretStatus> {
  const [openai, elevenlabs] = await Promise.all([
    store.has(voiceSecretsOwner, voiceOpenAiCompatibleApiKeySecret),
    store.has(voiceSecretsOwner, voiceElevenLabsApiKeySecret),
  ]);
  return { "openai-compatible": { hasKey: openai }, elevenlabs: { hasKey: elevenlabs } };
}

export async function getVoiceSecret(store: PluginSecretsStore, providerId: VoiceSecretProviderId): Promise<string | undefined> {
  return store.get(voiceSecretsOwner, providerId === "elevenlabs" ? voiceElevenLabsApiKeySecret : voiceOpenAiCompatibleApiKeySecret);
}

export async function setVoiceSecret(store: PluginSecretsStore, providerId: VoiceSecretProviderId, value: string | null): Promise<void> {
  const key = providerId === "elevenlabs" ? voiceElevenLabsApiKeySecret : voiceOpenAiCompatibleApiKeySecret;
  const normalized = value?.trim() ?? "";
  if (normalized.length > 4096) throw new Error("Voice API key is too long.");
  if (!normalized) await store.delete(voiceSecretsOwner, key);
  else await store.set(voiceSecretsOwner, key, normalized);
}
