import assert from "node:assert/strict";

import {
  clearConversationHistory,
  deleteConversationHistoryMessage,
  getConversationHistory,
} from "../src/pet-assistant-history-ipc.js";

const message = {
  id: "11111111-1111-4111-8111-111111111111",
  conversationId: "openpets-control-center-current" as const,
  turnId: "archive-turn",
  role: "user" as const,
  text: "Keep this local.",
  createdAt: 1,
};
const calls: string[] = [];
const controller = {
  getConversationHistory: () => {
    calls.push("list");
    return [message];
  },
  deleteConversationHistoryMessage: (id: string) => {
    calls.push(`delete:${id}`);
    return id === message.id;
  },
  clearConversationHistory: () => { calls.push("clear"); },
};

assert.deepEqual(getConversationHistory(controller), [message], "the narrow history handler delegates listing without a provider");
assert.deepEqual(deleteConversationHistoryMessage(controller, "not-a-message-id"), { deleted: false }, "malformed delete ids do not reach the controller");
assert.deepEqual(deleteConversationHistoryMessage(controller, message.id), { deleted: true }, "a valid delete id is delegated once");
assert.deepEqual(clearConversationHistory(controller), { cleared: true }, "clear delegates only to the history controller");
assert.deepEqual(calls, ["list", `delete:${message.id}`, "clear"]);
assert.throws(() => getConversationHistory(null), /still starting/, "readiness is never represented as an empty archive");
assert.throws(() => deleteConversationHistoryMessage(null, message.id), /still starting/);
assert.throws(() => clearConversationHistory(null), /still starting/);

console.log("pet-assistant history IPC tests passed.");
