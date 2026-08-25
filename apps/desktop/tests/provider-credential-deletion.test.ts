import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildProviderControlCenterSnapshot, createProviderProfile, getPluginPlatformSettings, initializePluginPlatformSettings, selectProviderProfile } from "../src/plugin-platform-settings.js";
import { deleteProviderCredentialForProfile } from "../src/windows.js";

const dir = mkdtempSync(join(tmpdir(), "openpets-provider-credential-delete-"));

async function main(): Promise<void> {
  try {
    initializePluginPlatformSettings(dir);
    createProviderProfile({ id: "shared-a", label: "Shared A", adapter: "openai-compatible-text", model: "a", baseUrl: "https://provider.example/v1", secretRef: "shared" });
    createProviderProfile({ id: "shared-b", label: "Shared B", adapter: "openai-compatible-text", model: "b", baseUrl: "https://provider.example/v1", secretRef: "shared" });
    selectProviderProfile("text", "shared-b");

    const secrets = new Map([["provider:shared", "test-key"]]);
    await deleteProviderCredentialForProfile({ delete: async (_owner: string, key: string) => { secrets.delete(key); } }, getPluginPlatformSettings().profiles["shared-b"]!);

    assert.equal(secrets.has("provider:shared"), false);
    assert.equal(getPluginPlatformSettings().profiles["shared-a"]?.secretRef, "shared");
    assert.equal(getPluginPlatformSettings().profiles["shared-b"]?.secretRef, "shared");
    assert.equal(buildProviderControlCenterSnapshot(getPluginPlatformSettings(), () => false).statuses.text.state, "missing-secret");
    console.log("provider credential deletion tests passed.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().then(() => { if (process.versions.electron) process.exit(0); }, (error) => {
  console.error(error);
  if (process.versions.electron) process.exit(1);
  process.exitCode = 1;
});
