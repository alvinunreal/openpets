import assert from "node:assert/strict";

process.env.OPENPETS_LOG_CONSOLE = "1";
const { error, info, redactLogText } = await import("../src/logger.js");

const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_ABCDE";
assert.equal(token.length, 43, "the fixture must match randomBytes(32).toString('base64url') length");
const endpoint = "tcp://100.64.0.1:4567";
const failure = new Error(`remote request failed at ${endpoint} with ${token}`);
failure.stack = `Error: remote request failed at ${endpoint} with ${token}\n    at remote-control (${endpoint})`;
const emitted: string[] = [];
const originalLog = console.log;
const originalError = console.error;

console.log = (...args: unknown[]) => emitted.push(args.map(String).join(" "));
console.error = (...args: unknown[]) => emitted.push(args.map(String).join(" "));
try {
  info("remote", `paired ${token} at ${endpoint}`, { token, endpoint, nested: { token, endpoint } });
  error("ui", `renderer console reported ${token} at ${endpoint}`, failure, { token, endpoint });
} finally {
  console.log = originalLog;
  console.error = originalError;
  delete process.env.OPENPETS_LOG_CONSOLE;
}

const text = emitted.join("\n");
assert.equal(text.includes(token), false, "remote bearer tokens must not reach console logs");
assert.equal(text.includes(endpoint), false, "remote TCP endpoints must not reach console logs");
assert.equal(redactLogText(`${token} ${endpoint}`), "[redacted-token] [redacted-endpoint]");

console.log("Logger redaction validation passed.");
