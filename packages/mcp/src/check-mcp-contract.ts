import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { parseMcpArgs } from "./args.js";
import { wireTransportLifecycle, type OpenPetsLeaseResult } from "./index.js";
import { createOpenPetsMcpServer } from "./server.js";
import { createMcpStatus, sanitizeUnavailableReason, type LeaseContext, type OpenPetsMcpStatus } from "./tools.js";

parseMcpArgs(["--pet", "snoopy"]);
parseMcpArgs(["--pet=snoopy"]);
parseMcpArgs(["--pet", "Bad Pet"]);
parseMcpArgs(["--help"]);
assertRejects(() => parseMcpArgs(["--pet", "bad/pet"]));
assertRejects(() => parseMcpArgs(["--agent", "claude"]));

const unavailableStatus = createMcpStatus({ ok: false, appRunning: false, unavailableReason: "/Users/alvin/.config/OpenPets/runtime/ipc.json ENOENT" }, "snoopy");
if (unavailableStatus.routingImplemented !== true || unavailableStatus.configuredPetId !== "snoopy") {
  throw new Error("MCP status did not preserve configured pet during degraded status.");
}
if (unavailableStatus.unavailableReason?.includes("/Users/")) {
  throw new Error("Unavailable reason leaked a local path.");
}
if (sanitizeUnavailableReason("/tmp/openpets-501/openpets-1.sock ENOENT")?.includes("/tmp")) {
  throw new Error("Sanitizer leaked socket path.");
}

await checkMcpServerContract();
await checkStdioServerContract();
await checkT6TransportOnclose();
await checkT7EnsureLeaseHeartbeatFirst();
await checkT8ExitOnce();
await checkT9CloseDuringStartupAcquire();
await checkT10CloseDuringRecoveryAcquire();
const builtEntrypoint = readFileSync(join("dist", "index.js"), "utf8");
if (!builtEntrypoint.startsWith("#!/usr/bin/env node")) {
  throw new Error("Built MCP entrypoint is missing a Node shebang.");
}

console.error("MCP contract validation passed.");

async function checkMcpServerContract(): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const fakeClient = {
    status: async () => ({ ok: true, appRunning: true, defaultPet: { id: "snoopy", displayName: "Snoopy" } }),
    listPets: async () => ({ ok: true as const, pets: [], defaultPetId: "builtin" }),
    installPet: async () => { throw new Error("unused"); },
    installLocalPet: async () => { throw new Error("unused"); },
    acquireLease: async () => ({ leaseId: "lease-1", requestedPetId: "snoopy", targetKind: "explicit" as const, actualTargetPetId: "snoopy", actualTargetPetName: "Snoopy", usingDefaultPet: false, expiresAt: Date.now() + 15_000, leaseActive: true }),
    heartbeatLease: async (leaseId: string) => ({ leaseId, expiresAt: Date.now() + 15_000 }),
    releaseLease: async () => ({ released: true }),
    react: async (reaction: string, options?: { readonly leaseId?: string }) => ({ ok: true, reaction, leaseId: options?.leaseId }),
    say: async (message: string, options?: { readonly leaseId?: string }) => ({ ok: true, message, leaseId: options?.leaseId }),
    showMedia: async () => ({ ok: true, shown: true }),
    hello: async () => ({ ok: true }),
  };
  const server = createOpenPetsMcpServer({ configuredPetId: "snoopy", client: fakeClient, lease: { lease: await fakeClient.acquireLease() }, leaseReady: Promise.resolve() });
  const client = new Client({ name: "openpets-contract", version: "0.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    if (names.join(",") !== "openpets_react,openpets_say,openpets_status") {
      throw new Error(`Unexpected MCP tool list: ${names.join(",")}`);
    }

    const status = await client.callTool({ name: "openpets_status", arguments: {} }, CallToolResultSchema);
    const structured = status.structuredContent as unknown as OpenPetsMcpStatus;
    if (!structured.ok || structured.configuredPetId !== "snoopy" || structured.routingImplemented !== true || structured.actualTargetPetId !== "snoopy") {
      throw new Error("Status tool returned unexpected structured content.");
    }

    const react = await client.callTool({ name: "openpets_react", arguments: { reaction: "waving" } }, CallToolResultSchema);
    if (react.isError) throw new Error("Valid reaction unexpectedly failed.");
    const reactStructured = react.structuredContent as { readonly result?: { readonly leaseId?: string } } | undefined;
    if (reactStructured?.result?.leaseId !== "lease-1") throw new Error("Reaction did not pass lease id to client.");

    const invalidReact = await client.callTool({ name: "openpets_react", arguments: { reaction: "bad" } }, CallToolResultSchema);
    if (!invalidReact.isError) throw new Error("Invalid reaction was not rejected.");

    const invalidSay = await client.callTool({ name: "openpets_say", arguments: { message: "const secret = 1" } }, CallToolResultSchema);
    if (!invalidSay.isError) throw new Error("Unsafe say message was not rejected.");

    const stale = createMcpStatus({ ok: false, appRunning: true, leaseId: "missing", leaseActive: false, staleReason: "unknown_lease" }, "snoopy", undefined, "missing", "missing");
    if (stale.leaseActive !== false || stale.staleReason !== "unknown_lease" || stale.ok !== false) {
      throw new Error("Stale MCP lease status was not preserved.");
    }
  } finally {
    await client.close();
    await server.close();
  }
}

async function checkStdioServerContract(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join("dist", "index.js"), "--pet", "snoopy"],
    env: { ...process.env, OPENPETS_DISCOVERY_FILE: join(process.cwd(), ".missing-openpets-discovery.json") },
    stderr: "ignore",
  });
  const client = new Client({ name: "openpets-stdio-contract", version: "0.0.0" });
  let primaryFailure = false;
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    if (names.join(",") !== "openpets_react,openpets_say,openpets_status") {
      throw new Error(`Unexpected stdio MCP tool list: ${names.join(",")}`);
    }

    const status = await client.callTool({ name: "openpets_status", arguments: {} }, CallToolResultSchema);
    const content = Array.isArray(status.content) ? status.content : [];
    const first = content[0] as { readonly type?: unknown; readonly text?: unknown } | undefined;
    const text = first?.type === "text" && typeof first.text === "string" ? first.text : "";
    if (!text.includes("Configured --pet snoopy") || !text.includes("actual target is unavailable")) {
      throw new Error("Unavailable stdio status did not explain configured pet and unavailable target.");
    }
    const structured = status.structuredContent as unknown as OpenPetsMcpStatus;
    if (structured.appRunning !== false || structured.configuredPetId !== "snoopy" || structured.routingImplemented !== true) {
      throw new Error("Unavailable stdio status returned unexpected structured content.");
    }
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await client.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await transport.close();
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      process.stdin.pause();
    }
    if (!primaryFailure && cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Failed to clean up the stdio MCP contract transport.");
    }
  }
}

/**
 * T6 — Fix 3: transport.onclose must (a) release the active lease,
 * (b) invoke the injected exit seam exactly once, and
 * (c) NOT call acquireLease afterward.
 */
async function checkT6TransportOnclose(): Promise<void> {
  const calls: string[] = [];
  const activeLeaseId = "t6-lease-99";

  const fakeClient = {
    status: async () => ({ ok: true, appRunning: true }),
    listPets: async () => ({ ok: true as const, pets: [], defaultPetId: "builtin" }),
    installPet: async () => { throw new Error("unused"); },
    installLocalPet: async () => { throw new Error("unused"); },
    acquireLease: async () => {
      calls.push("acquireLease");
      return { leaseId: "new-lease", requestedPetId: undefined, targetKind: "default" as const, actualTargetPetId: "default", actualTargetPetName: "Default", usingDefaultPet: true, expiresAt: Date.now() + 15_000, leaseActive: true };
    },
    heartbeatLease: async (leaseId: string) => { calls.push(`heartbeat:${leaseId}`); return { leaseId, expiresAt: Date.now() + 15_000 }; },
    releaseLease: async (leaseId: string) => { calls.push(`releaseLease:${leaseId}`); return { released: true }; },
    react: async () => ({ ok: true }),
    say: async () => ({ ok: true }),
    showMedia: async () => ({ ok: true, shown: true }),
    hello: async () => ({ ok: true }),
  };

  const lease: LeaseContext = {
    lease: { leaseId: activeLeaseId, requestedPetId: undefined, targetKind: "default", actualTargetPetId: "default", actualTargetPetName: "Default", usingDefaultPet: true, expiresAt: Date.now() + 15_000, leaseActive: true },
  };

  // Minimal stubs — we only need onclose to be wirable
  const fakeTransport: { onclose?: (() => void) | undefined } = {};
  const fakeServer = { close: async () => {} };

  let exitCalls = 0;
  const fakeExit = () => { exitCalls++; };

  wireTransportLifecycle({
    transport: fakeTransport,
    server: fakeServer,
    client: fakeClient,
    lease,
    leaseReady: Promise.resolve(),
    exit: fakeExit,
  });

  if (typeof fakeTransport.onclose !== "function") {
    throw new Error("T6: wireTransportLifecycle did not set transport.onclose.");
  }

  // Trigger the onclose callback (simulates stdin EOF)
  fakeTransport.onclose();

  // Allow the async close() to settle
  await new Promise<void>((resolve) => setTimeout(resolve, 50));

  if (!calls.includes(`releaseLease:${activeLeaseId}`)) {
    throw new Error(`T6: releaseLease(${activeLeaseId}) was not called. Calls: ${calls.join(",")}`);
  }
  if (exitCalls !== 1) {
    throw new Error(`T6: exit seam was called ${exitCalls} times (expected 1).`);
  }
  if (calls.includes("acquireLease")) {
    throw new Error(`T6: acquireLease was called after transport.onclose — orphan re-acquire detected. Calls: ${calls.join(",")}`);
  }
}

/**
 * T7 — Fix 2: when staleLeaseId + staleLease are present and heartbeatLease SUCCEEDS,
 * ensureLease must restore context.lease.lease from the stale lease and NOT call acquireLease.
 * Converse: when heartbeatLease REJECTS, acquireLease MUST be called.
 */
async function checkT7EnsureLeaseHeartbeatFirst(): Promise<void> {
  const staleLeaseId = "t7-stale-lease";
  const staleLease = {
    leaseId: staleLeaseId,
    requestedPetId: "snoopy",
    targetKind: "explicit" as const,
    actualTargetPetId: "snoopy",
    actualTargetPetName: "Snoopy",
    usingDefaultPet: false,
    expiresAt: Date.now() - 1_000, // expired on client side
    leaseActive: true,
  };

  // --- T7a: heartbeat succeeds → restore lease, no acquireLease ---
  {
    const calls: string[] = [];
    const fakeClient = {
      status: async () => ({ ok: true, appRunning: true }),
      listPets: async () => ({ ok: true as const, pets: [], defaultPetId: "builtin" }),
      installPet: async () => { throw new Error("unused"); },
      installLocalPet: async () => { throw new Error("unused"); },
      acquireLease: async () => { calls.push("acquireLease"); return { leaseId: "new-lease", requestedPetId: "snoopy", targetKind: "explicit" as const, actualTargetPetId: "snoopy", actualTargetPetName: "Snoopy", usingDefaultPet: false, expiresAt: Date.now() + 15_000, leaseActive: true }; },
      heartbeatLease: async (leaseId: string) => { calls.push(`heartbeat:${leaseId}`); return { leaseId, expiresAt: Date.now() + 15_000 }; },
      releaseLease: async () => { calls.push("releaseLease"); return { released: true }; },
      react: async (reaction: string, options?: { readonly leaseId?: string }) => ({ ok: true, reaction, leaseId: options?.leaseId }),
      say: async (message: string, options?: { readonly leaseId?: string }) => ({ ok: true, message, leaseId: options?.leaseId }),
      showMedia: async () => ({ ok: true, shown: true }),
      hello: async () => ({ ok: true }),
    };

    const lease: LeaseContext = { lease: undefined, staleLeaseId, staleLease };
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server2 = createOpenPetsMcpServer({ configuredPetId: "snoopy", client: fakeClient, lease, leaseReady: Promise.resolve() });
    const mc = new Client({ name: "t7a-client", version: "0.0.0" });
    await Promise.all([server2.connect(st), mc.connect(ct)]);
    try {
      // Calling openpets_react triggers ensureLease (lease is undefined, staleLeaseId is set)
      const result = await mc.callTool({ name: "openpets_react", arguments: { reaction: "waving" } }, CallToolResultSchema);
      if (result.isError) throw new Error(`T7a: openpets_react returned error: ${JSON.stringify(result.content)}`);

      if (calls.includes("acquireLease")) {
        throw new Error(`T7a: acquireLease was called despite heartbeat succeeding. Calls: ${calls.join(",")}`);
      }
      if (!calls.some((c) => c.startsWith("heartbeat:"))) {
        throw new Error(`T7a: heartbeatLease was not attempted. Calls: ${calls.join(",")}`);
      }
      if (!lease.lease || lease.lease.leaseId !== staleLeaseId) {
        throw new Error(`T7a: lease was not restored from staleLeaseId. lease.leaseId=${lease.lease?.leaseId}`);
      }
      if (lease.staleLeaseId !== undefined || lease.staleLease !== undefined) {
        throw new Error(`T7a: staleLeaseId / staleLease were not cleared after recovery.`);
      }
    } finally {
      await mc.close();
      await server2.close();
    }
  }

  // --- T7b: heartbeat fails → acquireLease IS called ---
  {
    const calls: string[] = [];
    const fakeClient = {
      status: async () => ({ ok: true, appRunning: true }),
      listPets: async () => ({ ok: true as const, pets: [], defaultPetId: "builtin" }),
      installPet: async () => { throw new Error("unused"); },
      installLocalPet: async () => { throw new Error("unused"); },
      acquireLease: async () => { calls.push("acquireLease"); return { leaseId: "new-lease-2", requestedPetId: "snoopy", targetKind: "explicit" as const, actualTargetPetId: "snoopy", actualTargetPetName: "Snoopy", usingDefaultPet: false, expiresAt: Date.now() + 15_000, leaseActive: true }; },
      heartbeatLease: async (leaseId: string) => { calls.push(`heartbeat:${leaseId}`); throw new Error("lease not found"); },
      releaseLease: async () => { calls.push("releaseLease"); return { released: true }; },
      react: async (reaction: string, options?: { readonly leaseId?: string }) => ({ ok: true, reaction, leaseId: options?.leaseId }),
      say: async (message: string, options?: { readonly leaseId?: string }) => ({ ok: true, message, leaseId: options?.leaseId }),
      showMedia: async () => ({ ok: true, shown: true }),
      hello: async () => ({ ok: true }),
    };

    const lease: LeaseContext = { lease: undefined, staleLeaseId, staleLease };
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    const server3 = createOpenPetsMcpServer({ configuredPetId: "snoopy", client: fakeClient, lease, leaseReady: Promise.resolve() });
    const mc2 = new Client({ name: "t7b-client", version: "0.0.0" });
    await Promise.all([server3.connect(st2), mc2.connect(ct2)]);
    try {
      const result = await mc2.callTool({ name: "openpets_react", arguments: { reaction: "waving" } }, CallToolResultSchema);
      if (result.isError) throw new Error(`T7b: openpets_react returned error: ${JSON.stringify(result.content)}`);

      if (!calls.some((c) => c.startsWith("heartbeat:"))) {
        throw new Error(`T7b: heartbeatLease was not attempted. Calls: ${calls.join(",")}`);
      }
      if (!calls.includes("acquireLease")) {
        throw new Error(`T7b: acquireLease was NOT called after heartbeat failure. Calls: ${calls.join(",")}`);
      }
    } finally {
      await mc2.close();
      await server3.close();
    }
  }
}

function assertRejects(callback: () => unknown): void {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error("Expected validation to reject.");
}

/**
 * T8 — Fix L2: exit seam must fire EXACTLY ONCE even when transport.onclose is triggered
 * multiple times (re-entrant from server.close, or repeated calls from close()). Release
 * must precede the single exit call.
 */
async function checkT8ExitOnce(): Promise<void> {
  const activeLeaseId = "t8-lease-77";
  const releaseOrder: string[] = [];

  const fakeClient = {
    status: async () => ({ ok: true, appRunning: true }),
    listPets: async () => ({ ok: true as const, pets: [], defaultPetId: "builtin" }),
    installPet: async () => { throw new Error("unused"); },
    installLocalPet: async () => { throw new Error("unused"); },
    acquireLease: async () => ({ leaseId: "new", requestedPetId: undefined, targetKind: "default" as const, actualTargetPetId: "default", actualTargetPetName: "Default", usingDefaultPet: true, expiresAt: Date.now() + 15_000, leaseActive: true }),
    heartbeatLease: async (leaseId: string) => ({ leaseId, expiresAt: Date.now() + 15_000 }),
    releaseLease: async (leaseId: string) => { releaseOrder.push("release:" + leaseId); return { released: true }; },
    react: async () => ({ ok: true }),
    say: async () => ({ ok: true }),
    showMedia: async () => ({ ok: true, shown: true }),
    hello: async () => ({ ok: true }),
  };

  const lease: LeaseContext = {
    lease: { leaseId: activeLeaseId, requestedPetId: undefined, targetKind: "default", actualTargetPetId: "default", actualTargetPetName: "Default", usingDefaultPet: true, expiresAt: Date.now() + 15_000, leaseActive: true },
  };

  const fakeTransport: { onclose?: (() => void) | undefined } = {};
  // server.close re-fires onclose to simulate MCP SDK re-entrancy
  const fakeServer = { close: async () => { fakeTransport.onclose?.(); } };

  let exitCalls = 0;
  const fakeExit = (): void => { exitCalls++; releaseOrder.push("exit"); };

  wireTransportLifecycle({
    transport: fakeTransport,
    server: fakeServer,
    client: fakeClient,
    lease,
    leaseReady: Promise.resolve(),
    exit: fakeExit,
  });

  // Fire onclose three times (natural + re-entrant from server.close + extra call)
  fakeTransport.onclose?.();
  fakeTransport.onclose?.();
  fakeTransport.onclose?.();

  // Allow async teardown to settle
  await new Promise<void>((resolve) => setTimeout(resolve, 50));

  if (exitCalls !== 1) {
    throw new Error("T8: exit seam fired " + exitCalls + " times — expected exactly 1. Order: " + releaseOrder.join(","));
  }

  const releaseIdx = releaseOrder.indexOf("release:" + activeLeaseId);
  const exitIdx = releaseOrder.indexOf("exit");
  if (releaseIdx === -1) {
    throw new Error("T8: releaseLease was never called. Order: " + releaseOrder.join(","));
  }
  if (exitIdx === -1) {
    throw new Error("T8: exit was never recorded. Order: " + releaseOrder.join(","));
  }
  if (releaseIdx >= exitIdx) {
    throw new Error("T8: release did not precede exit. Order: " + releaseOrder.join(","));
  }
}

/**
 * T9 — Closing while startup acquisition is unresolved must wait for that
 * acquisition, release its eventual lease, and only then exit. Cursor can
 * replace an MCP process during startup; leaking that process's lease briefly
 * displays a second pool pet until the lease TTL expires.
 */
async function checkT9CloseDuringStartupAcquire(): Promise<void> {
  const order: string[] = [];
  const startupLeaseId = "t9-startup-lease";
  let finishStartup: (() => void) | undefined;
  const leaseReady = new Promise<void>((resolve) => {
    finishStartup = resolve;
  });
  const lease: LeaseContext = {};
  const fakeTransport: { onclose?: (() => void) | undefined } = {};
  const fakeClient = {
    status: async () => ({ ok: true, appRunning: true }),
    listPets: async () => ({ ok: true as const, pets: [], defaultPetId: "builtin" }),
    installPet: async () => { throw new Error("unused"); },
    installLocalPet: async () => { throw new Error("unused"); },
    acquireLease: async () => { throw new Error("unused"); },
    heartbeatLease: async (leaseId: string) => ({ leaseId, expiresAt: Date.now() + 15_000 }),
    releaseLease: async (leaseId: string) => { order.push(`release:${leaseId}`); return { released: true }; },
    react: async () => ({ ok: true }),
    say: async () => ({ ok: true }),
    showMedia: async () => ({ ok: true, shown: true }),
    hello: async () => ({ ok: true }),
  };
  const fakeServer = { close: async () => { order.push("server.close"); } };

  wireTransportLifecycle({
    transport: fakeTransport,
    server: fakeServer,
    client: fakeClient,
    lease,
    leaseReady,
    exit: () => { order.push("exit"); },
  });

  fakeTransport.onclose?.();
  fakeTransport.onclose?.();
  await Promise.resolve();
  if (order.includes("exit")) {
    throw new Error(`T9: process exited before startup acquisition settled. Order: ${order.join(",")}`);
  }

  lease.lease = {
    leaseId: startupLeaseId,
    requestedPetId: undefined,
    targetKind: "explicit",
    actualTargetPetId: "snoopy",
    actualTargetPetName: "Snoopy",
    usingDefaultPet: false,
    expiresAt: Date.now() + 15_000,
    leaseActive: true,
  };
  finishStartup?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  const releaseIndex = order.indexOf(`release:${startupLeaseId}`);
  const exitIndex = order.indexOf("exit");
  if (releaseIndex === -1 || exitIndex === -1 || releaseIndex >= exitIndex) {
    throw new Error(`T9: startup lease was not released before exit. Order: ${order.join(",")}`);
  }
  if (order.filter((event) => event === "exit").length !== 1) {
    throw new Error(`T9: repeated close exited more than once. Order: ${order.join(",")}`);
  }
}

/**
 * T10 — If shutdown begins while retry recovery is acquiring a replacement
 * lease, teardown must join that recovery and release its eventual result.
 */
async function checkT10CloseDuringRecoveryAcquire(): Promise<void> {
  const order: string[] = [];
  const recoveredLeaseId = "t10-recovered-lease";
  let finishAcquire: ((lease: OpenPetsLeaseResult) => void) | undefined;
  const acquireResult = new Promise<OpenPetsLeaseResult>((resolve) => {
    finishAcquire = resolve;
  });
  const lease: LeaseContext = {
    lease: {
      leaseId: "t10-stale-lease",
      requestedPetId: undefined,
      targetKind: "explicit",
      actualTargetPetId: "snoopy",
      actualTargetPetName: "Snoopy",
      usingDefaultPet: false,
      expiresAt: Date.now() + 15_000,
      leaseActive: true,
    },
  };
  const fakeTransport: { onclose?: (() => void) | undefined } = {};
  const fakeClient = {
    status: async () => ({ ok: true, appRunning: true }),
    listPets: async () => ({ ok: true as const, pets: [], defaultPetId: "builtin" }),
    installPet: async () => { throw new Error("unused"); },
    installLocalPet: async () => { throw new Error("unused"); },
    acquireLease: async () => { order.push("acquire:start"); return acquireResult; },
    heartbeatLease: async () => { throw new Error("simulated heartbeat failure"); },
    releaseLease: async (leaseId: string) => { order.push(`release:${leaseId}`); return { released: true }; },
    react: async () => ({ ok: true }),
    say: async () => ({ ok: true }),
    showMedia: async () => ({ ok: true, shown: true }),
    hello: async () => ({ ok: true }),
  };

  wireTransportLifecycle({
    transport: fakeTransport,
    server: { close: async () => { order.push("server.close"); } },
    client: fakeClient,
    lease,
    leaseReady: Promise.resolve(),
    heartbeatIntervalMs: 1,
    retryDelayMs: 1,
    exit: () => { order.push("exit"); },
  });

  for (let attempts = 0; attempts < 20 && !order.includes("acquire:start"); attempts += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  if (!order.includes("acquire:start")) {
    throw new Error(`T10: recovery acquisition did not start. Order: ${order.join(",")}`);
  }

  fakeTransport.onclose?.();
  await Promise.resolve();
  if (order.includes("exit")) {
    throw new Error(`T10: process exited while recovery acquisition was unresolved. Order: ${order.join(",")}`);
  }

  finishAcquire?.({
    leaseId: recoveredLeaseId,
    requestedPetId: undefined,
    targetKind: "explicit",
    actualTargetPetId: "snoopy",
    actualTargetPetName: "Snoopy",
    usingDefaultPet: false,
    expiresAt: Date.now() + 15_000,
    leaseActive: true,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  const releaseIndex = order.indexOf(`release:${recoveredLeaseId}`);
  const exitIndex = order.indexOf("exit");
  if (releaseIndex === -1 || exitIndex === -1 || releaseIndex >= exitIndex) {
    throw new Error(`T10: recovered lease was not released before exit. Order: ${order.join(",")}`);
  }
}
