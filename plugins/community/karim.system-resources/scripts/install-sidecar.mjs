import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Map Node `process.platform` to the persistent sidecar installer. */
export function sidecarInstallCommand(platform = process.platform, root = ROOT) {
  if (platform === "darwin") {
    return { command: "bash", args: [path.join(root, "scripts/install-sidecar.sh")] };
  }
  if (platform === "linux") {
    return { command: "bash", args: [path.join(root, "scripts/install-sidecar-linux.sh")] };
  }
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts/install-sidecar.ps1")],
    };
  }
  throw new Error(`No sidecar installer for platform "${platform}". Use macOS, Linux, or Windows.`);
}

function run(spec) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${spec.command} exited ${code}`));
    });
  });
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  await run(sidecarInstallCommand());
}
