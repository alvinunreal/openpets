import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HostAiGateway,
  hostAiApiKeySecret,
  hostSecretsOwner,
  type HostAiSecrets,
} from "../src/host-ai-gateway.js";
import { initializeHostAiSettings, updateHostAiSettings } from "../src/host-ai-settings.js";
import { PluginAiGateway } from "../src/plugin-ai-gateway.js";

let secret: string | undefined = "test-key";
const secrets: HostAiSecrets = {
  async get(owner, key) {
    assert.equal(owner, "__openpets-host");
    assert.equal(key, "ai-api-key");
    return secret;
  },
};

const healthUserData = mkdtempSync(join(tmpdir(), "openpets-host-ai-health-"));
initializeHostAiSettings(healthUserData);
updateHostAiSettings({ provider: "openai", model: "gpt-test", baseUrl: "https://openai.example.test/v1/" });

let now = 1_000;
const probeCalls: Array<{ url: string; init?: RequestInit }> = [];
const probeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  probeCalls.push({ url: String(input), init });
  return new Response(null, { status: 204 });
}) as typeof fetch;
const healthGateway = new HostAiGateway(secrets, { fetch: probeFetch, now: () => now, healthTtlMs: 100 });

const beforeProbe = await healthGateway.getHealthSnapshot();
assert.equal(beforeProbe.status, "configured-unverified");
assert.equal(beforeProbe.configured, true);
assert.equal(beforeProbe.ready, false);
assert.equal(beforeProbe.baseUrl, "https://openai.example.test/v1");

const ready = await healthGateway.probeHealth();
assert.equal(ready.status, "ready");
assert.equal(ready.ready, true);
assert.equal(ready.evidence, "openai-model");
assert.equal(probeCalls[0]?.url, "https://openai.example.test/v1/models/gpt-test");
assert.equal(new Headers(probeCalls[0]?.init?.headers).get("authorization"), "Bearer test-key");
await healthGateway.probeHealth();
assert.equal(probeCalls.length, 1);
now += 101;
assert.equal((await healthGateway.getHealthSnapshot()).stale, true);
await healthGateway.probeHealth();
assert.equal(probeCalls.length, 2);
await healthGateway.probeHealth({ force: true });
assert.equal(probeCalls.length, 3);

updateHostAiSettings({ provider: "anthropic", model: "claude-test", baseUrl: "https://anthropic.example.test" });
const anthropic = await healthGateway.probeHealth();
assert.equal(anthropic.evidence, "anthropic-model");
assert.equal(probeCalls.at(-1)?.url, "https://anthropic.example.test/v1/models/claude-test");
assert.equal(new Headers(probeCalls.at(-1)?.init?.headers).get("x-api-key"), "test-key");

secret = undefined;
updateHostAiSettings({ provider: "ollama", model: "llama-test", baseUrl: "http://127.0.0.1:11434/v1/" });
assert.equal(await healthGateway.available(), true);
const ollama = await healthGateway.probeHealth();
assert.equal(ollama.evidence, "openai-compatible-models");
assert.equal(probeCalls.at(-1)?.url, "http://127.0.0.1:11434/v1/models");
assert.equal(new Headers(probeCalls.at(-1)?.init?.headers).has("authorization"), false);

updateHostAiSettings({ provider: "openai", model: "gpt-test", baseUrl: "https://openai.example.test/v1" });
assert.equal(await healthGateway.available(), false);
const missingKey = await healthGateway.getHealthSnapshot();
assert.equal(missingKey.status, "unconfigured");
assert.equal(missingKey.configured, false);

secret = "test-key";
const failingGateway = new HostAiGateway(secrets, {
  fetch: (async () => new Response(null, { status: 503 })) as typeof fetch,
});
const failed = await failingGateway.probeHealth();
assert.equal(failed.status, "error");
assert.equal(failed.ready, false);
assert.equal(failed.error, "AI provider probe failed with HTTP 503.");

const completionController = new AbortController();
let completionSignal: AbortSignal | null | undefined;
const completionGateway = new HostAiGateway(secrets, {
  fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    completionSignal = init?.signal;
    return Response.json({ choices: [{ message: { content: "Hello" } }] });
  }) as typeof fetch,
});
const completion = await completionGateway.complete(
  { messages: [{ role: "user", content: "Hi" }] },
  { signal: completionController.signal },
);
assert.equal(completion.text, "Hello");
assert.equal(completionSignal, completionController.signal);

const transcriptionController = new AbortController();
let transcriptionSignal: AbortSignal | null | undefined;
const transcriptionGateway = new HostAiGateway(secrets, {
  fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    transcriptionSignal = init?.signal;
    return Response.json({ text: "heard" });
  }) as typeof fetch,
});
assert.equal(await transcriptionGateway.transcribe(new Uint8Array([1, 2, 3]), "audio/webm", { signal: transcriptionController.signal }), "heard");
assert.equal(transcriptionSignal, transcriptionController.signal);

let oversizedCompletionCancelled = false;
const oversizedCompletionGateway = new HostAiGateway(secrets, {
  fetch: (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { oversizedCompletionCancelled = true; },
  }), { status: 200 })) as typeof fetch,
});
await assert.rejects(
  () => oversizedCompletionGateway.complete({ messages: [{ role: "user", content: "Hi" }] }),
  /AI response is too large/,
);
assert.equal(oversizedCompletionCancelled, true);

let oversizedTranscriptionCancelled = false;
const oversizedTranscriptionGateway = new HostAiGateway(secrets, {
  fetch: (async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { oversizedTranscriptionCancelled = true; },
  }), { status: 200, headers: { "content-length": String(2 * 1024 * 1024 + 1) } })) as typeof fetch,
});
await assert.rejects(
  () => oversizedTranscriptionGateway.transcribe(new Uint8Array([1, 2, 3]), "audio/webm"),
  /Transcription response is too large/,
);
assert.equal(oversizedTranscriptionCancelled, true);

const streamController = new AbortController();
let streamSignal: AbortSignal | null | undefined;
let streamCancelled = false;
let pullCount = 0;
const encoder = new TextEncoder();
const streamBody = new ReadableStream<Uint8Array>({
  pull(controller) {
    if (pullCount++ === 0) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
      return;
    }
    return new Promise<void>(() => undefined);
  },
  cancel() {
    streamCancelled = true;
  },
});
const streamGateway = new HostAiGateway(secrets, {
  fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    streamSignal = init?.signal;
    return new Response(streamBody, { status: 200 });
  }) as typeof fetch,
});
const streamed = streamGateway.stream(
  { messages: [{ role: "user", content: "Hi" }] },
  () => undefined,
  { signal: streamController.signal },
);
await new Promise<void>((resolve) => setImmediate(resolve));
streamController.abort();
await assert.rejects(streamed, (error: unknown) => error instanceof Error && error.name === "AbortError");
assert.equal(streamSignal, streamController.signal);
assert.equal(streamCancelled, true);

const preAbortedController = new AbortController();
preAbortedController.abort();
let preAbortedStreamCancelled = false;
const preAbortedGateway = new HostAiGateway(secrets, {
  fetch: (async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { preAbortedStreamCancelled = true; },
  }), { status: 200 })) as typeof fetch,
});
await assert.rejects(
  () => preAbortedGateway.stream(
    { messages: [{ role: "user", content: "Hi" }] },
    () => undefined,
    { signal: preAbortedController.signal },
  ),
  (error: unknown) => error instanceof Error && error.name === "AbortError",
);
assert.equal(preAbortedStreamCancelled, true);

const compatible = new PluginAiGateway(secrets, { fetch: probeFetch });
assert.equal(compatible instanceof HostAiGateway, true);
assert.equal(typeof compatible.complete, "function");
assert.equal(typeof compatible.stream, "function");
assert.equal(typeof compatible.transcribe, "function");
assert.equal(hostSecretsOwner, "__openpets-host");
assert.equal(hostAiApiKeySecret, "ai-api-key");

console.log("host AI gateway health, cancellation, and compatibility behavior verified");
