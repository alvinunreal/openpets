#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { OpenPetsClient, OpenPetsLeaseResult } from "@open-pets/client";

import { createHelpText, parseMcpArgs } from "./args.js";
import { createOpenPetsMcpServer } from "./server.js";
import { createToolContext, type LeaseContext } from "./tools.js";

/** Minimal transport interface required by wireTransportLifecycle (subset of StdioServerTransport). */
export interface McpTransportHook {
  onclose?: (() => void) | undefined;
}

/** Minimal server interface required by wireTransportLifecycle. */
export interface McpServerHook {
  close(): Promise<void>;
}

export interface TransportLifecycleOptions {
  readonly transport: McpTransportHook;
  readonly server: McpServerHook;
  readonly client: OpenPetsClient;
  readonly lease: LeaseContext;
  readonly leaseReady: Promise<void>;
  readonly requestedPetId?: string;
  /**
   * Called after teardown when the transport closes. Defaults to `() => process.exit(0)`.
   * Override in tests to prevent the process from actually exiting.
   */
  readonly exit?: () => void;
}

/**
 * Wires heartbeat, retry, and graceful-close logic onto a transport.
 * Exported so tests can invoke the lifecycle without spawning a real process.
 *
 * Returns the `close` function so callers (e.g. SIGINT handlers) can reuse it.
 */
export function wireTransportLifecycle(opts: TransportLifecycleOptions): { close: () => Promise<void> } {
  const { transport, server, client, lease, leaseReady, requestedPetId } = opts;
  const exit = opts.exit ?? (() => process.exit(0));
  let exited = false;
  const exitOnce = (): void => { if (exited) return; exited = true; exit(); };

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryDelayMs = 5_000;
  const MAX_RETRY_DELAY_MS = 60_000;
  let closing = false;
  let closePromise: Promise<void> | null = null;

  function scheduleRetry(): void {
    if (retryTimer || closing) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (closing || lease.lease) return;
      // Fix 2: attempt heartbeat-first recovery when a stale lease is saved
      void (async () => {
        const staleLeaseId = lease.staleLeaseId;
        const staleLease = lease.staleLease;
        if (staleLeaseId && staleLease) {
          try {
            const hb = await client.heartbeatLease(staleLeaseId);
            // Heartbeat succeeded — desktop still holds the original lease
            lease.lease = { ...staleLease, leaseId: hb.leaseId, expiresAt: hb.expiresAt, leaseActive: true };
            lease.staleLeaseId = undefined;
            lease.staleLease = undefined;
            lease.degradedReason = undefined;
            retryDelayMs = 5_000;
            return;
          } catch {
            // Heartbeat failed — fall through to acquireLease
          }
        }
        try {
          const result = await client.acquireLease({ requestedPetId });
          lease.lease = result;
          lease.staleLeaseId = undefined;
          lease.staleLease = undefined;
          lease.degradedReason = undefined;
          retryDelayMs = 5_000;
        } catch (error: unknown) {
          lease.degradedReason = sanitizeMcpRuntimeError(error);
          retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
          scheduleRetry();
        }
      })();
    }, retryDelayMs);
    retryTimer.unref?.();
  }

  leaseReady.then(() => {
    if (closing || !lease.lease) return;
    heartbeatTimer = setInterval(() => {
      if (closing || !lease.lease) return;
      void client.heartbeatLease(lease.lease.leaseId).catch((error: unknown) => {
        // Save full stale lease for heartbeat-first recovery in scheduleRetry / ensureLease
        lease.staleLease = lease.lease;
        lease.staleLeaseId = lease.lease?.leaseId;
        lease.degradedReason = sanitizeMcpRuntimeError(error);
        lease.lease = undefined;
        retryDelayMs = 5_000;
        scheduleRetry();
      });
    }, 5_000);
    heartbeatTimer.unref?.();
  }).catch(() => {});

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      try { await leaseReady; } catch { /* startup already records its degraded state */ }
      const leaseId = lease.lease?.leaseId;
      lease.lease = undefined;
      if (leaseId) {
        try { await client.releaseLease(leaseId); } catch { /* best effort */ }
      }
      try { await server.close(); } catch { /* ignore shutdown errors */ }
    })();
    return closePromise;
  };

  // Fix 3: exit after teardown so the process doesn't linger as an orphan
  transport.onclose = () => { void close().finally(() => exitOnce()); };

  return { close };
}

async function main(): Promise<void> {
  const options = parseMcpArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(createHelpText());
    return;
  }

  if (options.version) {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }

  const lease: LeaseContext = {};
  const context = createToolContext(options.petId);
  const leaseReady = acquireStartupLease(context.client, lease, options.petId);
  const server = createOpenPetsMcpServer({ ...context, lease, leaseReady });
  const transport = new StdioServerTransport();

  const { close } = wireTransportLifecycle({ transport, server, client: context.client, lease, leaseReady, requestedPetId: options.petId });

  process.on("SIGINT", () => { void close().finally(() => process.exit(0)); });
  process.on("SIGTERM", () => { void close().finally(() => process.exit(0)); });

  await server.connect(transport);
}

async function acquireStartupLease(client: ReturnType<typeof createToolContext>["client"], lease: LeaseContext, requestedPetId: string | undefined): Promise<void> {
  try {
    lease.lease = await client.acquireLease({ requestedPetId });
    lease.staleLeaseId = undefined;
    lease.staleLease = undefined;
    lease.degradedReason = undefined;
  } catch (error) {
    lease.lease = undefined;
    lease.staleLeaseId = undefined;
    lease.staleLease = undefined;
    lease.degradedReason = sanitizeMcpRuntimeError(error);
  }
}

function sanitizeMcpRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "OpenPets lease operation failed.";
  if (/\/|\\|\.sock|pipe|token|ipc\.json|ENOENT|ECONNREFUSED|EACCES/i.test(message)) {
    return "OpenPets desktop app or local IPC is unavailable.";
  }
  return message.slice(0, 160);
}

main().catch((error: unknown) => {
  process.stderr.write(`OpenPets MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const packageJson = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Re-export LeaseContext for test consumers that build lifecycle fixtures
export type { LeaseContext, OpenPetsLeaseResult };
