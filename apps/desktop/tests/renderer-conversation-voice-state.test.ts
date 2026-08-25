import assert from "node:assert/strict";

import { createVoiceSnapshotOrdering, voiceBadgeClass, voiceStatusLabel } from "../src/renderer/src/conversation/conversation-types.js";
import { resolveShortcutSaveOutcome } from "../src/renderer/src/settings-shortcut-state.js";

assert.equal(voiceStatusLabel("ending", "speaking", true), "Ending…", "ending status takes precedence over muted/activity label state");
assert.equal(voiceBadgeClass("ending", "speaking", true), "voice-badge-neutral", "ending status takes precedence over muted/activity badge state");

const ordering = createVoiceSnapshotOrdering();
const initialRequestVersion = ordering.beginInitialRequest();
ordering.noteEvent();
assert.equal(ordering.shouldApplyInitialSnapshot(initialRequestVersion), false, "an event received before the initial snapshot resolves remains authoritative");

const actionOrdering = createVoiceSnapshotOrdering();
const actionRequestVersion = actionOrdering.beginRequest();
let resolveAction!: () => void;
const actionResponse = new Promise<boolean>((resolve) => { resolveAction = () => resolve(actionOrdering.shouldApplyResponse(actionRequestVersion)); });
actionOrdering.noteEvent();
resolveAction();
assert.equal(await actionResponse, false, "a subscribed event remains authoritative when it arrives before an action response resolves");

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
