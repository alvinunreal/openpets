import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createProviderProfile, getPluginPlatformSettings, initializePluginPlatformSettings } from "../src/plugin-platform-settings.js";
import { deleteProviderCredentialForProfile } from "../src/windows.js";

const dir = mkdtempSync(join(tmpdir(), "openpets-provider-credential-delete-"));

async function main(): Promise<void> {
  try {
    initializePluginPlatformSettings(dir);
    createProviderProfile({ id: "shared-a", label: "Shared A", adapter: "openai-compatible-text", model: "a", baseUrl: "https://provider.example/v1", secretRef: "shared" });
    createProviderProfile({ id: "shared-b", label: "Shared B", adapter: "openai-compatible-text", model: "b", baseUrl: "https://provider.example/v1", secretRef: "shared" });
    createProviderProfile({ id: "unshared", label: "Unshared", adapter: "openai-compatible-text", model: "unshared", baseUrl: "https://provider.example/v1", secretRef: "unshared" });

    const secrets = new Map([["provider:shared", "shared-key"], ["provider:unshared", "unshared-key"]]);
    let deletes = 0;
    const secretStore = { delete: async (_owner: string, key: string) => { deletes += 1; secrets.delete(key); } };
    const settings = getPluginPlatformSettings();
    const profiles = Object.values(settings.profiles);
    await assert.rejects(
      () => deleteProviderCredentialForProfile(secretStore, settings.profiles["shared-b"]!, profiles),
      /Replace or remove the other profile's secret reference first/,
    );

    assert.equal(secrets.get("provider:shared"), "shared-key");
    assert.equal(getPluginPlatformSettings().profiles["shared-a"]?.secretRef, "shared");
    assert.equal(getPluginPlatformSettings().profiles["shared-b"]?.secretRef, "shared");
    assert.equal(deletes, 0);
    await deleteProviderCredentialForProfile(secretStore, settings.profiles["unshared"]!, profiles);
    assert.equal(secrets.has("provider:unshared"), false);
    assert.equal(deletes, 1);
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
