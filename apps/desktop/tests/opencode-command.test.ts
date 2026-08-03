import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getDefaultOpenCodeCommand, getOpenCodeCommandCandidates } from "../src/opencode-command.js";

const root = mkdtempSync(join(tmpdir(), "openpets-opencode-command-"));

try {
  const userScoopShim = join(root, "scoop", "shims", "opencode.exe");
  mkdirSync(join(root, "scoop", "shims"), { recursive: true });
  writeFileSync(userScoopShim, "");

  assert.equal(getDefaultOpenCodeCommand(), "opencode");
  assert.deepEqual(
    getOpenCodeCommandCandidates({ homeDir: root, platform: "win32", env: {} }),
    [userScoopShim, "opencode", "opencode.cmd"],
    "Windows detection must find the default Scoop shim even when the desktop PATH is stale.",
  );

  const customScoop = join(root, "portable-scoop");
  const customScoopShim = join(customScoop, "shims", "opencode.exe");
  mkdirSync(join(customScoop, "shims"), { recursive: true });
  writeFileSync(customScoopShim, "");
  assert.equal(
    getOpenCodeCommandCandidates({ homeDir: join(root, "other-home"), platform: "win32", env: { SCOOP: customScoop } })[0],
    customScoopShim,
    "Windows detection must respect a custom SCOOP root.",
  );

  assert.deepEqual(
    getOpenCodeCommandCandidates({ configuredCommand: "C:\\Tools\\opencode.exe", homeDir: root, platform: "win32" }),
    ["C:\\Tools\\opencode.exe"],
    "A user-selected executable must take precedence over automatic detection.",
  );
  assert.deepEqual(getOpenCodeCommandCandidates({ homeDir: root, platform: "darwin" }), ["opencode"]);
} finally {
  rmSync(root, { recursive: true, force: true });
}
