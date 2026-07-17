import assert from "node:assert/strict";

import { VoiceWakeWordService } from "../src/voice-wake-word-service.js";

const wake = new VoiceWakeWordService();
const health = wake.health();
assert.equal(health.ready, false);
assert.equal(health.enabled, false);
assert.match(health.reason, /no approved local runtime/i);
assert.throws(() => wake.start(), /not available/i);
wake.dispose();

console.log("wake-word packaging gate verified");
