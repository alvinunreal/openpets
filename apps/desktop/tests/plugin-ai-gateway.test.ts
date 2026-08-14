import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginAiGateway } from "../src/plugin-ai-gateway.js";
import { getPluginPlatformSettings, initializePluginPlatformSettings, updatePluginPlatformSettings } from "../src/plugin-platform-settings.js";
import type { PluginSecretsStore } from "../src/plugin-secrets.js";

const userDataPath = mkdtempSync(join(tmpdir(), "openpets-plugin-ai-gateway-"));
const previousSettings = getPluginPlatformSettings();
const previousFetch = globalThis.fetch;
const fetchCalls: Array<{ input: Parameters<typeof fetch>[0]; init?: Parameters<typeof fetch>[1] }> = [];

try {
  initializePluginPlatformSettings(userDataPath);
  updatePluginPlatformSettings({ ai: { provider: "minimax", model: "" } });

  const secrets = { get: async () => "minimax-test-key" } as unknown as PluginSecretsStore;
  const gateway = new PluginAiGateway(secrets);
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    if (String(input).includes("/t2a_v2")) {
      return new Response(JSON.stringify({ data: { audio: "494433", status: 2 }, base_resp: { status_code: 0, status_msg: "success" } }), { status: 200 });
    }
    if (String(input).includes("/audio/transcriptions")) {
      return new Response(JSON.stringify({ text: "transcribed" }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "MiniMax says hello" } }] }), { status: 200 });
  };

  const result = await gateway.complete({ messages: [{ role: "user", content: "Say hello." }] });
  assert.equal(result.text, "MiniMax says hello");
  assert.equal(fetchCalls.length, 1);
  const completeCall = fetchCalls[0];
  assert.ok(completeCall);
  assert.equal(String(completeCall.input), "https://api.minimax.io/v1/chat/completions");
  assert.equal(new Headers(completeCall.init?.headers).get("authorization"), "Bearer minimax-test-key");
  const requestBody = JSON.parse(String(completeCall.init?.body)) as { model?: string };
  assert.equal(requestBody.model, "MiniMax-M3");

  updatePluginPlatformSettings({ ai: { provider: "minimax", model: "MiniMax-M2.7", baseUrl: "https://api.minimaxi.com/v1" } });
  fetchCalls.length = 0;
  await gateway.complete({ messages: [{ role: "user", content: "Say hello from China." }] });
  assert.equal(String(fetchCalls[0]?.input), "https://api.minimaxi.com/v1/chat/completions");
  const chinaRequestBody = JSON.parse(String(fetchCalls[0]?.init?.body)) as { model?: string };
  assert.equal(chinaRequestBody.model, "MiniMax-M2.7");
  updatePluginPlatformSettings({ ai: { provider: "minimax", model: "", speechModel: "speech-2.8-turbo", baseUrl: undefined } });
  fetchCalls.length = 0;
  const speech = await gateway.synthesizeSpeech("Hello from OpenPets.", { voice: "English_Lucky_Robot", rate: 1.25 });
  assert.deepEqual(Array.from(speech?.bytes ?? []), [0x49, 0x44, 0x33]);
  assert.equal(speech?.mimeType, "audio/mpeg");
  assert.equal(fetchCalls.length, 1);
  const speechCall = fetchCalls[0];
  assert.ok(speechCall);
  assert.equal(String(speechCall.input), "https://api.minimax.io/v1/t2a_v2");
  assert.equal(new Headers(speechCall.init?.headers).get("authorization"), "Bearer minimax-test-key");
  const speechBody = JSON.parse(String(speechCall.init?.body)) as Record<string, unknown>;
  assert.deepEqual(speechBody, {
    model: "speech-2.8-turbo",
    text: "Hello from OpenPets.",
    stream: false,
    output_format: "hex",
    audio_setting: { format: "mp3" },
    voice_setting: { voice_id: "English_Lucky_Robot", speed: 1.25 },
  });

  fetchCalls.length = 0;
  await gateway.synthesizeSpeech("Rate-only speech.", { rate: 0.8 });
  assert.equal(fetchCalls.length, 1);
  const rateOnlyBody = JSON.parse(String(fetchCalls[0]?.init?.body)) as Record<string, unknown>;
  assert.deepEqual(rateOnlyBody, {
    model: "speech-2.8-turbo",
    text: "Rate-only speech.",
    stream: false,
    output_format: "hex",
    audio_setting: { format: "mp3" },
    voice_setting: { voice_id: "English_expressive_narrator", speed: 0.8 },
  });

  fetchCalls.length = 0;
  await gateway.synthesizeSpeech("Default voice speech.", {});
  assert.equal(fetchCalls.length, 1);
  const defaultVoiceBody = JSON.parse(String(fetchCalls[0]?.init?.body)) as Record<string, unknown>;
  assert.deepEqual(defaultVoiceBody, {
    model: "speech-2.8-turbo",
    text: "Default voice speech.",
    stream: false,
    output_format: "hex",
    audio_setting: { format: "mp3" },
    voice_setting: { voice_id: "English_expressive_narrator" },
  });

  fetchCalls.length = 0;
  await assert.rejects(
    () => gateway.transcribe(new Uint8Array([1, 2, 3]), "audio/webm"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /MiniMax OpenAI-compatible provider\/path does not support voice transcription in OpenPets/);
      assert.match(error.message, /OpenAI or Ollama/);
      return true;
    },
  );
  assert.equal(fetchCalls.length, 0);

  updatePluginPlatformSettings({ ai: { provider: "openai", model: "", baseUrl: undefined } });
  fetchCalls.length = 0;
  const controller = new AbortController();
  assert.equal(await gateway.transcribe(new Uint8Array([1, 2, 3]), "audio/webm", controller.signal), "transcribed");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]?.init?.signal, controller.signal);
} finally {
  globalThis.fetch = previousFetch;
  updatePluginPlatformSettings(previousSettings);
  rmSync(userDataPath, { recursive: true, force: true });
}

console.error("Plugin AI gateway validation passed.");
