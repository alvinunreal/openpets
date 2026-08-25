import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? new URL("../..", import.meta.url).pathname;
const source = readFileSync(join(desktopRoot, "control-center-preload.cjs"), "utf8");
let exposed: Record<string, (...args: any[]) => any> | undefined;
const listeners = new Map<string, Function>();
const sent: Array<{ channel: string; args: unknown[] }> = [];
const ipcRenderer = {
  invoke: async () => undefined,
  on: (channel: string, listener: Function) => { listeners.set(channel, listener); },
  removeListener: (channel: string, listener: Function) => { if (listeners.get(channel) === listener) listeners.delete(channel); },
  send: (channel: string, ...args: unknown[]) => { sent.push({ channel, args }); },
};
runInNewContext(source, {
  require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: Record<string, (...args: any[]) => any>) => { exposed = api; } }, ipcRenderer }),
});

assert.ok(exposed);
const callback = () => {};
const cleanup = exposed.onConversationEvent(callback);
assert.equal(sent[0]?.channel, "openpets:conversation-subscribe");
assert.equal(typeof sent[0]?.args[0], "string");
assert.equal(listeners.has("openpets:conversation-event"), true);
cleanup();
assert.equal(sent[1]?.channel, "openpets:conversation-unsubscribe");
assert.deepEqual(sent[1]?.args, sent[0]?.args);
assert.equal(listeners.has("openpets:conversation-event"), false);
console.log("control-center preload conversation cleanup passed.");
