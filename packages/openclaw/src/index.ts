import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { createOpenPetsOpenClawRuntime } from "./runtime.js";

export { createOpenPetsOpenClawRuntime, type OpenClawActivity, type OpenPetsDebugCode, type OpenPetsOpenClawRuntime, type OpenPetsOpenClawRuntimeOptions } from "./runtime.js";
export { buildOpenClawCommand, classifyOpenClawStatus, exactPackageSpec, isSupportedOpenClawVersion, openClawMaxStructuredOutputBytes, openClawMinimumVersion, openClawPackageName, openClawPluginId, parseOpenClawPluginList, parseOpenClawVersion, planOpenClawMutation, type OpenClawCommandAction, type OpenClawCommandPaths, type OpenClawCommandSpec, type OpenClawDiscoveryInput, type OpenClawMutation, type OpenClawPluginListSnapshot, type OpenClawPluginStatus, type OpenClawSetupState, type OpenClawSourceCategory } from "./management.js";

export default definePluginEntry({
  id: "openpets",
  name: "OpenPets",
  description: "Shows safe, categorical OpenClaw activity in the OpenPets companion.",
  register(api) {
    const runtime = createOpenPetsOpenClawRuntime();
    api.on("model_call_started", () => { runtime.handleModelCallStarted(); });
    api.on("before_tool_call", () => { runtime.handleBeforeToolCall(); });
  },
});
