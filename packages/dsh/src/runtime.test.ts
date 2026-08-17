import assert from "node:assert/strict";

import { hookSpeechPools } from "@open-pets/agent-events";
import type { Context } from "@deepseek-ai/cordis";

import { apply, createOpenPetsDshClient } from "./index.js";

type RecordedCall = {
  readonly message: string;
  readonly options?: unknown;
};

const forbiddenContent = [
  "PRIVATE_PROMPT",
  "PRIVATE_TOOL_RESULT",
  "/Users/private/project/file.ts",
  "https://private.example.test/secret",
  "token=private-secret",
];

{
  const calls: RecordedCall[] = [];
  const scheduled: Array<() => Promise<void>> = [];
  const handlers = new Map<string, (...args: readonly unknown[]) => unknown>();
  const context = {
    on(eventName: string, listener: (...args: readonly unknown[]) => unknown) {
      handlers.set(eventName, listener);
    },
  } as unknown as Context;

  apply(context, {
    schedule: (work: () => Promise<void>) => { scheduled.push(work); },
    clientFactory: () => createMockClient(calls),
    random: () => 0,
  });

  const approvalHandler = handlers.get("approval/request");
  assert.ok(approvalHandler);
  const nextResult = { approved: true };
  let nextCalls = 0;
  const returned = approvalHandler(
    createPayload(),
    () => {
      nextCalls += 1;
      return nextResult;
    },
  );
  assert.equal(returned, nextResult);
  assert.equal(nextCalls, 1);
  assert.equal(scheduled.length, 1, "approval dispatch must only be scheduled");
  assert.deepEqual(calls, [], "approval must not wait for or call IPC");
  await scheduled.shift()?.();
  assert.deepEqual(calls, [{ message: hookSpeechPools.permission[0] ?? "", options: { reaction: "waiting" } }]);

  const statusHandler = handlers.get("agent/status");
  assert.ok(statusHandler);
  statusHandler(createPayload({ status: "running" }));
  assert.equal(scheduled.length, 1);
  assert.equal(calls.length, 1);
  await scheduled.shift()?.();
  assert.deepEqual(calls.at(-1), { message: hookSpeechPools.thinking[0], options: { reaction: "thinking" } });
  assertNoForbiddenContent(calls);
}

{
  let now = 10_000;
  const scheduled: Array<() => Promise<void>> = [];
  const calls: RecordedCall[] = [];
  const handlers = new Map<string, (...args: readonly unknown[]) => unknown>();
  const context = {
    on(eventName: string, listener: (...args: readonly unknown[]) => unknown) {
      handlers.set(eventName, listener);
    },
  } as unknown as Context;
  apply(context, {
    now: () => now,
    schedule: (work: () => Promise<void>) => { scheduled.push(work); },
    clientFactory: () => createMockClient(calls),
    random: () => 0,
  });

  handlers.get("agent/error")?.(createPayload());
  assert.equal(scheduled.length, 1);
  await scheduled.shift()?.();
  assert.deepEqual(calls.at(-1), { message: hookSpeechPools.error[0], options: { reaction: "error" } });
  now += 4_999;
  handlers.get("agent/status")?.(createPayload({ status: "idle" }));
  assert.equal(scheduled.length, 0, "idle must be suppressed for five seconds after an error");
  now += 1;
  handlers.get("agent/status")?.(createPayload({ status: "idle" }));
  assert.equal(scheduled.length, 1);
  await scheduled.shift()?.();
  assert.deepEqual(calls.at(-1), { message: hookSpeechPools.success[0], options: { reaction: "success" } });
  assertNoForbiddenContent(calls);
}

{
  const previousEndpoint = process.env.OPENPETS_REMOTE_ENDPOINT;
  const previousToken = process.env.OPENPETS_REMOTE_TOKEN;
  process.env.OPENPETS_REMOTE_ENDPOINT = "tcp://8.8.8.8:37645";
  process.env.OPENPETS_REMOTE_TOKEN = "too-short";
  try {
    assert.equal(createOpenPetsDshClient().transport, "local");
  } finally {
    restoreEnvironment("OPENPETS_REMOTE_ENDPOINT", previousEndpoint);
    restoreEnvironment("OPENPETS_REMOTE_TOKEN", previousToken);
  }
}

console.log("DSH runtime behavior checks passed.");

function createMockClient(calls: RecordedCall[]) {
  return {
    hello: async () => ({}),
    status: async () => ({ ok: true, appRunning: true }),
    listPets: async () => ({ ok: true as const, defaultPetId: "builtin", pets: [] }),
    installPet: async () => ({ ok: true as const, petId: "unused", displayName: "Unused", installed: true as const }),
    installLocalPet: async () => ({ ok: true as const, petId: "unused", displayName: "Unused", installed: true as const }),
    acquireLease: async () => { throw new Error("leases are not used"); },
    heartbeatLease: async () => ({ leaseId: "unused", expiresAt: 0 }),
    releaseLease: async () => ({ released: true }),
    react: async () => undefined,
    say: async (message: string, options?: unknown) => { calls.push({ message, options }); },
    showMedia: async () => ({ ok: true, shown: true }),
  };
}

function createPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: "ignored-agent",
    status: "idle",
    prompt: forbiddenContent[0],
    toolResult: forbiddenContent[1],
    path: forbiddenContent[2],
    url: forbiddenContent[3],
    secret: forbiddenContent[4],
    ...overrides,
  };
}

function assertNoForbiddenContent(calls: readonly RecordedCall[]): void {
  const serialized = JSON.stringify(calls);
  for (const content of forbiddenContent) assert.equal(serialized.includes(content), false, `forwarded forbidden content: ${content}`);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
