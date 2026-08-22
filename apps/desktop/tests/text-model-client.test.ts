import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TextModelClient } from "../src/text-model-client.js";
import { getPluginPlatformSettings, initializePluginPlatformSettings, updatePluginPlatformSettings } from "../src/plugin-platform-settings.js";
import type { PluginSecretsStore } from "../src/plugin-secrets.js";

const userDataPath = mkdtempSync(join(tmpdir(), "openpets-text-model-client-"));
const previousSettings = getPluginPlatformSettings();
const secrets = { get: async () => "test-key" } as unknown as PluginSecretsStore;
let calls: Array<{ input: string; init?: RequestInit }> = [];

try {
  initializePluginPlatformSettings(userDataPath);
  updatePluginPlatformSettings({ ai: { provider: "openai", model: "test-model", baseUrl: "https://provider.test/v1" } });

  const openAi = new TextModelClient(secrets, { fetchImpl: async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({ choices: [{ message: { content: "Planning the focus session.", tool_calls: [{ id: "call-1", type: "function", function: { name: "op_tool", arguments: '{"minutes":25}' } }] } }] }), { status: 200 });
  } });
  const toolResponse = await openAi.generate({ messages: [
    { role: "system", content: "Fixed host rules." },
    { role: "system", content: "Curated context." },
    { role: "system", content: "Personality style." },
    { role: "user", content: "start" },
  ], tools: [{ name: "op_tool", description: "Start", inputSchema: { type: "object" } }] }, new AbortController().signal);
  assert.deepEqual(toolResponse, { type: "tool-calls", text: "Planning the focus session.", toolCalls: [{ id: "call-1", name: "op_tool", arguments: { minutes: 25 } }] });
  assert.equal(calls[0]?.input, "https://provider.test/v1/chat/completions");
  const openAiInitialBody = JSON.parse(String(calls[0]?.init?.body)) as { messages: Array<{ role: string; content: string }> };
  assert.deepEqual(openAiInitialBody.messages.filter((message) => message.role === "system").map((message) => message.content), ["Fixed host rules.", "Curated context.", "Personality style."]);

  calls = [];
  await openAi.generate({ messages: [
    { role: "assistant", content: "Planning the focus session.", toolCalls: [{ id: "call-1", name: "op_tool", arguments: { minutes: 25 } }] },
    { role: "tool", toolCallId: "call-1", name: "op_tool", result: { status: "completed", result: { started: true } } },
  ], tools: [] }, new AbortController().signal);
  const openAiBody = JSON.parse(String(calls[0]?.init?.body)) as { messages: Array<Record<string, unknown>> };
  assert.equal(openAiBody.messages[0]?.content, "Planning the focus session.");
  assert.equal((openAiBody.messages[0]?.tool_calls as Array<{ id: string }>)[0]?.id, "call-1");
  assert.equal(openAiBody.messages[1]?.tool_call_id, "call-1");

  updatePluginPlatformSettings({ ai: { provider: "anthropic", model: "claude-test", baseUrl: "https://anthropic.test" } });
  calls = [];
  const anthropic = new TextModelClient(secrets, { fetchImpl: async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "Preparing." }, { type: "tool_use", id: "anthropic-call", name: "op_tool", input: { minutes: 5 } }] }), { status: 200 });
  } });
  const anthropicResponse = await anthropic.generate({ messages: [
    { role: "system", content: "Fixed host rules." },
    { role: "system", content: "Curated context." },
    { role: "system", content: "Personality style." },
    { role: "assistant", content: "Previous thought.", toolCalls: [{ id: "previous", name: "op_tool", arguments: {} }] },
    { role: "tool", toolCallId: "previous", name: "op_tool", result: { status: "completed", result: { started: true } } },
  ], tools: [] }, new AbortController().signal);
  assert.deepEqual(anthropicResponse, { type: "tool-calls", text: "Preparing.", toolCalls: [{ id: "anthropic-call", name: "op_tool", arguments: { minutes: 5 } }] });
  const anthropicBody = JSON.parse(String(calls[0]?.init?.body)) as { system: string; messages: Array<{ content: Array<{ tool_use_id?: string; text?: string }> }> };
  assert.equal(anthropicBody.system, "Fixed host rules.\n\nCurated context.\n\nPersonality style.");
  assert.equal(anthropicBody.messages[0]?.content[0]?.text, "Previous thought.");
  assert.equal(anthropicBody.messages[1]?.content[0]?.tool_use_id, "previous");

  const malformed = new TextModelClient(secrets, { fetchImpl: async () => new Response(JSON.stringify({ content: [{ type: "tool_use", id: "", name: "op_tool", input: {} }] }), { status: 200 }) });
  await assert.rejects(() => malformed.generate({ messages: [{ role: "user", content: "start" }], tools: [] }, new AbortController().signal), /missing or duplicate tool-call ids/);

  const failed = new TextModelClient(secrets, { fetchImpl: async () => new Response("no", { status: 503 }) });
  await assert.rejects(() => failed.generate({ messages: [{ role: "user", content: "start" }], tools: [] }, new AbortController().signal), /HTTP 503/);

  const oversized = new TextModelClient(secrets, { maxRequestBytes: 10 });
  await assert.rejects(() => oversized.generate({ messages: [{ role: "user", content: "start" }], tools: [] }, new AbortController().signal), /request is too large/);

  const caller = new AbortController();
  const cancelled = new TextModelClient(secrets, { fetchImpl: async () => new Promise<Response>(() => undefined) });
  const pending = cancelled.generate({ messages: [{ role: "user", content: "start" }], tools: [] }, caller.signal);
  caller.abort();
  await assert.rejects(() => pending, /cancelled/);

  const timedOut = new TextModelClient(secrets, { timeoutMs: 5, fetchImpl: async () => new Promise<Response>(() => undefined) });
  await assert.rejects(() => timedOut.generate({ messages: [{ role: "user", content: "start" }], tools: [] }, new AbortController().signal), /timed out/);
} finally {
  updatePluginPlatformSettings(previousSettings);
  rmSync(userDataPath, { recursive: true, force: true });
}

console.log("text-model-client tests passed.");
