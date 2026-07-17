import assert from "node:assert/strict";

import { CodexConversationTarget, parseCodexJsonLine } from "../src/voice-conversation-codex.js";

assert.deepEqual(parseCodexJsonLine('{"type":"thread.started","thread_id":"thread-1"}'), { type: "session", sessionId: "thread-1" });
assert.deepEqual(parseCodexJsonLine('{"type":"item.completed","item":{"type":"agent_message","text":"Hello"}}'), { type: "text", text: "Hello", final: true });
assert.deepEqual(parseCodexJsonLine('{"type":"item.completed","item":{"type":"error","message":"safe warning"}}'), { type: "error", message: "safe warning" });
assert.equal(parseCodexJsonLine("not-json"), null);

const requests: Array<{ sessionId?: string; text: string }> = [];
const target = new CodexConversationTarget({
  probe: async () => ({ version: "codex-cli 1.2.3", execHelp: "resume --json", resumeHelp: "Usage [SESSION_ID] --json" }),
  run: async (request) => {
    requests.push({ sessionId: request.sessionId, text: request.text });
    return { sessionId: request.sessionId ?? "thread-1", text: request.sessionId ? "Second" : "First" };
  },
});

const health = await target.health();
assert.equal(health.ready, true);
assert.equal(health.version, "codex-cli 1.2.3");
const first = await target.sendText({ text: "hello", signal: new AbortController().signal });
const second = await target.sendText({ text: "again", sessionId: first.sessionId, signal: new AbortController().signal });
assert.equal(second.text, "Second");
assert.deepEqual(requests, [{ sessionId: undefined, text: "hello" }, { sessionId: "thread-1", text: "again" }]);

const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(() => target.sendText({ text: "cancelled", signal: cancelled.signal }), /cancelled/i);

const incompatible = new CodexConversationTarget({ probe: async () => ({ version: "old", execHelp: "exec", resumeHelp: "resume" }) });
assert.equal((await incompatible.health()).ready, false);

target.dispose();
incompatible.dispose();
console.log("Codex conversation target contract verified");
