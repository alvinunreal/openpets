import assert from "node:assert/strict";

import { clearLocalConversationHistory, isLocalConversationHistory, removeLocalConversationHistoryMessage } from "../src/renderer/src/conversation/history-state.js";

const history = [
  { id: "message-1", conversationId: "openpets-control-center-current", turnId: "turn-1", role: "user", text: "Hello", createdAt: 1 },
  { id: "message-2", conversationId: "openpets-control-center-current", turnId: "turn-1", role: "assistant", text: "Hi", createdAt: 2 },
] as const;

assert.equal(isLocalConversationHistory(history), true, "valid archived messages are accepted");
assert.equal(isLocalConversationHistory([{ ...history[0], createdAt: 0 }]), false, "invalid archive timestamps are rejected before rendering");
assert.deepEqual(removeLocalConversationHistoryMessage(history, "message-1"), [history[1]], "deleting one message removes it from the visible list");
assert.deepEqual(clearLocalConversationHistory(), [], "clear produces an empty visible history");

console.log("Renderer local history state verified.");
