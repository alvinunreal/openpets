import assert from "node:assert/strict";

import { VoiceCaptureStartGuard } from "../src/voice-capture-start-guard.js";

// A cancelled acquisition may still resolve on some hosts. Its late capture
// handle must be cancelled before the listening service can make it active.
const cancelledGuard = new VoiceCaptureStartGuard();
const cancelledAttempt = cancelledGuard.begin("push-to-talk", "pedro");
assert.equal(cancelledGuard.cancel("control-center"), cancelledAttempt);
let cancelledReason = "";
assert.equal(await cancelledGuard.accept(cancelledAttempt, {
  async cancel(reason) { cancelledReason = reason ?? ""; },
}), false);
assert.equal(cancelledReason, "control-center");
assert.equal(cancelledGuard.pending, cancelledAttempt);
cancelledGuard.clear(cancelledAttempt);
assert.equal(cancelledGuard.pending, null);

// A failed start is cleared so it cannot permanently block later voice work.
const failedGuard = new VoiceCaptureStartGuard();
const failedAttempt = failedGuard.begin("plugin-listen");
failedGuard.clear(failedAttempt);
assert.equal(failedGuard.pending, null);
const nextAttempt = failedGuard.begin("push-to-talk", "pedro");
assert.equal(await failedGuard.accept(nextAttempt, { async cancel() { assert.fail("accepted captures must not be cancelled"); } }), true);
assert.equal(failedGuard.pending, null);

console.log("voice capture pending-start cancellation behavior verified");
