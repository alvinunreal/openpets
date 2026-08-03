import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

import { createLanRequestHandler } from "../src/lan-http-controller.js";
import { LanCoordinator, type LanState } from "../src/lan-state.js";

const token = "test-shared-secret";
let now = 1_000;
const coordinator = new LanCoordinator({ staleClientMs: 10_000 });
const changedHosts: Array<string | null> = [];
const server = createServer(createLanRequestHandler(coordinator, token, {
  now: () => now,
  onStateChange: (state) => changedHosts.push(state.currentHost),
}));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as AddressInfo).port;

try {
  const unauthorizedStatus = await requestJson("GET", "/status");
  assert.equal(unauthorizedStatus.status, 401, "status should require the LAN token when configured");

  const authorizedStatus = await requestJson<LanState>("GET", "/status", undefined, token);
  assert.equal(authorizedStatus.status, 200);
  assert.equal(authorizedStatus.headers["access-control-allow-origin"], undefined, "LAN responses should not expose coordinator state with wildcard CORS");

  const invalidTokenRegister = await requestJson("POST", "/register", { host: "alpha", position: { x: 10, y: 20 } }, "wrong-token");
  assert.equal(invalidTokenRegister.status, 401, "register should reject an invalid LAN token");

  const alphaRegister = await requestJson<LanState>("POST", "/register", { host: "alpha", position: { x: 10, y: 20 } }, token);
  assert.equal(alphaRegister.status, 200);
  assert.equal(alphaRegister.body.currentHost, "alpha", "first registered client should own the pet");
  const alphaSession = String(alphaRegister.headers["x-openpets-lan-session"]);
  assert.ok(alphaSession, "registration should issue a host-bound session credential");

  now += 100;
  const betaRegister = await requestJson<LanState>("POST", "/register", { host: "beta", position: { x: 400, y: 20 } }, token);
  assert.equal(betaRegister.status, 200);
  const betaSession = String(betaRegister.headers["x-openpets-lan-session"]);
  assert.ok(betaSession && betaSession !== alphaSession, "each host should receive a distinct session credential");
  assert.equal(betaRegister.body.currentHost, "alpha", "second register should not steal current ownership");
  assert.deepEqual(betaRegister.body.clients.map((client) => client.host), ["alpha", "beta"]);
  const spoofedActiveRegistration = await requestJson("POST", "/register", { host: "alpha", position: { x: 20, y: 20 } }, token, betaSession);
  assert.equal(spoofedActiveRegistration.status, 403, "another authenticated peer must not replace an active host identity");

  const alphaPetRegister = await requestJson<LanState>("POST", "/register", { host: "alpha", petId: "cat", position: { x: 10, y: 20 } }, token, alphaSession);
  const betaPetRegister = await requestJson<LanState>("POST", "/register", { host: "beta", petId: "cat", position: { x: 400, y: 20 } }, token, betaSession);
  assert.deepEqual(betaPetRegister.body.pets?.map((pet) => [pet.ownerHost, pet.petId, pet.currentHost]), [
    ["alpha", "cat", "alpha"],
    ["beta", "cat", "beta"],
  ], "HTTP registration should preserve separate owners even when both choose the same pet ID");
  const armBetaPet = await requestJson<LanState>("POST", "/position", { host: "beta", ownerHost: "beta", position: { x: 200, y: 20 }, edge: null }, token, betaSession);
  assert.equal(armBetaPet.status, 200);
  const moveBetaPet = await requestJson<LanState>("POST", "/position", { host: "beta", ownerHost: "beta", position: { x: 5, y: 20 }, edge: "left" }, token, betaSession);
  assert.deepEqual(moveBetaPet.body.pets?.map((pet) => [pet.ownerHost, pet.currentHost]), [
    ["alpha", "alpha"],
    ["beta", "alpha"],
  ], "HTTP position updates should allow two pets to meet on one host");
  const spoofedActivity = await requestJson("POST", "/activity", { ownerHost: "beta", kind: "work" }, token, alphaSession);
  assert.equal(spoofedActivity.status, 403, "an authenticated peer must not publish activity for another owner");
  const workActivity = await requestJson<LanState>("POST", "/activity", { ownerHost: "beta", kind: "work" }, token, betaSession);
  assert.equal(workActivity.status, 200);
  assert.deepEqual(workActivity.body.pets?.find((pet) => pet.ownerHost === "beta")?.activity, { kind: "work", sequence: now, createdAt: now }, "HTTP activity should expose only the coarse authenticated work signal");
  const messageBearingActivity = await requestJson("POST", "/activity", { ownerHost: "beta", kind: "work", message: "private MCP text" }, token, betaSession);
  assert.equal(messageBearingActivity.status, 400, "LAN activity must reject message-bearing payloads");
  const spoofedReturn = await requestJson("POST", "/return", { host: "alpha", ownerHost: "beta" }, token, betaSession);
  assert.equal(spoofedReturn.status, 403, "an authenticated peer must not return a visitor on behalf of its meeting host");
  const returnBetaPet = await requestJson<LanState>("POST", "/return", { host: "alpha", ownerHost: "beta" }, token, alphaSession);
  assert.equal(returnBetaPet.status, 200);
  assert.equal(returnBetaPet.body.pets?.find((pet) => pet.ownerHost === "beta")?.currentHost, "beta", "the meeting host should be able to return a visitor after its dash animation");
  const repeatedReturn = await requestJson("POST", "/return", { host: "alpha", ownerHost: "beta" }, token, alphaSession);
  assert.equal(repeatedReturn.status, 400, "a host must not return a pet it no longer holds");
  const activityAtHome = await requestJson("POST", "/activity", { ownerHost: "beta", kind: "work" }, token, betaSession);
  assert.equal(activityAtHome.status, 400, "the coordinator must reject activity when the pet is not visiting a meeting");

  now += 100;
  const moveAway = await requestJson<LanState>("POST", "/position", { host: "alpha", position: { x: 200, y: 20 }, edge: null }, token, alphaSession);
  assert.equal(moveAway.body.currentHost, "alpha", "moving away from the edge arms handoff without migrating");

  now += 100;
  const edgeHandoff = await requestJson<LanState>("POST", "/position", { host: "alpha", position: { x: 999, y: 20 }, edge: "right" }, token, alphaSession);
  assert.equal(edgeHandoff.body.currentHost, "beta", "right edge should migrate ownership through the HTTP controller");

  const claimAlpha = await requestJson<LanState>("POST", "/claim", { host: "alpha" }, token, alphaSession);
  assert.equal(claimAlpha.status, 200);
  assert.equal(claimAlpha.body.currentHost, "alpha", "claim should move ownership to a connected client");

  const missingClaim = await requestJson("POST", "/claim", { host: "missing" }, token, alphaSession);
  assert.equal(missingClaim.status, 403, "claim should reject identities without a matching host session");

  const missingHostRegister = await requestJson("POST", "/register", {}, token);
  assert.equal(missingHostRegister.status, 400, "register should reject requests without a host");
  const invalidPetRegister = await requestJson("POST", "/register", { host: "alpha", petId: "../cat" }, token, alphaSession);
  assert.equal(invalidPetRegister.status, 400, "register should reject unsafe pet IDs instead of silently downgrading to legacy state");

  now += 11_000;
  const staleOwnerPrune = await requestJson<LanState>("POST", "/position", { host: "beta", position: { x: 420, y: 20 }, edge: null }, token, betaSession);
  assert.equal(staleOwnerPrune.body.currentHost, "beta", "a live client should become owner when the previous owner is pruned as stale");
  const reclaimedAlpha = await requestJson<LanState>("POST", "/register", { host: "alpha", position: { x: 20, y: 20 } }, token);
  assert.equal(reclaimedAlpha.status, 200, "a restarted client should reclaim its identity after the previous session becomes stale");
  assert.notEqual(reclaimedAlpha.headers["x-openpets-lan-session"], alphaSession, "stale identity reclamation should rotate the host session");

  const largeBody = await requestRaw("POST", "/register", "{" + `"padding":"${"x".repeat(17 * 1024)}"` + "}", token);
  assert.equal(largeBody.status, 413, "oversized LAN request bodies should be rejected");

  assert.deepEqual(changedHosts, ["alpha", "beta", "alpha", "beta", "alpha"], "successful mutating requests should emit persisted owner snapshots when ownership changes, including stale-owner pruning and identity reclamation");
} finally {
  server.close();
  await once(server, "close");
}

function requestRaw(method: string, path: string, payload: string, requestToken?: string): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    };
    if (requestToken) headers["x-openpets-lan-token"] = requestToken;

    const req = request({ method, hostname: "127.0.0.1", port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

console.log("LAN controller HTTP validation passed.");

type JsonResponse<T = unknown> = {
  readonly status: number;
  readonly body: T;
  readonly headers: Record<string, string | string[] | undefined>;
};

function requestJson<T = unknown>(method: string, path: string, body?: unknown, requestToken?: string, sessionToken?: string): Promise<JsonResponse<T>> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {};
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = payload.length;
    }
    if (requestToken) headers["x-openpets-lan-token"] = requestToken;
    if (sessionToken) headers["x-openpets-lan-session"] = sessionToken;

    const req = request({ method, hostname: "127.0.0.1", port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) as T : undefined as T, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}
