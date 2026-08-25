import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PluginService } from "../src/plugin-service.js";
import { PluginStateStore } from "../src/plugin-state.js";
import type { PluginAssistantCapability, PluginAssistantCapabilityExecutionOutcome, PluginAssistantCapabilityHandle } from "../src/plugin-sdk-assistant.js";
import type { PluginRuntime } from "../src/plugin-runtime.js";
import { getPetAssistantConversationController, getPetAssistantService, onPetAssistantConversationControllerReady, startPetAssistantHost, stopPetAssistantHost } from "../src/pet-assistant-host.js";
import { petAssistantToolName } from "../src/pet-assistant-tools.js";
import { initializePluginPlatformSettings, createProviderProfile, selectProviderProfile } from "../src/plugin-platform-settings.js";
import type { PluginSecretsStore } from "../src/plugin-secrets.js";

const userDataPath = mkdtempSync(join(tmpdir(), "openpets-pet-assistant-host-"));
const previousFetch = globalThis.fetch;
const pluginHandle = Object.freeze({ registration: "focus-start" }) as unknown as PluginAssistantCapabilityHandle;
let receivedHandle: PluginAssistantCapabilityHandle | undefined;
let receivedInput: unknown;

const capability: PluginAssistantCapability = {
  pluginId: "focus.buddy",
  capability: { id: "start", description: "Start focus", inputSchema: { type: "object" } },
  handle: pluginHandle,
};

const runtime = {
  async start(): Promise<void> {},
  async stop(): Promise<void> {},
  getAssistantCapabilities(): readonly PluginAssistantCapability[] { return [capability]; },
  async executeAssistantCapability(handle: PluginAssistantCapabilityHandle, input: unknown): Promise<PluginAssistantCapabilityExecutionOutcome> {
    receivedHandle = handle;
    receivedInput = input;
    return { ok: true, result: { started: true, minutes: 25 } };
  },
};

try {
  initializePluginPlatformSettings(userDataPath);
  createProviderProfile({ id: "host-test", label: "Host test", adapter: "openai-compatible-text", model: "host-test", baseUrl: "https://host.test/v1", secretRef: "host-test" });
  selectProviderProfile("text", "host-test");
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    const body = fetchCount === 1
      ? { choices: [{ message: { content: null, tool_calls: [{ id: "host-call", type: "function", function: { name: petAssistantToolName("focus.buddy", "start"), arguments: '{"minutes":25}' } }] } }] }
      : { choices: [{ message: { content: "Focus started." } }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const pluginService = new PluginService({ userDataPath, stateStore: new PluginStateStore({ userDataPath }), runtime: runtime as unknown as PluginRuntime });
  await pluginService.start();
  const secrets = { get: async () => "host-test-key" } as unknown as PluginSecretsStore;
  let readyController: unknown;
  const removeReadyListener = onPetAssistantConversationControllerReady((controller) => { readyController = controller; });
  startPetAssistantHost(pluginService, secrets, { compositionProvider: () => ({}) });
  assert.equal(readyController, getPetAssistantConversationController());
  removeReadyListener();
  const assistant = getPetAssistantService();
  assert.ok(assistant);
  const result = await assistant.startTurn("host-conversation", "Start focus for 25 minutes.");
  assert.equal(result.status, "completed");
  assert.equal(receivedHandle, pluginHandle);
  assert.deepEqual(receivedInput, { minutes: 25 });
} finally {
  await stopPetAssistantHost();
  globalThis.fetch = previousFetch;
  rmSync(userDataPath, { recursive: true, force: true });
}

console.log("pet-assistant-host tests passed.");
