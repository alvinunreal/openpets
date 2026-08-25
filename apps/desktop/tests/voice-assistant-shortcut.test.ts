import assert from "node:assert/strict";

import {
  DEFAULT_VOICE_ASSISTANT_SHORTCUT,
  VoiceAssistantShortcutManager,
  configureVoiceAssistantShortcut,
  getVoiceAssistantShortcutSnapshot,
  initializeVoiceAssistantShortcut,
  isCanonicalVoiceAssistantShortcut,
  resolveVoiceAssistantShortcutPreference,
  shutdownVoiceAssistantShortcut,
} from "../src/voice-assistant-shortcut.js";

const registrations: string[] = [];
const unregistrations: string[] = [];
let result: boolean | Error = true;
let unregisterResult: Error | null = null;
let registeredCallback: (() => void) | null = null;
const registry = {
  register(accelerator: string, callback: () => void): boolean {
    registrations.push(accelerator);
    registeredCallback = callback;
    if (result instanceof Error) throw result;
    return result;
  },
  unregister(accelerator: string): void { unregistrations.push(accelerator); if (unregisterResult) throw unregisterResult; },
};

assert.equal(isCanonicalVoiceAssistantShortcut(DEFAULT_VOICE_ASSISTANT_SHORTCUT), true);
assert.equal(isCanonicalVoiceAssistantShortcut("Ctrl+Shift+Space"), false);
assert.equal(isCanonicalVoiceAssistantShortcut("Shift+space"), false);
assert.equal(isCanonicalVoiceAssistantShortcut("Space"), false);

const manager = new VoiceAssistantShortcutManager(registry, () => {});
assert.equal(manager.configure(DEFAULT_VOICE_ASSISTANT_SHORTCUT).status, "registered");
result = false;
assert.equal(manager.configure("CommandOrControl+Alt+Space").status, "registered");
assert.deepEqual(unregistrations, [], "conflicting replacement keeps the previous accelerator registered");
assert.equal(manager.snapshot().accelerator, DEFAULT_VOICE_ASSISTANT_SHORTCUT);
assert.equal(manager.snapshot().status, "registered");
result = new Error("global shortcut unavailable");
assert.equal(manager.configure("CommandOrControl+Shift+T").status, "registered");
assert.deepEqual(unregistrations, [], "unavailable replacement keeps the previous accelerator registered");
assert.equal(manager.snapshot().accelerator, DEFAULT_VOICE_ASSISTANT_SHORTCUT);
assert.equal(manager.configure("bad shortcut").status, "invalid");
result = true;
manager.configure("CommandOrControl+Shift+T");
assert.deepEqual(unregistrations, [DEFAULT_VOICE_ASSISTANT_SHORTCUT], "successful replacement releases the exact previous accelerator");
manager.shutdown();
assert.deepEqual(unregistrations, [DEFAULT_VOICE_ASSISTANT_SHORTCUT, "CommandOrControl+Shift+T"]);
const shutdownManager = new VoiceAssistantShortcutManager(registry, () => {});
shutdownManager.configure("CommandOrControl+Shift+T");
shutdownManager.shutdown();
assert.deepEqual(unregistrations, [DEFAULT_VOICE_ASSISTANT_SHORTCUT, "CommandOrControl+Shift+T", "CommandOrControl+Shift+T"], "shutdown unregisters the exact active accelerator");

assert.equal(resolveVoiceAssistantShortcutPreference("CommandOrControl+Shift+T", "CommandOrControl+Alt+Space", {
  accelerator: "CommandOrControl+Shift+T",
  status: "registered",
  reason: "The requested shortcut is already in use; the previous shortcut remains active.",
}), "CommandOrControl+Shift+T", "rejected replacements do not persist the requested shortcut");
assert.equal(resolveVoiceAssistantShortcutPreference("CommandOrControl+Shift+T", "CommandOrControl+Alt+Space", {
  accelerator: "CommandOrControl+Alt+Space",
  status: "registered",
}), "CommandOrControl+Alt+Space", "registered replacements persist the accelerator that is active");

const retainedManager = new VoiceAssistantShortcutManager(registry, () => {});
assert.equal(retainedManager.configure("CommandOrControl+Shift+R").status, "registered");
unregisterResult = new Error("release failed");
assert.equal(retainedManager.configure("CommandOrControl+Shift+Y").status, "registered");
assert.match(retainedManager.snapshot().reason ?? "", /release failed/);
unregisterResult = null;
assert.equal(retainedManager.shutdown().status, "unavailable");

let toggleCalls = 0;
const toggleManager = new VoiceAssistantShortcutManager(registry, () => { toggleCalls += 1; });
toggleManager.configure("CommandOrControl+Shift+K");
registeredCallback!();
assert.equal(toggleCalls, 1, "the registered shortcut callback invokes the authoritative toggle action");
toggleManager.shutdown();

const singletonRegistry = {
  register(accelerator: string, callback: () => void): boolean {
    registrations.push(accelerator);
    registeredCallback = callback;
    return true;
  },
  unregister(accelerator: string): void {
    if (unregisterResult) throw unregisterResult;
  },
};
initializeVoiceAssistantShortcut(singletonRegistry, () => {}, "CommandOrControl+Shift+L");
unregisterResult = new Error("singleton release failed");
assert.match(shutdownVoiceAssistantShortcut().reason ?? "", /singleton release failed/);
assert.match(getVoiceAssistantShortcutSnapshot().reason ?? "", /singleton release failed/);
assert.equal(configureVoiceAssistantShortcut("CommandOrControl+Shift+M").status, "unavailable", "failed singleton cleanup remains authoritative");
unregisterResult = null;
assert.equal(shutdownVoiceAssistantShortcut().reason, "Shortcut registration is stopped.");

console.log("Voice assistant shortcut lifecycle and persistence verified.");
