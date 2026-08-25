import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildProviderControlCenterSnapshot, initializePluginPlatformSettings, createProviderProfile, getPluginPlatformSettings, selectProviderProfile } from "../src/plugin-platform-settings.js";
import { HostProviderService } from "../src/provider-service.js";
import type { PluginSecretsStore } from "../src/plugin-secrets.js";

const dir = mkdtempSync(join(tmpdir(), "openpets-provider-service-"));
const secrets = { get: async () => "test-key" } as unknown as PluginSecretsStore;

function responseStream(chunks: Uint8Array[], onCancel: () => void, close = true): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (close) controller.close();
    },
    cancel() { onCancel(); },
  });
}

async function main(): Promise<void> {
try {
  initializePluginPlatformSettings(dir);
  createProviderProfile({ id: "text", label: "Text", adapter: "openai-compatible-text", model: "model", baseUrl: "https://provider.example/v1", secretRef: "text" });
  createProviderProfile({ id: "stt", label: "STT", adapter: "openai-compatible-transcription", model: "whisper", baseUrl: "https://provider.example/v1", secretRef: "stt" });
  createProviderProfile({ id: "tts", label: "TTS", adapter: "openai-compatible-speech", model: "speech", baseUrl: "https://provider.example/v1", secretRef: "tts" });
  selectProviderProfile("text", "text");
  selectProviderProfile("stt", "stt");
  selectProviderProfile("tts", "tts");

  let cancelled = 0;
  const service = new HostProviderService(secrets, {
    timeoutMs: 20,
    fetchImpl: async (input) => {
      const url = String(input);
      const stream = responseStream([], () => { cancelled += 1; }, false);
      if (url.includes("audio/speech")) return new Response(stream, { status: 500 });
      if (url.includes("audio/transcriptions")) return new Response(stream, { status: 500 });
      return new Response(stream, { status: 500 });
    },
  });

  const ttsSnapshot = await service.snapshot("tts");
  const sttSnapshot = await service.snapshot("stt");
  const textSnapshot = await service.snapshot("text");
  await assert.rejects(() => service.binary(ttsSnapshot, "/audio/speech", {}), /HTTP 500/);
  await assert.rejects(() => service.transcribe(sttSnapshot, new Uint8Array([1]), "audio/webm"), /HTTP 500/);
  await assert.rejects(() => service.stream(textSnapshot, "/chat/completions", {}, () => undefined), /HTTP 500/);
  assert.equal(cancelled, 3, "HTTP error bodies must be cancelled before the operation returns");

  let timeoutCancelled = false;
  const timeoutService = new HostProviderService(secrets, {
    timeoutMs: 10,
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { timeoutCancelled = true; } }), { status: 200 }),
  });
  const timeoutSnapshot = await timeoutService.snapshot("text");
  await assert.rejects(() => timeoutService.json(timeoutSnapshot, "/chat/completions", {}), /timed out/);
  assert.equal(timeoutCancelled, true, "a timeout after headers must cancel the unread response body");

  let oversizedCancelled = false;
  const oversizedService = new HostProviderService(secrets, {
    fetchImpl: async () => new Response(responseStream([new Uint8Array(2 * 1024 * 1024 + 1)], () => { oversizedCancelled = true; }, false), { status: 200 }),
  });
  const oversizedSnapshot = await oversizedService.snapshot("text");
  await assert.rejects(() => oversizedService.json(oversizedSnapshot, "/chat/completions", {}), /too large/);
  assert.equal(oversizedCancelled, true, "chunked oversized responses must cancel their body");

} finally {
  rmSync(dir, { recursive: true, force: true });
}
}

main().then(() => console.log("provider service lifecycle tests passed."), (error) => { console.error(error); process.exitCode = 1; });
