/** Executable confinement subscription and lease-authorization regression tests. */
import assert from "node:assert/strict";

import { resolveAndSubscribe, type ConfinementPollerDeps } from "../src/confinement-poller.js";
import type { TerminalWindowInfo } from "../src/window-tracker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInfo(pid = 100): TerminalWindowInfo {
  return { window: null, terminalPid: pid, appName: "iTerm2", isMinimized: false, isOccluded: false };
}

function makeDeps(overrides: Partial<ConfinementPollerDeps> = {}): ConfinementPollerDeps {
  return {
    findTerminal: async () => null,
    subscribe: (_id, _pid, _cb) => () => { /* noop */ },
    setIdentity: () => { /* noop */ },
    applyUpdate: () => { /* noop */ },
    isAlive: () => true,
    onDead: () => { /* noop */ },
    getScreenPermissionStatus: () => "granted",
    notifyScreenPermission: () => { /* noop */ },
    promptScreenPermission: () => { /* noop */ },
    ...overrides,
  };
}

// A newly authorized lease must remain subscribed when its terminal is not
// discoverable yet; otherwise confinement never starts when it appears later.
{
  const subscribeCallIds: string[] = [];
  const subscribed = new Map<string, () => void>();

  const deps = makeDeps({
    findTerminal: async () => null,
    subscribe: (id, _pid, _cb) => {
      subscribeCallIds.push(id);
      return () => { /* noop */ };
    },
  });

  const result = await resolveAndSubscribe("lease-1", 42, deps, subscribed);

  assert.ok(result !== null, "should return an unsubscribe fn when first resolve is null");
  assert.equal(subscribeCallIds.length, 1, "subscribe should be called once");
  assert.equal(subscribeCallIds[0], "lease-1", "subscribe called with correct leaseId");
  assert.ok(subscribed.has("lease-1"), "subscribed map should contain the leaseId");
}

// A lease owns one confinement subscription, preventing duplicate updates.
{
  const subscribeCallCount = { n: 0 };
  const subscribed = new Map<string, () => void>();

  const deps = makeDeps({
    findTerminal: async () => null,
    subscribe: (_id, _pid, _cb) => {
      subscribeCallCount.n++;
      return () => { /* noop */ };
    },
  });

  const r1 = await resolveAndSubscribe("lease-2", 99, deps, subscribed);
  assert.ok(r1 !== null, "first call should return unsubscribe fn");

  const r2 = await resolveAndSubscribe("lease-2", 99, deps, subscribed);
  assert.equal(r2, null, "second call for same leaseId should return null (guard)");
  assert.equal(subscribeCallCount.n, 1, "subscribe should be called only once for same leaseId");
}

// A callback from a no-longer-authorized lease must tear down its subscription
// rather than continuing to confine a pet after the lease expires.
{
  const deadCalled = { n: 0 };
  const unsubCalled = { n: 0 };
  const subscribed = new Map<string, () => void>();

  let capturedCb: ((info: TerminalWindowInfo) => void) | undefined;

  const deps = makeDeps({
    findTerminal: async () => null,
    subscribe: (_id, _pid, cb) => {
      capturedCb = cb;
      return () => { unsubCalled.n++; };
    },
    isAlive: () => false,
    onDead: () => { deadCalled.n++; },
  });

  await resolveAndSubscribe("lease-3", 55, deps, subscribed);

  assert.ok(capturedCb !== undefined, "subscribe callback should have been captured");
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  capturedCb(makeInfo(55));

  assert.equal(deadCalled.n, 1, "onDead should be called when isAlive returns false");
  assert.equal(unsubCalled.n, 1, "unsubscribe fn should be called when isAlive returns false");
  assert.ok(!subscribed.has("lease-3"), "leaseId should be removed from subscribed map");
}

console.log("local IPC confinement subscription tests passed.");
