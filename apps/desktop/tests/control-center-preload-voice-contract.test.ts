import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../control-center-preload.cjs", import.meta.url), "utf8");
const calls: Array<{ channel: string; args: unknown[] }> = [];
const listeners = new Map<string, (...args: unknown[]) => void>();
let exposed: Record<string, (...args: any[]) => any> | undefined;
const talkSnapshot = {
  status: "ended",
  activity: null,
  muted: false,
  conversationId: "pet-assistant",
  generation: 0,
  turnId: null,
  userTranscript: null,
  assistantTranscript: null,
  interruptionCount: 0,
  error: null,
  shortcut: "CommandOrControl+Shift+Space",
  shortcutStatus: "registered",
  shortcutReason: null,
};
const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]) { calls.push({ channel, args }); return Promise.resolve(channel === "openpets:get-voice-assistant-snapshot" ? talkSnapshot : {}); },
  on(channel: string, listener: (...args: unknown[]) => void) { listeners.set(channel, listener); },
  removeListener(channel: string) { listeners.delete(channel); },
  send(channel: string, ...args: unknown[]) { calls.push({ channel, args }); },
};

runInNewContext(source, {
  require: (name: string) => name === "electron" ? { contextBridge: { exposeInMainWorld: (_name: string, api: Record<string, (...args: any[]) => any>) => { exposed = api; } }, ipcRenderer } : undefined,
});

assert.ok(exposed);
const api = exposed!;
assert.deepEqual(await api.getVoiceAssistantSnapshot(), talkSnapshot);
await api.startVoiceAssistant();
await api.endVoiceAssistant();
let receivedVoiceEvent: unknown;
const unsubscribe = api.onVoiceAssistantEvent((event: unknown) => { receivedVoiceEvent = event; });
const turnSettledEvent = { type: "turn-settled", sequence: 12, turnId: "voice-turn-1", outcome: "completed" };
listeners.get("openpets:voice-assistant-event")?.({}, turnSettledEvent);
assert.deepEqual(receivedVoiceEvent, turnSettledEvent, "preload preserves the discriminated voice event shape");
unsubscribe();

assert.deepEqual(calls.slice(0, 3).map(({ channel }) => channel), [
  "openpets:get-voice-assistant-snapshot",
  "openpets:voice-assistant-start",
  "openpets:voice-assistant-end",
]);
assert.equal(calls.some(({ channel }) => channel === "openpets:voice-assistant-subscribe"), true);
assert.equal(calls.some(({ channel }) => channel === "openpets:voice-assistant-unsubscribe"), true);
assert.equal(listeners.has("openpets:voice-assistant-event"), false);

console.log("Control Center voice preload contract verified.");
