import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PluginAiGateway, VOICE_REALTIME_MAX_SDP_BYTES } from "../src/plugin-ai-gateway.js";
import { initializePluginPlatformSettings, createProviderProfile, selectProviderProfile } from "../src/plugin-platform-settings.js";
import type { HostProviderOperations, ProviderOperationSnapshot } from "../src/provider-service.js";
import type { PluginSecretsStore } from "../src/plugin-secrets.js";

const userDataPath = mkdtempSync(join(tmpdir(), "openpets-provider-gateway-"));
const previousFetch = globalThis.fetch;
const calls: Array<{ input: string; init?: RequestInit }> = [];
const secrets = { get: async (_owner: string, key: string) => key.includes("local") ? undefined : "test-key" } as unknown as PluginSecretsStore;

try {
  initializePluginPlatformSettings(userDataPath);
  createProviderProfile({ id: "minimax-text", label: "MiniMax", adapter: "openai-compatible-text", model: "MiniMax-M3", baseUrl: "https://api.minimax.io/v1", secretRef: "minimax" });
  createProviderProfile({ id: "minimax-voice", label: "MiniMax voice", adapter: "minimax-tts", model: "speech-2.8-turbo", baseUrl: "https://api.minimax.io/v1", secretRef: "minimax" });
  createProviderProfile({ id: "whisper-stt", label: "Whisper", adapter: "openai-compatible-transcription", model: "whisper-1", baseUrl: "https://stt.test/v1", secretRef: "whisper" });
  createProviderProfile({ id: "elevenlabs-voice", label: "ElevenLabs", adapter: "elevenlabs-tts", model: "eleven_multilingual_v2", baseUrl: "https://api.elevenlabs.io/v1", secretRef: "elevenlabs" });
  createProviderProfile({ id: "realtime", label: "Realtime", adapter: "openai-realtime", model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", secretRef: "openai" });
  createProviderProfile({ id: "realtime-alt", label: "Realtime alternate", adapter: "openai-realtime", model: "gpt-4o-mini", baseUrl: "https://alternate.example/v1", secretRef: "alternate" });
  selectProviderProfile("text", "minimax-text"); selectProviderProfile("tts", "minimax-voice"); selectProviderProfile("stt", "whisper-stt");
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    if (String(input).includes("t2a_v2")) return new Response(JSON.stringify({ data: { audio: "494433", status: 2 }, base_resp: { status_code: 0 } }), { status: 200 });
    if (String(input).includes("audio/transcriptions")) return new Response(JSON.stringify({ text: "heard" }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 });
  };
  const gateway = new PluginAiGateway(secrets);
  assert.equal((await gateway.complete({ messages: [{ role: "user", content: "hi" }] })).text, "hello");
  assert.equal(calls[0]?.input, "https://api.minimax.io/v1/chat/completions");
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer test-key");
  createProviderProfile({ id: "raw-auth-text", label: "Raw auth", adapter: "openai-compatible-text", model: "raw-model", baseUrl: "https://raw.example/v1", secretRef: "raw", auth: { headerName: "X-API-Key", strategy: "raw" } });
  selectProviderProfile("text", "raw-auth-text");
  calls.length = 0;
  globalThis.fetch = async (input, init) => { calls.push({ input: String(input), init }); return new Response(JSON.stringify({ choices: [{ message: { content: "raw" } }] }), { status: 200 }); };
  assert.equal((await gateway.complete({ messages: [{ role: "user", content: "hi" }] })).text, "raw");
  assert.equal(new Headers(calls[0]?.init?.headers).get("x-api-key"), "test-key");
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), null);
  selectProviderProfile("text", "minimax-text");
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    if (String(input).includes("t2a_v2")) return new Response(JSON.stringify({ data: { audio: "494433", status: 2 }, base_resp: { status_code: 0 } }), { status: 200 });
    if (String(input).includes("audio/transcriptions")) return new Response(JSON.stringify({ text: "heard" }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 });
  };
  assert.deepEqual(Array.from((await gateway.synthesizeSpeech("hello", {}))?.bytes ?? []), [0x49, 0x44, 0x33]);
  assert.equal(await gateway.transcribe(new Uint8Array([1]), "audio/webm"), "heard");
  selectProviderProfile("tts", "elevenlabs-voice");
  globalThis.fetch = async (input, init) => { calls.push({ input: String(input), init }); return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); };
  assert.deepEqual(Array.from((await gateway.synthesizeSpeech("eleven", { voice: "voice-id" }))?.bytes ?? []), [1, 2, 3]);
  assert.equal(calls.at(-1)?.input, "https://api.elevenlabs.io/v1/text-to-speech/voice-id");
  assert.equal(new Headers(calls.at(-1)?.init?.headers).get("xi-api-key"), "test-key");

  selectProviderProfile("text", "realtime");
  calls.length = 0;
  globalThis.fetch = async (input, init) => { calls.push({ input: String(input), init }); return new Response("v=0\r\no=answer", { status: 200 }); };
  assert.equal(await gateway.negotiateRealtime("v=0\r\no=offer", { model: "gpt-realtime-2.1" }), "v=0\r\no=answer");
  assert.equal(calls[0]?.input, "https://api.openai.com/v1/realtime/calls");

  const firstRealtimeOperation = await gateway.beginRealtimeOperation();
  selectProviderProfile("text", "realtime-alt");
  const secondRealtimeOperation = await gateway.beginRealtimeOperation();
  calls.length = 0;
  await firstRealtimeOperation("v=0\r\no=offer", {});
  await secondRealtimeOperation("v=0\r\no=offer", {});
  assert.equal(calls[0]?.input, "https://api.openai.com/v1/realtime/calls", "the first realtime operation must retain its captured provider");
  assert.equal(calls[1]?.input, "https://alternate.example/v1/realtime/calls");

  selectProviderProfile("text", "minimax-text");
  calls.length = 0;
  await assert.rejects(() => gateway.negotiateRealtime("v=0\r\no=offer", {}), /explicit native OpenAI realtime profile/);
  assert.equal(calls.length, 0, "unsupported realtime must not fetch");
  selectProviderProfile("text", "realtime");
  await assert.rejects(() => gateway.negotiateRealtime(`v=0${"x".repeat(VOICE_REALTIME_MAX_SDP_BYTES)}`, {}), /offer is invalid/);

  let streamAdapter: "anthropic-text" | "openai-compatible-text" = "anthropic-text";
  const streamedBodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const streamProvider = {
    snapshot: async (): Promise<ProviderOperationSnapshot> => ({ role: "text", profile: { id: "stream", label: "Stream", adapter: streamAdapter, model: "stream-model", baseUrl: "https://stream.example/v1" } }),
    stream: async (_snapshot: ProviderOperationSnapshot, path: string, body: Record<string, unknown>): Promise<void> => { streamedBodies.push({ path, body }); },
  } as unknown as HostProviderOperations;
  const streamGateway = new PluginAiGateway(streamProvider);
  for (const adapter of ["anthropic-text", "openai-compatible-text"] as const) {
    streamAdapter = adapter;
    await streamGateway.stream({ messages: [{ role: "user", content: "hi" }], temperature: 0.35 }, () => undefined);
    assert.equal(streamedBodies.at(-1)?.body.temperature, 0.35, `${adapter} streaming must preserve temperature`);
  }
} finally {
  globalThis.fetch = previousFetch;
  rmSync(userDataPath, { recursive: true, force: true });
}

console.log("provider gateway tests passed.");
