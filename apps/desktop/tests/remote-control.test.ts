import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { isValidRemotePeerAddress, maxRemoteMessageBytes, normalizeRemoteIpv4Address, openPetsRemoteVersion } from "../src/remote-control-protocol.js";
import { hashRemoteToken, RemoteControlService, validateRemoteControlConfig } from "../src/remote-control-service.js";

const root = mkdtempSync(join(tmpdir(), "openpets-remote-control-"));
const statePath = join(root, "remote-state.json");
let reactionCount = 0;
let sayCount = 0;
let defaultPetAway = false;
const logs: string[] = [];

const service = new RemoteControlService({
  statePath,
  getStatusSnapshot: () => ({
    ok: true,
    appRunning: true,
    protocolVersion: 1,
    defaultPet: { id: "builtin", builtIn: true, broken: false },
    paused: false,
    defaultPetVisible: true,
    openDefaultPetOnLaunch: true,
    speechBubblesEnabled: true,
  }),
  applyReaction: () => {
    reactionCount += 1;
    return { shown: true };
  },
  applySay: () => {
    sayCount += 1;
    return { shown: true };
  },
  isDefaultPetAway: () => defaultPetAway,
  log: (message) => logs.push(message),
});

assert.equal(service.getConfiguration().enabled, false, "remote control must be disabled by default");
for (const invalid of [
  { enabled: true, address: "0.0.0.0", port: 1234 },
  { enabled: true, address: "8.8.8.8", port: 1234 },
  { enabled: true, address: "localhost", port: 1234 },
  { enabled: true, address: "127.0.0.1", port: 0 },
  { enabled: true, address: "010.0.0.1", port: 1234 },
  { enabled: true, address: "100.128.0.1", port: 1234 },
  { enabled: true, address: "100.63.255.255", port: 1234 },
]) {
  assert.throws(() => validateRemoteControlConfig(invalid), "unsafe binding configuration must be rejected");
}
assert.deepEqual(validateRemoteControlConfig({ enabled: true, address: "100.64.0.1", port: 1234 }), { enabled: true, address: "100.64.0.1", port: 1234 });
assert.equal(normalizeRemoteIpv4Address("::ffff:127.0.0.1"), "127.0.0.1");
assert.equal(normalizeRemoteIpv4Address("010.0.0.1"), null);
assert.equal(isValidRemotePeerAddress("::ffff:127.0.0.1"), true);
assert.equal(isValidRemotePeerAddress("100.128.0.1"), false);

const pair = service.pairClient({ name: "Review agent", scopes: ["status", "react", "say"] });
const persistedBeforeRequests = readFileSync(statePath, "utf8");
assert.equal(persistedBeforeRequests.includes(pair.token), false, "plaintext pairing token must not be persisted");
assert.match(persistedBeforeRequests, new RegExp(hashRemoteToken(pair.token)));
assert.deepEqual(service.listClients()[0]?.scopes, ["status", "react", "say"]);
const reactClient = service.pairClient({ name: "React agent", scopes: ["status", "react"] });
for (const scopes of [
  [],
  ["status"],
  ["react"],
  ["say"],
  ["react", "status"],
  ["status", "say"],
  ["status", "react", "status"],
  ["status", "react", "unknown"],
]) {
  assert.throws(() => service.pairClient({ name: "Invalid scopes", scopes: scopes as never[] }), "pairing must reject non-canonical scope policies");
}

const port = await getFreePort();
await service.configure({ enabled: true, address: "127.0.0.1", port });
assert.equal(service.getConfiguration().listening, true);

const status = await send(port, request(pair, "status", {}));
assert.equal(status.ok, true);
if (status.ok) {
  assert.deepEqual(Object.keys(status.result as object).sort(), ["appRunning", "defaultPet", "defaultPetVisible", "ok", "openDefaultPetOnLaunch", "paused", "protocolVersion", "speechBubblesEnabled"].sort());
  assert.equal((status.result as { defaultPet: { id: string } }).defaultPet.id, "builtin");
  assert.equal(JSON.stringify(status.result).includes("/"), false, "remote status must not contain paths or prompt text");
}

const reaction = await send(port, request(pair, "pet.react", { reaction: "working" }));
assert.equal(reaction.ok, true);
assert.equal(reactionCount, 1, "an authorized remote reaction should reach only the injected default-pet handler");

const say = await send(port, request(pair, "pet.say", { message: "Build finished", reaction: "success" }));
assert.equal(say.ok, true);
assert.equal(sayCount, 1);

const withoutSay = await send(port, request(reactClient, "pet.say", { message: "No say scope", reaction: "success" }));
assert.equal(withoutSay.ok, false);
assert.equal(withoutSay.error?.code, "forbidden");
assert.equal(sayCount, 1, "a client without say scope may not request a speech side effect");

defaultPetAway = true;
const awayReaction = await send(port, request(pair, "pet.react", { reaction: "working" }));
const awaySay = await send(port, request(pair, "pet.say", { message: "While away" }));
assert.equal(awayReaction.ok, true);
assert.equal(awaySay.ok, true);
assert.equal((awayReaction.result as { shown: boolean }).shown, false);
assert.equal((awaySay.result as { shown: boolean }).shown, false);
assert.equal(reactionCount, 1, "remote actions must not wake an away default pet");
assert.equal(sayCount, 1, "remote actions must not create an away speech bubble");
defaultPetAway = false;

const arbitraryTarget = await send(port, request(pair, "pet.react", { reaction: "success", petId: "other-pet" }));
assert.equal(arbitraryTarget.ok, false);
assert.equal(arbitraryTarget.error?.code, "invalid_params");
assert.equal(reactionCount, 1, "arbitrary pet targets must not reach the default-pet adapter");
const unsafeMessage = await send(port, request(pair, "pet.say", { message: "https://example.invalid/output" }));
assert.equal(unsafeMessage.ok, false);
assert.equal(unsafeMessage.error?.code, "invalid_params");
assert.equal(sayCount, 1);
const unsupportedMethod = await send(port, request(pair, "lease.acquire", {}));
assert.equal(unsupportedMethod.ok, false);
assert.equal(unsupportedMethod.error?.code, "unknown_method");

const invalidToken = await send(port, request({ clientId: pair.clientId, token: "a".repeat(43) }, "pet.react", { reaction: "success" }));
assert.equal(invalidToken.ok, false);
assert.equal(invalidToken.error?.code, "unauthorized");
assert.equal(invalidToken.error?.message, "Remote request rejected.");
assert.equal(reactionCount, 1);

const malformed = await send(port, "not-json\n");
assert.equal(malformed.ok, false);
assert.equal(malformed.id, null);
assert.equal(malformed.error?.message, "Remote request rejected.");

const oversized = await send(port, `${"x".repeat(maxRemoteMessageBytes)}\n`);
assert.equal(oversized.ok, false);
assert.equal(oversized.error?.code, "invalid_request");
assert.equal(oversized.error?.message.includes(pair.token), false);
assert.equal(reactionCount, 1);

const rotated = service.rotateClient(pair.clientId);
assert.notEqual(rotated.token, pair.token);
assert.equal(readFileSync(statePath, "utf8").includes(rotated.token), false);
const oldToken = await send(port, request(pair, "status", {}));
assert.equal(oldToken.ok, false);
const newToken = await send(port, request({ clientId: rotated.clientId, token: rotated.token }, "status", {}));
assert.equal(newToken.ok, true);
assert.deepEqual(service.revokeClient(rotated.clientId), { revoked: true });
const revoked = await send(port, request({ clientId: rotated.clientId, token: rotated.token }, "pet.react", { reaction: "success" }));
assert.equal(revoked.ok, false);
assert.equal(revoked.error?.code, "unauthorized");
assert.equal(reactionCount, 1, "revocation must take effect immediately");

const restartedPort = await getFreePort();
await service.configure({ enabled: true, address: "127.0.0.1", port: restartedPort });
await service.stop();
assert.equal(service.getConfiguration().listening, false, "stopping remote control must close its listener");
const restartedService = new RemoteControlService({
  statePath,
  getStatusSnapshot: serviceOptionsStatus,
  applyReaction: () => ({ shown: true }),
  applySay: () => ({ shown: true }),
});
await restartedService.start();
assert.equal(restartedService.getConfiguration().listening, true, "an enabled persisted configuration should restart safely");
const revokedAfterRestart = await send(restartedPort, request({ clientId: rotated.clientId, token: rotated.token }, "status", {}));
assert.equal(revokedAfterRestart.ok, false, "revocation must survive a listener restart");
await restartedService.configure({ enabled: false });
assert.equal(restartedService.getConfiguration().listening, false, "disabling remote control must close its listener");
await restartedService.stop();

const resourceService = new RemoteControlService({
  statePath: join(root, "resource-state.json"),
  connectionDeadlineMs: 100,
  maxConcurrentSockets: 1,
  getStatusSnapshot: serviceOptionsStatus,
  applyReaction: () => ({ shown: true }),
  applySay: () => ({ shown: true }),
});
const resourcePort = await getFreePort();
await resourceService.configure({ enabled: true, address: "127.0.0.1", port: resourcePort });
const slowSocket = net.createConnection({ host: "127.0.0.1", port: resourcePort });
await onceEvent(slowSocket, "connect");
slowSocket.write("{");
const cappedSocket = net.createConnection({ host: "127.0.0.1", port: resourcePort });
await onceEvent(cappedSocket, "close");
await onceEvent(slowSocket, "close");

const halfOpenPair = resourceService.pairClient({ name: "Half-open test", scopes: ["status", "react"] });
const halfOpen = await sendHalfOpen(resourcePort, request(halfOpenPair, "status", {}));
assert.equal(halfOpen.response.ok, true, "a half-open peer must receive a complete response before reclamation");
await delay(150);
const admittedAfterReclaim = await send(resourcePort, request(halfOpenPair, "status", {}));
assert.equal(admittedAfterReclaim.ok, true, "the socket cap must admit a subsequent connection after reclaiming a half-open response socket");
halfOpen.socket.destroy();
await resourceService.stop();

const rateStatePath = join(root, "rate-state.json");
const rateService = new RemoteControlService({
  statePath: rateStatePath,
  rateLimitMaxRequests: 2,
  rateLimitWindowMs: 60_000,
  getStatusSnapshot: () => ({
    ok: true,
    appRunning: true,
    protocolVersion: 1,
    defaultPet: { id: "builtin", builtIn: true, broken: false },
    paused: false,
    defaultPetVisible: false,
    openDefaultPetOnLaunch: true,
    speechBubblesEnabled: true,
  }),
  applyReaction: () => ({ shown: true }),
  applySay: () => ({ shown: true }),
});
const ratePair = rateService.pairClient({ name: "Rate test", scopes: ["status", "react"] });
const ratePort = await getFreePort();
await rateService.configure({ enabled: true, address: "127.0.0.1", port: ratePort });
assert.equal((await send(ratePort, request(ratePair, "status", {}))).ok, true);
assert.equal((await send(ratePort, request(ratePair, "status", {}))).ok, true);
const limited = await send(ratePort, request(ratePair, "status", {}));
assert.equal(limited.ok, false);
assert.equal(limited.error?.code, "rate_limited");
await rateService.stop();

assert.equal(logs.some((message) => message.includes(String(port)) || message.includes(pair.token)), false, "remote listener logs must not contain endpoint or credentials");
rmSync(root, { recursive: true, force: true });
console.log("remote control behavior tests passed.");

function request(credentials: { readonly clientId?: string; readonly token: string }, method: string, params: unknown): string {
  return `${JSON.stringify({ id: "test-request", protocol: "openpets-remote", version: openPetsRemoteVersion, clientId: credentials.clientId, token: credentials.token, method, params })}\n`;
}

function serviceOptionsStatus() {
  return {
    ok: true as const,
    appRunning: true as const,
    protocolVersion: 1 as const,
    defaultPet: { id: "builtin", builtIn: true, broken: false },
    paused: false,
    defaultPetVisible: true,
    openDefaultPetOnLaunch: true,
    speechBubblesEnabled: true,
  };
}

function send(port: number, payload: string): Promise<{ readonly id: string | null; readonly ok: boolean; readonly result?: unknown; readonly error?: { readonly code: string; readonly message: string } }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as { id: string | null; ok: boolean; result?: unknown; error?: { code: string; message: string } });
    });
    socket.once("close", () => reject(new Error("socket closed before response")));
    socket.once("error", reject);
  });
}

function sendHalfOpen(port: number, payload: string): Promise<{ readonly response: { readonly id: string | null; readonly ok: boolean; readonly result?: unknown; readonly error?: { readonly code: string; readonly message: string } }; readonly socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
    let buffer = "";
    let settled = false;
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0 || settled) return;
      settled = true;
      resolve({ response: JSON.parse(buffer.slice(0, newline)) as { id: string | null; ok: boolean; result?: unknown; error?: { code: string; message: string } }, socket });
    });
    socket.once("close", () => {
      if (!settled) reject(new Error("half-open socket closed before response"));
    });
    socket.once("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a test port."));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function onceEvent(socket: net.Socket, event: "connect" | "close"): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once(event, () => resolve());
    socket.once("error", reject);
  });
}
