import assert from "node:assert/strict";
import net from "node:net";

import { parseIpcEndpoint, validateDiscovery } from "../src/discovery.js";
import { createOpenPetsClient, parsePetInstallResult, parsePetListResult } from "../src/index.js";
import { OpenPetsClientError, parseIpcResponse, validateReaction } from "../src/protocol.js";
import { maxRemoteMessageBytes, parseRemoteEndpoint, validateRemoteMessage, validateRemoteToken } from "../src/remote-protocol.js";

const baseDiscovery = {
  protocolVersion: 1,
  protocol: "openpets-ipc",
  endpoint: process.platform === "win32" ? "\\\\.\\pipe\\openpets-abc-123" : "/tmp/openpets-501/openpets-123.sock",
  token: "x".repeat(32),
  appVersion: "0.0.0",
  pid: 123,
  platform: process.platform,
};

validateDiscovery(baseDiscovery);
validateDiscovery({ ...baseDiscovery, endpoint: "tcp://127.0.0.1:37645" });
assert.deepEqual(parseIpcEndpoint("tcp://127.0.0.1:37645"), { kind: "tcp", host: "127.0.0.1", port: 37645 });

// Test private/local IPv4 addresses for WSL NAT mode
assert.deepEqual(parseIpcEndpoint("tcp://10.0.0.1:37645"), { kind: "tcp", host: "10.0.0.1", port: 37645 });
assert.deepEqual(parseIpcEndpoint("tcp://172.16.0.1:37645"), { kind: "tcp", host: "172.16.0.1", port: 37645 });
assert.deepEqual(parseIpcEndpoint("tcp://172.31.255.255:37645"), { kind: "tcp", host: "172.31.255.255", port: 37645 });
assert.deepEqual(parseIpcEndpoint("tcp://192.168.1.1:37645"), { kind: "tcp", host: "192.168.1.1", port: 37645 });
assert.deepEqual(parseIpcEndpoint("tcp://169.254.1.1:37645"), { kind: "tcp", host: "169.254.1.1", port: 37645 });

// Test cross-platform discovery with private IPs (Windows desktop -> WSL client)
if (process.platform === "linux") {
  validateDiscovery({ ...baseDiscovery, endpoint: "tcp://192.168.1.100:37645", platform: "win32" });
  validateDiscovery({ ...baseDiscovery, endpoint: "tcp://172.25.32.1:37645", platform: "win32" });
}

assertRejects(() => validateDiscovery({ ...baseDiscovery, protocol: "http" }));
assertRejects(() => validateDiscovery({ ...baseDiscovery, protocolVersion: 2 }));
assertRejects(() => validateDiscovery({ ...baseDiscovery, endpoint: "127.0.0.1:1234" }));
assertRejects(() => validateDiscovery({ ...baseDiscovery, endpoint: "tcp://localhost:37645" }));
assertRejects(() => validateDiscovery({ ...baseDiscovery, endpoint: "tcp://0.0.0.0:37645" }));
assertRejects(() => validateDiscovery({ ...baseDiscovery, endpoint: "tcp://127.0.0.1:0" }));
assertRejects(() => validateDiscovery({ ...baseDiscovery, endpoint: "tcp://127.0.0.1:37645/path" }));
assertRejects(() => validateDiscovery({ ...baseDiscovery, endpoint: "tcp://user:pass@127.0.0.1:37645" }));
assertRejects(() => validateDiscovery({ ...baseDiscovery, platform: "freebsd" }));

// Reject public IPs
assertRejects(() => validateDiscovery({ ...baseDiscovery, endpoint: "tcp://8.8.8.8:37645" }));
assertRejects(() => validateDiscovery({ ...baseDiscovery, endpoint: "tcp://1.2.3.4:37645" }));
assertRejects(() => validateDiscovery({ ...baseDiscovery, endpoint: "tcp://172.15.0.1:37645" })); // Just outside private range
assertRejects(() => validateDiscovery({ ...baseDiscovery, endpoint: "tcp://172.32.0.1:37645" })); // Just outside private range
assertRejects(() => validateDiscovery({ ...baseDiscovery, endpoint: "tcp://11.0.0.1:37645" })); // Not in 10.0.0.0/8

if (process.platform === "linux") {
  validateDiscovery({ ...baseDiscovery, endpoint: "tcp://127.0.0.1:37645", platform: "win32" });
  assertRejects(() => validateDiscovery({ ...baseDiscovery, platform: "win32" }));
}
assertRejects(() => validateReaction("bad"));
assert.equal(validateReaction("waving"), "waving");

const ok = parseIpcResponse<{ value: number }>({ id: "1", ok: true, result: { value: 1 } });
if (!ok.ok || ok.result.value !== 1) throw new Error("Failed to parse ok response.");

const err = parseIpcResponse({ id: "1", ok: false, error: { code: "invalid_token", message: "Invalid" } });
if (err.ok || err.error.code !== "invalid_token") throw new Error("Failed to parse error response.");

assertRejects(() => parseIpcResponse({ ok: true }));
assert.deepEqual(parsePetListResult({ ok: true, defaultPetId: "builtin", pets: [{ id: "fixer", displayName: "Fixer", builtIn: false, broken: false }] }), { ok: true, defaultPetId: "builtin", pets: [{ id: "fixer", displayName: "Fixer", builtIn: false, broken: false }] });
assertRejects(() => parsePetListResult({ ok: true, pets: [{ id: "fixer" }], defaultPetId: "builtin" }));
assert.deepEqual(parsePetInstallResult({ ok: true, petId: "fixer", displayName: "Fixer", installed: true }), { ok: true, petId: "fixer", displayName: "Fixer", installed: true });
assertRejects(() => parsePetInstallResult({ ok: true, petId: "fixer" }));

console.log("Client protocol validation passed.");

assert.deepEqual(parseRemoteEndpoint("tcp://127.0.0.1:37645"), { kind: "tcp", host: "127.0.0.1", port: 37645 });
assert.deepEqual(parseRemoteEndpoint("tcp://127.0.0.1:37645/"), { kind: "tcp", host: "127.0.0.1", port: 37645 });
assert.deepEqual(parseRemoteEndpoint("tcp://100.64.0.1:37645"), { kind: "tcp", host: "100.64.0.1", port: 37645 });
for (const endpoint of ["tcp://0.0.0.0:37645", "tcp://010.0.0.1:37645", "tcp://100.63.255.255:37645", "tcp://100.128.0.1:37645", "tcp://8.8.8.8:37645", "tcp://localhost:37645", "tcp://127.0.0.1:0", "tcp://127.0.0.1:37645/path"]) {
  assertRejects(() => parseRemoteEndpoint(endpoint));
}
assertRejects(() => validateRemoteToken("short"));
validateRemoteToken("x".repeat(43));
validateRemoteMessage("Remote build finished");
assertRejects(() => validateRemoteMessage("/home/user/private.txt"));

const remoteServer = net.createServer((socket) => {
  socket.setEncoding("utf8");
  socket.once("data", (chunk: string) => {
    const request = JSON.parse(chunk.slice(0, chunk.indexOf("\n"))) as { readonly id: string; readonly protocol: string; readonly method: string };
    assert.equal(request.protocol, "openpets-remote");
    assert.equal(request.method, "status", "remote client must use the separate remote status method");
    socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { ok: true, appRunning: true } })}\n`);
  });
});
await new Promise<void>((resolve, reject) => {
  remoteServer.once("error", reject);
  remoteServer.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
});
const remoteAddress = remoteServer.address();
if (!remoteAddress || typeof remoteAddress === "string") throw new Error("Remote test server did not bind.");
const previousDiscovery = process.env.OPENPETS_DISCOVERY_FILE;
process.env.OPENPETS_DISCOVERY_FILE = "/path-that-must-not-be-read/openpets-ipc.json";
try {
  const remoteClient = createOpenPetsClient({ remote: { endpoint: `tcp://127.0.0.1:${remoteAddress.port}`, token: "x".repeat(43) } });
  assert.equal(remoteClient.transport, "remote");
  assert.deepEqual(await remoteClient.status(), { ok: true, appRunning: true });
  await assert.rejects(remoteClient.listPets(), (error: unknown) => error instanceof OpenPetsClientError && error.code === "remote_method_not_supported");
} finally {
  if (previousDiscovery === undefined) delete process.env.OPENPETS_DISCOVERY_FILE;
  else process.env.OPENPETS_DISCOVERY_FILE = previousDiscovery;
  await new Promise<void>((resolve) => remoteServer.close(() => resolve()));
}
console.log("Remote client protocol validation passed.");

await withRemoteServer("success", async (endpoint) => {
  const client = createOpenPetsClient({ remote: { endpoint, token: "x".repeat(43) } });
  assert.deepEqual(await client.react("working"), { shown: true });
  assert.deepEqual(await client.say("Remote message"), { shown: true });
});

await withRemoteServer("forbidden", async (endpoint) => {
  const client = createOpenPetsClient({ remote: { endpoint, token: "x".repeat(43) } });
  await assert.rejects(client.react("working"), (error: unknown) => error instanceof OpenPetsClientError && error.code === "forbidden");
});

const previousRemoteEnvironment = {
  endpoint: process.env.OPENPETS_REMOTE_ENDPOINT,
  token: process.env.OPENPETS_REMOTE_TOKEN,
  clientId: process.env.OPENPETS_REMOTE_CLIENT_ID,
  discovery: process.env.OPENPETS_DISCOVERY_FILE,
};
await withRemoteServer("success", async (endpoint) => {
  process.env.OPENPETS_REMOTE_ENDPOINT = endpoint;
  process.env.OPENPETS_REMOTE_TOKEN = "x".repeat(43);
  delete process.env.OPENPETS_REMOTE_CLIENT_ID;
  process.env.OPENPETS_DISCOVERY_FILE = "/path-that-must-not-be-read/openpets-ipc.json";
  assert.deepEqual(await createOpenPetsClient().say("Environment selected"), { shown: true });
});
restoreEnvironment("OPENPETS_REMOTE_ENDPOINT", previousRemoteEnvironment.endpoint);
restoreEnvironment("OPENPETS_REMOTE_TOKEN", previousRemoteEnvironment.token);
restoreEnvironment("OPENPETS_REMOTE_CLIENT_ID", previousRemoteEnvironment.clientId);
restoreEnvironment("OPENPETS_DISCOVERY_FILE", previousRemoteEnvironment.discovery);

await withRemoteServer("timeout", async (endpoint) => {
  const client = createOpenPetsClient({ remote: { endpoint, token: "x".repeat(43) }, responseTimeoutMs: 50 });
  await assert.rejects(client.react("working"), (error: unknown) => error instanceof OpenPetsClientError && error.code === "response_timeout");
});

await withRemoteServer("oversize", async (endpoint) => {
  const client = createOpenPetsClient({ remote: { endpoint, token: "x".repeat(43) } });
  await assert.rejects(client.react("working"), (error: unknown) => error instanceof OpenPetsClientError && error.code === "response_too_large");
});
console.log("Remote client operation validation passed.");

type RemoteFixtureMode = "success" | "forbidden" | "timeout" | "oversize";

async function withRemoteServer(mode: RemoteFixtureMode, run: (endpoint: string) => Promise<void>): Promise<void> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.once("data", (chunk: string) => {
      const request = JSON.parse(chunk.slice(0, chunk.indexOf("\n"))) as { readonly id: string };
      if (mode === "timeout") return;
      const response = mode === "forbidden"
        ? { id: request.id, ok: false, error: { code: "forbidden", message: "Remote request rejected." } }
        : mode === "oversize"
          ? { id: request.id, ok: true, result: "x".repeat(maxRemoteMessageBytes) }
          : { id: request.id, ok: true, result: { shown: true } };
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Remote fixture server did not bind.");
  try {
    await run(`tcp://127.0.0.1:${address.port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function assertRejects(callback: () => unknown): void {
  try {
    callback();
  } catch (error) {
    if (error instanceof OpenPetsClientError || error instanceof Error) return;
  }
  throw new Error("Expected validation to reject.");
}
