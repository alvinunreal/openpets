import assert from "node:assert/strict";

import { clearLocalConversationHistory, createHistoryRequestOrdering, isLocalConversationHistory, removeLocalConversationHistoryMessage } from "../src/renderer/src/conversation/history-state.js";

const history = [
  { id: "message-1", conversationId: "openpets-control-center-current", turnId: "turn-1", role: "user", text: "Hello", createdAt: 1 },
  { id: "message-2", conversationId: "openpets-control-center-current", turnId: "turn-1", role: "assistant", text: "Hi", createdAt: 2 },
] as const;

assert.equal(isLocalConversationHistory(history), true, "valid archived messages are accepted");
assert.equal(isLocalConversationHistory([{ ...history[0], createdAt: 0 }]), false, "invalid archive timestamps are rejected before rendering");
assert.deepEqual(removeLocalConversationHistoryMessage(history, "message-1"), [history[1]], "deleting one message removes it from the visible list");
assert.deepEqual(clearLocalConversationHistory(), [], "clear produces an empty visible history");

const ordering = createHistoryRequestOrdering();
const firstLoad = ordering.begin();
ordering.invalidate();
assert.equal(ordering.isCurrent(firstLoad), false, "a delete invalidates an in-flight history response so it cannot restore removed messages");
const currentLoad = ordering.begin();
assert.equal(ordering.isCurrent(currentLoad), true);

console.log("Renderer local history state verified.");
