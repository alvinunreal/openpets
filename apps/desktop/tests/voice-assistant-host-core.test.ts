import assert from "node:assert/strict";

import { PetAssistantService } from "../src/pet-assistant-service.js";
import { petAssistantToolName } from "../src/pet-assistant-tools.js";
import { TextModelClient } from "../src/text-model-client.js";
import type { HostProviderOperations, ProviderOperationSnapshot } from "../src/provider-service.js";
import { HostVoiceInput, PetAssistantVoiceAdapter, ProviderVoiceSynthesizer, reactionForVoiceActivity } from "../src/voice-assistant-host-core.js";
import { VoiceAssistantHostController } from "../src/voice-assistant-host-core.js";
import { VoiceAssistantSession } from "../src/voice-assistant-session.js";
import { VoiceConversationService } from "../src/voice-conversation.js";
import { VoiceResourceOwner } from "../src/voice-resource-owner.js";
import { VoiceMicrophoneArbiter } from "../src/voice-microphone-arbiter.js";
import { VoiceCaptureService } from "../src/voice-capture.js";
import type { VoicePrivacyIndicatorSurface } from "../src/voice-privacy-indicator.js";
import { VoicePrivacyIndicator } from "../src/voice-privacy-indicator.js";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) { if (predicate()) return; await flush(); }
  throw new Error("Timed out waiting for composed voice behavior.");
}

function snapshot(role: "text" | "stt" | "tts"): ProviderOperationSnapshot {
  return { role, profile: { id: role, label: role, adapter: role === "stt" ? "openai-compatible-transcription" : role === "tts" ? "openai-compatible-speech" : "openai-compatible-text", model: role, baseUrl: "https://provider.example" } } as ProviderOperationSnapshot;
}

function captureService(arbiter: VoiceMicrophoneArbiter): VoiceCaptureService {
  const surface: VoicePrivacyIndicatorSurface = { show() {}, hide() {}, destroy() {} };
  return new VoiceCaptureService((_duration, onAcquired) => ({
    acquire: async () => {
      onAcquired();
      return {
        result: Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/webm" }),
        stop: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/webm" }),
        cancel: async () => undefined,
        close: async () => undefined,
      };
    },
    cancel: async () => undefined,
    dispose: async () => undefined,
  }), new VoicePrivacyIndicator(() => surface), { microphoneArbiter: arbiter });
}

async function main(): Promise<void> {
  const roles: string[] = [];
  const provider: HostProviderOperations = {
    snapshot: async (role) => { roles.push(role); return snapshot(role === "realtime" ? "text" : role); },
    json: async () => ({}),
    binary: async () => new Uint8Array(),
    stream: async () => undefined,
    transcribe: async () => "hello from microphone",
    synthesize: async () => ({ bytes: new Uint8Array([7, 8]), mimeType: "audio/mpeg" }),
    negotiateRealtime: async () => "",
  };

  const arbiter = new VoiceMicrophoneArbiter();
  const reservation = arbiter.reserve("assistant-session");
  const input = new HostVoiceInput(provider, captureService(arbiter));
  const inputResult = await input.listen({ requestId: "input-1", signal: new AbortController().signal, reservation });
  assert.deepEqual(inputResult, { status: "completed", final: "hello from microphone" });
  const speech = await new ProviderVoiceSynthesizer(provider).synthesize("hello", { requestId: "output-1", signal: new AbortController().signal });
  assert.deepEqual(speech, { kind: "audio", bytes: new Uint8Array([7, 8]), mimeType: "audio/mpeg" });
  assert.deepEqual(roles, ["stt", "tts"], "input and synthesis snapshot their own provider roles independently");
  arbiter.releaseReservation(reservation);

  let selectedProfile = "stt-old";
  let resolveAcquisition!: (recording: { readonly result: Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }>; stop(): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }>; cancel(): Promise<void>; close(): Promise<void> }) => void;
  let resolveCapture!: (capture: { readonly bytes: Uint8Array; readonly mimeType: string }) => void;
  const pendingCapture = new VoiceCaptureService((_duration, onAcquired) => ({
    acquire: () => new Promise((resolve) => {
      resolveAcquisition = (recording) => { onAcquired(); resolve(recording); };
    }),
    cancel: async () => undefined,
    dispose: async () => undefined,
  }), new VoicePrivacyIndicator(() => ({ show() {}, hide() {}, destroy() {} })), { microphoneArbiter: arbiter });
  let usedProfile = "";
  const pinnedProvider: HostProviderOperations = {
    ...provider,
    snapshot: async () => { const current = snapshot("stt"); return { ...current, profile: { ...current.profile, id: selectedProfile } }; },
    transcribe: async (receivedSnapshot) => { usedProfile = receivedSnapshot.profile.id; return "pinned transcript"; },
  };
  const pinnedInput = new HostVoiceInput(pinnedProvider, pendingCapture);
  const pinnedReservation = arbiter.reserve("assistant-session");
  const pinnedListen = pinnedInput.listen({ requestId: "pinned-input", signal: new AbortController().signal, reservation: pinnedReservation });
  await flush();
  selectedProfile = "stt-new";
  resolveAcquisition({ result: new Promise((resolve) => { resolveCapture = resolve; }), stop: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/webm" }), cancel: async () => undefined, close: async () => undefined });
  await flush();
  resolveCapture({ bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/webm" });
  assert.deepEqual(await pinnedListen, { status: "completed", final: "pinned transcript" });
  assert.equal(usedProfile, "stt-old", "the STT snapshot is pinned before capture starts");
  arbiter.releaseReservation(pinnedReservation);

  assert.equal(reactionForVoiceActivity("listening"), "waiting");
  assert.equal(reactionForVoiceActivity("thinking"), "thinking");
  assert.equal(reactionForVoiceActivity("acting"), "working");
  assert.equal(reactionForVoiceActivity("speaking"), "running");

  const assistant = new PetAssistantService({ generate: async () => ({ type: "text", text: "done" }) }, { snapshot: () => ({ capabilities: [] }), execute: async () => ({ ok: true, result: {} }) });
  const adapter = new PetAssistantVoiceAdapter(assistant);
  const activity: string[] = [];
  const canonicalTurnIds: string[] = [];
  const unsubscribe = adapter.subscribe((event) => { activity.push(event.activity); canonicalTurnIds.push(event.turnId); });
  const result = await adapter.startTurn("voice", "hello", new AbortController().signal, "voice-owned-turn-1");
  unsubscribe();
  assert.equal(result.status, "completed");
  assert.equal(result.turnId, "voice-owned-turn-1");
  assert.deepEqual(new Set(canonicalTurnIds), new Set(["voice-owned-turn-1"]), "the real adapter forwards the host-owned voice correlation id through canonical service events");
  assert.deepEqual(activity, ["thinking", "responding"], "the adapter forwards canonical assistant activity events");
  await assistant.stop();

  const sessionArbiter = new VoiceMicrophoneArbiter();
  let created = 0;
  const controller = new VoiceAssistantHostController(() => {
    created += 1;
    let cancelInput!: () => void;
    const input = {
      listen: async () => new Promise<{ status: "cancelled"; reason: string }>((resolve) => { cancelInput = () => resolve({ status: "cancelled", reason: "ended" }); }),
      cancel: async () => { cancelInput?.(); },
    };
    const session = new VoiceAssistantSession({
      microphoneArbiter: sessionArbiter,
      input,
      assistant: { startTurn: async () => ({ status: "cancelled" as const }), subscribe: () => () => {} },
      synthesizer: { synthesize: async () => ({ kind: "system" as const, text: "" }) },
      player: { play: async () => undefined, stop: async () => undefined },
    });
    return { session, shutdown: () => session.shutdown() };
  });
  const firstSession = await controller.activate();
  assert.equal(sessionArbiter.activeOwner, "assistant-session");
  await controller.end();
  assert.equal(firstSession.snapshot().activity, null, "ended sessions clear host activity");
  assert.equal(sessionArbiter.activeOwner, null, "ending releases the session microphone reservation");
  const secondSession = await controller.activate();
  assert.notEqual(secondSession, firstSession, "a later activation creates a fresh generic session");
  assert.equal(created, 2);
  await controller.shutdown();
  assert.equal(sessionArbiter.activeOwner, null);

  let raceCreated = 0;
  const raceController = new VoiceAssistantHostController(() => {
    raceCreated += 1;
    const session = new VoiceAssistantSession({
      microphoneArbiter: new VoiceMicrophoneArbiter(),
      input: { listen: async () => ({ status: "cancelled" as const }), cancel: async () => undefined },
      assistant: { startTurn: async () => ({ status: "cancelled" as const }), subscribe: () => () => {} },
      synthesizer: { synthesize: async () => ({ kind: "system" as const, text: "" }) },
      player: { play: async () => undefined, stop: async () => undefined },
    });
    return { session, shutdown: () => session.shutdown() };
  });
  const queuedActivation = raceController.activate();
  const raceShutdown = raceController.shutdown();
  await assert.rejects(queuedActivation, /host has stopped/);
  await raceShutdown;
  assert.equal(raceCreated, 0, "shutdown rejects a queued activation before creating a session");

  let indicatorDestroyed = 0;
  let indicatorTracks = 0;
  const ownerSurface: VoicePrivacyIndicatorSurface = { show() {}, hide() {}, destroy() { indicatorDestroyed += 1; } };
  const ownerIndicator = new VoicePrivacyIndicator(() => ownerSurface);
  const owner = new VoiceResourceOwner({
    microphoneArbiter: new VoiceMicrophoneArbiter(),
    privacyIndicator: ownerIndicator,
    captureFactory: () => ({ acquire: async () => ({ result: Promise.resolve({ bytes: new Uint8Array([1]), mimeType: "audio/webm" }), stop: async () => ({ bytes: new Uint8Array([1]), mimeType: "audio/webm" }), cancel: async () => undefined, close: async () => undefined }), cancel: async () => undefined, dispose: async () => undefined }),
  });
  ownerIndicator.trackStarted();
  ownerIndicator.trackStarted();
  indicatorTracks = ownerIndicator.liveTracks;
  const lane = new VoiceConversationService({ microphoneArbiter: owner.microphoneArbiter, privacyIndicator: owner.privacyIndicator, transportFactory: () => ({ start: async () => undefined, setMuted: () => undefined, close: async () => undefined }) });
  await lane.shutdown();
  assert.equal(indicatorDestroyed, 0, "individual lane shutdown cannot destroy shared privacy state");
  assert.equal(ownerIndicator.liveTracks, indicatorTracks);
  await owner.shutdown();
  assert.equal(indicatorDestroyed, 1, "the shared owner destroys privacy state once all lanes stop");

  const composedRoles: string[] = [];
  let utterance = 0;
  let textCall = 0;
  const composedBodies: Array<Record<string, unknown>> = [];
  const capabilityHandle = { generation: 1 } as object;
  const capabilityInvocations: unknown[] = [];
  const composedProvider: HostProviderOperations = {
    snapshot: async (role) => { composedRoles.push(role); return { ...snapshot(role === "realtime" ? "text" : role), profile: { ...snapshot(role === "realtime" ? "text" : role).profile, id: `${role}-selected` } }; },
    json: async (_snapshot, path, body) => {
      assert.equal(path, "/chat/completions");
      composedBodies.push(body);
      textCall += 1;
      if (textCall === 1) return { choices: [{ message: { tool_calls: [{ id: "call-1", function: { name: petAssistantToolName("focus.buddy", "start"), arguments: JSON.stringify({ minutes: 25 }) } }] } }] };
      return { choices: [{ message: { content: textCall === 2 ? "Focus capability completed." : "Second authoritative answer." } }] };
    },
    binary: async () => new Uint8Array(),
    stream: async () => undefined,
    transcribe: async () => `selected request ${++utterance}`,
    synthesize: async () => ({ bytes: new Uint8Array([9]), mimeType: "audio/mpeg" }),
    negotiateRealtime: async () => "",
  };
  const composedAssistant = new PetAssistantService(new TextModelClient(composedProvider), {
    snapshot: () => ({ capabilities: [{ pluginId: "focus.buddy", capability: { id: "start", description: "Start focus", inputSchema: { type: "object" } }, handle: capabilityHandle }] }),
    execute: async (_handle, input) => { capabilityInvocations.push(input); return { ok: true, result: { started: true } }; },
  });
  const composedArbiter = new VoiceMicrophoneArbiter();
  const composedInput = new HostVoiceInput(composedProvider, captureService(composedArbiter));
  const composedOutput = new ProviderVoiceSynthesizer(composedProvider);
  const assistantTranscripts: string[] = [];
  const transcriptEvents: string[] = [];
  const composedActivities: string[] = [];
  const composedSession = new VoiceAssistantSession({
    microphoneArbiter: composedArbiter,
    input: composedInput,
    assistant: new PetAssistantVoiceAdapter(composedAssistant),
    synthesizer: composedOutput,
    player: { play: async (_requestId, _speech, _signal, onStarted) => { onStarted?.(); await flush(); }, stop: async () => undefined },
  });
  composedSession.subscribe((event) => {
    if (event.type === "snapshot" && event.snapshot.activity && composedActivities.at(-1) !== event.snapshot.activity) composedActivities.push(event.snapshot.activity);
    if (event.type !== "transcript") return;
    transcriptEvents.push(`${event.speaker}:${event.kind}`);
    if (event.speaker === "assistant" && event.kind === "final") assistantTranscripts.push(event.text);
  });
  await composedSession.start();
  await waitFor(() => assistantTranscripts.length === 2);
  await composedSession.end();
  await composedAssistant.startTurn("voice-assistant", "after voice ended");
  const followupMessages = composedBodies.at(-1)?.messages as Array<{ role: string; content?: string }>;
  assert.equal(followupMessages.some((message) => message.role === "user" && message.content === "selected request 1"), true, "ending voice preserves the canonical assistant context for a later turn");
  await composedAssistant.stop();
  assert.deepEqual(capabilityInvocations, [{ minutes: 25 }]);
  assert.deepEqual(assistantTranscripts, ["Focus capability completed.", "Second authoritative answer."]);
  assert.deepEqual(transcriptEvents, ["user:final", "assistant:final", "user:final", "assistant:final"], "the composed host emits final-only transcripts");
  assert.equal(composedActivities.includes("listening"), true);
  assert.equal(composedActivities.includes("thinking"), true);
  assert.equal(composedActivities.includes("acting"), true);
  assert.equal(composedActivities.includes("speaking"), true);
  assert.equal(composedRoles.includes("text"), true);
  assert.equal(composedRoles.includes("stt"), true);
  assert.equal(composedRoles.includes("tts"), true);
  assert.equal(composedArbiter.activeOwner, null, "composed session cleanup releases the microphone");
}

main().then(() => console.log("Voice assistant host core behavior verified."), (error) => { console.error(error); process.exitCode = 1; });
