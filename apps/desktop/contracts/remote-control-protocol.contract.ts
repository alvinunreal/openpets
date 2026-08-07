import assert from "node:assert/strict";

import {
  maxRemoteMessageBytes,
  isValidRemotePeerAddress,
  isValidRemoteBindAddress,
  normalizeRemoteIpv4Address,
  parseRemoteControlRequest,
  validateRemoteScopeList,
  validateRemoteReactParams,
  validateRemoteSayParams,
} from "../src/remote-control-protocol.js";
import { validateRemoteControlConfig } from "../src/remote-control-service.js";

const token = "x".repeat(43);
const valid = {
  id: "request-1",
  protocol: "openpets-remote",
  version: 1,
  clientId: "client-1",
  token,
  method: "pet.react",
  params: { reaction: "working" },
};

assert.deepEqual(parseRemoteControlRequest(JSON.stringify(valid)), valid);
assert.throws(() => parseRemoteControlRequest("not-json"));
assert.throws(() => parseRemoteControlRequest(JSON.stringify({ ...valid, method: "lease.acquire" })));
assert.throws(() => parseRemoteControlRequest(JSON.stringify({ ...valid, version: 2 })));
assert.throws(() => parseRemoteControlRequest(JSON.stringify({ ...valid, token: "short" })));
assert.throws(() => validateRemoteReactParams({ reaction: "working", petId: "other" }));
assert.throws(() => validateRemoteSayParams({ message: "https://example.invalid" }));
assert.equal(validateRemoteSayParams({ message: "short safe message" }).message, "short safe message");
assert.ok(Buffer.byteLength(JSON.stringify({ message: "x".repeat(maxRemoteMessageBytes) }), "utf8") > maxRemoteMessageBytes);
assert.deepEqual(validateRemoteScopeList(["status", "react"]), ["status", "react"]);
assert.deepEqual(validateRemoteScopeList(["status", "react", "say"]), ["status", "react", "say"]);
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
  assert.throws(() => validateRemoteScopeList(scopes), "remote pairing scopes must be exactly canonical status/react with optional say");
}

for (const unsafe of [
  { enabled: true, address: "0.0.0.0", port: 1234 },
  { enabled: true, address: "192.0.2.1", port: 1234 },
  { enabled: true, address: "localhost", port: 1234 },
  { enabled: true, address: "127.0.0.1", port: 0 },
  { enabled: true, address: "010.0.0.1", port: 1234 },
  { enabled: true, address: "100.63.255.255", port: 1234 },
  { enabled: true, address: "100.128.0.1", port: 1234 },
]) {
  assert.throws(() => validateRemoteControlConfig(unsafe));
}
assert.equal(isValidRemoteBindAddress("010.0.0.1"), false);
assert.equal(isValidRemoteBindAddress("100.64.0.1"), true);
assert.equal(isValidRemoteBindAddress("100.128.0.1"), false);
assert.equal(normalizeRemoteIpv4Address("::ffff:192.168.1.2"), "192.168.1.2");
assert.equal(normalizeRemoteIpv4Address("::1"), null);
assert.equal(isValidRemotePeerAddress("::ffff:100.64.0.1"), true);
assert.equal(isValidRemotePeerAddress("::ffff:8.8.8.8"), false);
assert.deepEqual(validateRemoteControlConfig({ enabled: false }), { enabled: false, address: null, port: null });

console.log("Remote control protocol validation passed.");
