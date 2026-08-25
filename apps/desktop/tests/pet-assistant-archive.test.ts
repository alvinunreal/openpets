import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  LOCAL_CONVERSATION_ARCHIVE_MAX_AGE_MS,
  LOCAL_CONVERSATION_ARCHIVE_MAX_BYTES,
  LOCAL_CONVERSATION_ARCHIVE_MAX_MESSAGES,
  LocalPetAssistantConversationArchive,
  openLocalPetAssistantConversationArchive,
  PET_ASSISTANT_ARCHIVE_FILE_NAME,
  PET_ASSISTANT_CONVERSATION_ID,
} from "../src/pet-assistant-archive.js";
import { PetAssistantService } from "../src/pet-assistant-service.js";
import { petAssistantToolName } from "../src/pet-assistant-tools.js";
import type { PetAssistantCapabilityRuntime, PetAssistantTextModelRequest, PetAssistantTextModelResponse } from "../src/pet-assistant-types.js";

function temporaryDirectory(): string { return mkdtempSync(join(tmpdir(), "openpets-conversation-archive-")); }

const emptyRuntime: PetAssistantCapabilityRuntime = {
  snapshot: () => ({ capabilities: [] }),
  execute: async () => ({ ok: true, result: {} }),
};

function messageContent(message: PetAssistantTextModelRequest["messages"][number]): string | undefined {
  return message.role === "tool" ? undefined : message.content;
}

// Archive unavailability is local-history degradation, never a prerequisite for the assistant host.
{
  const root = temporaryDirectory();
  try {
    const diagnostics: string[] = [];
    const archive = openLocalPetAssistantConversationArchive({
      archivePath: join(root, "unavailable.json"),
      persist: () => { throw new Error("disk unavailable"); },
      onDiagnostic: (message) => diagnostics.push(message),
    });
    assert.equal(archive, undefined);
    assert.deepEqual(diagnostics, ["Pet Assistant conversation archive is unavailable for this session."]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Retention keeps the newest messages by count, age, and serialized byte budget.
{
  const root = temporaryDirectory();
  try {
    const archive = new LocalPetAssistantConversationArchive({ archivePath: join(root, "count.json"), now: () => 1_000_000 });
    archive.append(Array.from({ length: LOCAL_CONVERSATION_ARCHIVE_MAX_MESSAGES + 5 }, (_, index) => ({
      turnId: `turn-${index}`,
      role: "user" as const,
      text: `message-${index}`,
    })));
    const byCount = archive.list();
    assert.equal(byCount.length, LOCAL_CONVERSATION_ARCHIVE_MAX_MESSAGES);
    assert.equal(byCount[0]?.text, "message-5");
    assert.equal(byCount.at(-1)?.text, `message-${LOCAL_CONVERSATION_ARCHIVE_MAX_MESSAGES + 4}`);

    const byteArchive = new LocalPetAssistantConversationArchive({ archivePath: join(root, "bytes.json"), now: () => 2_000_000 });
    byteArchive.append(Array.from({ length: 12 }, (_, index) => ({ turnId: `byte-${index}`, role: "user" as const, text: "x".repeat(60_000) })));
    assert.ok(Buffer.byteLength(readFileSync(join(root, "bytes.json"), "utf8"), "utf8") <= LOCAL_CONVERSATION_ARCHIVE_MAX_BYTES);
    assert.equal(byteArchive.list().at(-1)?.turnId, "byte-11");

    const clock = { now: 3_000_000 };
    const ageArchive = new LocalPetAssistantConversationArchive({ archivePath: join(root, "age.json"), now: () => clock.now });
    ageArchive.append([{ turnId: "old", role: "user", text: "old" }], clock.now);
    clock.now += LOCAL_CONVERSATION_ARCHIVE_MAX_AGE_MS + 1;
    assert.deepEqual(ageArchive.list(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Incomplete turns never become future archive context, and archive cleanup failures do not fail a valid turn.
{
  const root = temporaryDirectory();
  try {
    const archive = new LocalPetAssistantConversationArchive({ archivePath: join(root, "incomplete.json"), now: () => 5_500_000 });
    const failed = new PetAssistantService({ generate: () => { throw new Error("model unavailable"); } }, emptyRuntime, { conversationArchive: archive });
    const failedResult = await failed.startTurn(PET_ASSISTANT_CONVERSATION_ID, "unanswered question");
    assert.equal(failedResult.status, "failed");
    assert.deepEqual(archive.list(), [], "a failed turn does not leave unanswered prompt context behind");

    let providerCalls = 0;
    const archiveErrors: string[] = [];
    const unavailableArchive = {
      list: () => { throw new Error("archive cleanup failed"); },
      append: () => { throw new Error("not reached"); },
      deleteMessage: () => false,
      clear: () => {},
    };
    const resilient = new PetAssistantService({ generate: () => {
      providerCalls += 1;
      return { type: "text", text: "still responds" };
    } }, emptyRuntime, {
      conversationArchive: unavailableArchive,
      onConversationArchiveError: (error) => archiveErrors.push(error instanceof Error ? error.message : "unknown"),
    });
    const result = await resilient.startTurn(PET_ASSISTANT_CONVERSATION_ID, "continue without archive");
    assert.equal(result.status, "completed");
    assert.equal(providerCalls, 1, "archive cleanup failure never suppresses a valid provider turn");
    assert.deepEqual(archiveErrors, ["archive cleanup failed", "not reached"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A corrupt archive is quarantined and replaced instead of being partially trusted.
{
  const root = temporaryDirectory();
  try {
    const path = join(root, PET_ASSISTANT_ARCHIVE_FILE_NAME);
    writeFileSync(path, "{not valid json", "utf8");
    const diagnostics: string[] = [];
    const archive = new LocalPetAssistantConversationArchive({ archivePath: path, onDiagnostic: (message) => diagnostics.push(message) });
    assert.deepEqual(archive.list(), []);
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")) as unknown, { version: 1, messages: [] });
    assert.equal(readdirSync(root).some((name: string) => name.startsWith(`${PET_ASSISTANT_ARCHIVE_FILE_NAME}.corrupt-`)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A failed atomic write never changes the archive's in-memory view before it reaches disk.
{
  const root = temporaryDirectory();
  try {
    const path = join(root, "write-failure.json");
    const writable = new LocalPetAssistantConversationArchive({ archivePath: path, now: () => 3_500_000 });
    writable.append([{ turnId: "durable", role: "user", text: "Still durable" }]);
    const failing = new LocalPetAssistantConversationArchive({
      archivePath: path,
      now: () => 3_500_000,
      persist: () => { throw new Error("disk unavailable"); },
    });
    assert.throws(() => failing.append([{ turnId: "lost", role: "assistant", text: "Must not appear" }]), /disk unavailable/);
    assert.throws(() => failing.deleteMessage(failing.list()[0]!.id), /disk unavailable/);
    assert.throws(() => failing.clear(), /disk unavailable/);
    assert.deepEqual(failing.list().map((message) => message.text), ["Still durable"], "write failures leave memory consistent with the durable archive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Service history is canonical-text-only, supports narrow erase operations, and never calls the provider for reads.
{
  const root = temporaryDirectory();
  try {
    const archive = new LocalPetAssistantConversationArchive({ archivePath: join(root, "history.json"), now: () => 4_000_000 });
    archive.append([
      { turnId: "prior", role: "user", text: "prior question" },
      { turnId: "prior", role: "assistant", text: "prior answer" },
    ]);
    const requests: PetAssistantTextModelRequest[] = [];
    let providerCalls = 0;
    const responses: readonly PetAssistantTextModelResponse[] = [
      { type: "text", text: "first answer" },
      { type: "text", text: "second answer" },
    ];
    const service = new PetAssistantService({
      generate: (request) => {
        providerCalls += 1;
        requests.push(request);
        return responses[providerCalls - 1] ?? { type: "text", text: "fallback" };
      },
    }, emptyRuntime, { conversationArchive: archive });

    await service.startTurn(PET_ASSISTANT_CONVERSATION_ID, "first question");
    const history = service.getConversationHistory();
    assert.deepEqual(history.map((message) => [message.role, message.text]), [["user", "prior question"], ["assistant", "prior answer"], ["user", "first question"], ["assistant", "first answer"]]);
    assert.equal(requests[0]?.messages.some((message) => message.role === "user" && message.content === "prior question"), true, "recent archive text is injected into the first prompt");
    assert.equal(providerCalls, 1);
    assert.equal(service.deleteConversationHistoryMessage(history[0]!.id), true);
    assert.deepEqual(service.getConversationHistory().map((message) => message.text), ["prior answer", "first question", "first answer"]);
    service.clearConversationHistory();
    assert.deepEqual(service.getConversationHistory(), []);
    assert.equal(providerCalls, 1, "reading and erasing history must not call the provider");

    await service.startTurn(PET_ASSISTANT_CONVERSATION_ID, "second question");
    assert.equal(requests[1]?.messages.some((message) => message.role === "user" && message.content === "first question"), true, "active context remains after archive deletion");
    assert.deepEqual(service.getConversationHistory().map((message) => message.text), ["second question", "second answer"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Prompt history is most-recent-only, independently byte-bounded, and never collides with a reused canonical turn id.
{
  const root = temporaryDirectory();
  try {
    const archive = new LocalPetAssistantConversationArchive({ archivePath: join(root, "prompt-limits.json"), now: () => 4_500_000 });
    archive.append(Array.from({ length: 26 }, (_, index) => ({ turnId: `old-turn-${index}`, role: "user" as const, text: `count-context-${index}` })));
    const requests: PetAssistantTextModelRequest[] = [];
    const service = new PetAssistantService({ generate: (request) => {
      requests.push(request);
      return { type: "text", text: "new response" };
    } }, emptyRuntime, { conversationArchive: archive, limits: { maxContextBytes: 512 * 1024 } });
    await service.startTurn(PET_ASSISTANT_CONVERSATION_ID, "current message", new AbortController().signal, { turnId: "old-turn-0" });
    const firstPrompt = requests[0]!;
    assert.equal(firstPrompt.messages.some((message) => messageContent(message) === "count-context-0"), false, "oldest archive entries are excluded after the 24-message context limit");
    assert.equal(firstPrompt.messages.some((message) => messageContent(message) === "count-context-1"), false);
    assert.equal(firstPrompt.messages.some((message) => messageContent(message) === "count-context-25"), true, "newest archive entries remain in context");
    assert.equal(firstPrompt.messages.filter((message) => messageContent(message)?.startsWith("count-context-")).length, 24);

    const byteArchive = new LocalPetAssistantConversationArchive({ archivePath: join(root, "prompt-bytes.json"), now: () => 4_500_000 });
    byteArchive.append([
      { turnId: "byte-old", role: "user", text: `byte-old:${"x".repeat(60_000)}` },
      { turnId: "byte-middle", role: "assistant", text: `byte-middle:${"y".repeat(60_000)}` },
      { turnId: "byte-new", role: "user", text: `byte-new:${"z".repeat(60_000)}` },
    ]);
    const byteRequests: PetAssistantTextModelRequest[] = [];
    const byteService = new PetAssistantService({ generate: (request) => {
      byteRequests.push(request);
      return { type: "text", text: "bounded response" };
    } }, emptyRuntime, { conversationArchive: byteArchive, limits: { maxContextBytes: 512 * 1024 } });
    await byteService.startTurn(PET_ASSISTANT_CONVERSATION_ID, "current byte message");
    assert.equal(byteRequests[0]!.messages.some((message) => messageContent(message)?.startsWith("byte-old:")), false, "oldest archive text is removed to meet the archived-context byte limit");
    assert.equal(byteRequests[0]!.messages.some((message) => messageContent(message)?.startsWith("byte-new:")), true);

    const restartArchive = new LocalPetAssistantConversationArchive({ archivePath: join(root, "restart.json"), now: () => 4_500_000 });
    restartArchive.append([{ turnId: "turn-1", role: "user", text: "archive survives canonical turn-id reuse" }]);
    const restartRequests: PetAssistantTextModelRequest[] = [];
    const restartedService = new PetAssistantService({ generate: (request) => {
      restartRequests.push(request);
      return { type: "text", text: "fresh response" };
    } }, emptyRuntime, { conversationArchive: restartArchive });
    await restartedService.startTurn(PET_ASSISTANT_CONVERSATION_ID, "new process turn", new AbortController().signal, { turnId: "turn-1" });
    assert.equal(restartRequests[0]!.messages.some((message) => messageContent(message) === "archive survives canonical turn-id reuse"), true, "archive selection uses a process-independent archive identity rather than canonical turn ids");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Tool-call definitions and authoritative tool results never cross the archive boundary.
{
  const root = temporaryDirectory();
  try {
    const archive = new LocalPetAssistantConversationArchive({ archivePath: join(root, "tool-turn.json"), now: () => 5_000_000 });
    const responses: readonly PetAssistantTextModelResponse[] = [
      { type: "tool-calls", toolCalls: [{ id: "tool-call", name: petAssistantToolName("missing.buddy", "run"), arguments: { secret: "provider-payload" } }] },
      { type: "text", text: "The capability was unavailable." },
    ];
    let index = 0;
    const service = new PetAssistantService({ generate: () => responses[index++]! }, emptyRuntime, { conversationArchive: archive });
    await service.startTurn(PET_ASSISTANT_CONVERSATION_ID, "run the capability");
    assert.deepEqual(archive.list().map((message) => Object.keys(message).sort()), [
      ["conversationId", "createdAt", "id", "role", "text", "turnId"],
      ["conversationId", "createdAt", "id", "role", "text", "turnId"],
    ]);
    assert.equal(JSON.stringify(archive.list()).includes("provider-payload"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("pet-assistant-archive tests passed.");
