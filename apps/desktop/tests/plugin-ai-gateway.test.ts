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

  updatePluginPlatformSettings({ ai: { provider: "openai", model: "" } });
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
