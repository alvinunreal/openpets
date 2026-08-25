import assert from "node:assert/strict";

import { createVoiceSnapshotOrdering, voiceBadgeClass, voiceStatusLabel } from "../src/renderer/src/conversation/conversation-types.js";
import { resolveShortcutSaveOutcome } from "../src/renderer/src/settings-shortcut-state.js";

assert.equal(voiceStatusLabel("ending", "speaking", true), "Ending…", "ending status takes precedence over muted/activity label state");
assert.equal(voiceBadgeClass("ending", "speaking", true), "voice-badge-neutral", "ending status takes precedence over muted/activity badge state");

const ordering = createVoiceSnapshotOrdering();
const initialRequestVersion = ordering.beginInitialRequest();
ordering.noteEvent(0, 0);
assert.equal(ordering.shouldApplyInitialSnapshot(initialRequestVersion), false, "an event received before the initial snapshot resolves remains authoritative");

const actionOrdering = createVoiceSnapshotOrdering();
const actionRequestVersion = actionOrdering.beginRequest();
let resolveAction!: () => void;
const actionResponse = new Promise<boolean>((resolve) => { resolveAction = () => resolve(actionOrdering.shouldApplyResponse(actionRequestVersion)); });
actionOrdering.noteEvent(0, 1);
resolveAction();
assert.equal(await actionResponse, false, "a subscribed event remains authoritative when it arrives before an action response resolves");

const sequenceOrdering = createVoiceSnapshotOrdering();
assert.equal(sequenceOrdering.noteEvent(7, 12), true, "newer Talk snapshots are accepted");
assert.equal(sequenceOrdering.noteEvent(7, 11), false, "older queued Talk snapshots are rejected");

const restartedSessionOrdering = createVoiceSnapshotOrdering();
assert.equal(restartedSessionOrdering.noteEvent(21, 48), true, "session A accepts its high sequence event");
assert.equal(restartedSessionOrdering.noteEvent(22, 1), true, "session B resets its partitioned sequence high-water mark");
assert.equal(restartedSessionOrdering.noteEvent(22, 2), true, "session B accepts subsequent valid events");
assert.equal(restartedSessionOrdering.noteEvent(21, 49), false, "stale session A events cannot overwrite session B");

const rejectedShortcut = resolveShortcutSaveOutcome("CommandOrControl+Alt+Space", {
  preferences: { voiceAssistantShortcut: "CommandOrControl+Shift+Space" },
  voiceAssistantShortcutStatus: {
    accelerator: "CommandOrControl+Shift+Space",
    status: "registered",
    reason: "The requested shortcut is already in use; the previous shortcut remains active.",
  },
});
assert.equal(rejectedShortcut.accepted, false, "a shortcut save is not reported as successful when the host retained the prior binding");
assert.equal(rejectedShortcut.savedAccelerator, "CommandOrControl+Shift+Space");
assert.match(rejectedShortcut.reason ?? "", /previous shortcut remains active/);

console.log("Renderer Talk ending state verified.");
