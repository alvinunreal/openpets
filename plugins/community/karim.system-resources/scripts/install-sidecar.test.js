import assert from "node:assert/strict";
import path from "node:path";
import { sidecarInstallCommand } from "./install-sidecar.mjs";

const root = "/tmp/plugin";
assert.deepEqual(sidecarInstallCommand("darwin", root), {
  command: "bash",
  args: [path.join(root, "scripts/install-sidecar.sh")],
});
assert.deepEqual(sidecarInstallCommand("linux", root), {
  command: "bash",
  args: [path.join(root, "scripts/install-sidecar-linux.sh")],
});
assert.equal(sidecarInstallCommand("win32", root).command, "powershell.exe");
assert.match(sidecarInstallCommand("win32", root).args.at(-1), /install-sidecar\.ps1$/);
assert.throws(() => sidecarInstallCommand("freebsd", root), /platform/);

console.log("install-sidecar dispatcher: all checks passed.");
