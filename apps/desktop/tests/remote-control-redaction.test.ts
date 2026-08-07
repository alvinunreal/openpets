import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RemoteControlService, hashRemoteToken } from "../src/remote-control-service.js";

const root = mkdtempSync(join(tmpdir(), "openpets-remote-redaction-"));
const statePath = join(root, "remote-state.json");

try {
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
    applyReaction: () => ({ shown: true }),
    applySay: () => ({ shown: true }),
  });

  // 1. Initial snapshot check
  const config = service.getConfiguration();
  assert.equal(config.enabled, false, "service must default to disabled");
  assert.equal("tokenVerifier" in (config as unknown as Record<string, unknown>), false, "config snapshot must not leak token verifiers");
  assert.equal("statePath" in (config as unknown as Record<string, unknown>), false, "config snapshot must not leak state file path");

  // 2. Pairing returns token ONCE
  const pairing = service.pairClient({ name: "CLI Test Agent", scopes: ["status", "react"] });
  assert.ok(pairing.clientId, "clientId must be generated");
  assert.ok(pairing.token && pairing.token.length >= 32, "plaintext token must be returned in pairing result");

  // 3. Client listing MUST be redacted
  const clients = service.listClients();
  assert.equal(clients.length, 1);
  const clientSummary = clients[0];
  assert.equal(clientSummary.id, pairing.clientId);
  assert.equal(clientSummary.name, "CLI Test Agent");
  assert.deepEqual(clientSummary.scopes, ["status", "react"]);
  assert.equal(clientSummary.revoked, false);
  assert.equal("token" in (clientSummary as unknown as Record<string, unknown>), false, "client list summary must not contain plaintext token");
  assert.equal("tokenVerifier" in (clientSummary as unknown as Record<string, unknown>), false, "client list summary must not contain token verifier");

  // 4. Check disk state
  const rawDiskState = readFileSync(statePath, "utf8");
  assert.equal(rawDiskState.includes(pairing.token), false, "disk state must never contain plaintext pairing token");
  assert.match(rawDiskState, new RegExp(hashRemoteToken(pairing.token)), "disk state must store only SHA-256 verifier");

  // 5. Rotation returns token ONCE and updates verifier
  const rotated = service.rotateClient(pairing.clientId);
  assert.equal(rotated.clientId, pairing.clientId);
  assert.ok(rotated.token && rotated.token !== pairing.token, "rotated token must be fresh");

  const clientsAfterRotate = service.listClients();
  assert.equal("token" in (clientsAfterRotate[0] as unknown as Record<string, unknown>), false, "rotated client summary must remain redacted");
  assert.equal("tokenVerifier" in (clientsAfterRotate[0] as unknown as Record<string, unknown>), false, "rotated client summary must remain redacted");

  const rawDiskStateAfterRotate = readFileSync(statePath, "utf8");
  assert.equal(rawDiskStateAfterRotate.includes(rotated.token), false, "disk state must not store rotated plaintext token");
  assert.equal(rawDiskStateAfterRotate.includes(hashRemoteToken(pairing.token)), false, "old verifier must be replaced");
  assert.match(rawDiskStateAfterRotate, new RegExp(hashRemoteToken(rotated.token)), "new verifier must be stored");

  // 6. Revocation check
  const revokeResult = service.revokeClient(pairing.clientId);
  assert.equal(revokeResult.revoked, true);
  const clientsAfterRevoke = service.listClients();
  assert.equal(clientsAfterRevoke[0].revoked, true);
  assert.equal("token" in (clientsAfterRevoke[0] as unknown as Record<string, unknown>), false);

  console.log("Remote control redaction test passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
