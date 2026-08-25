import assert from "node:assert/strict";

import { shutdownVoiceAssistantResources } from "../src/voice-assistant-host-cleanup.js";

let unsubscribed = false;
let playerShutdown = false;
const failure = new Error("shutdown failed");
await assert.rejects(
  shutdownVoiceAssistantResources(
    async () => { throw failure; },
    () => { unsubscribed = true; },
    async () => { playerShutdown = true; },
  ),
  failure,
  "shutdown rejection remains observable",
);
assert.equal(unsubscribed, true, "the session listener is removed after shutdown rejection");
assert.equal(playerShutdown, true, "the pet-window player is shut down after session rejection");

console.log("Voice assistant host cleanup rejection verified.");
