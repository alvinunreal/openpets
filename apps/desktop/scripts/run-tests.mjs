#!/usr/bin/env node
/**
 * Desktop test runner
 * Runs preload checks, builds and runs behavior tests, contract tests, then remaining dist checks.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const preloadChecks = ["control-center-preload.cjs", "pet-preload.cjs", "plugin-sdk-preload.cjs", "panel-preload.cjs"];
const behaviorTests = [
  ".test-dist/tests/lease-manager.test.js",
  ".test-dist/tests/lease-manager-fixes.test.js",
  ".test-dist/tests/lan-state.test.js",
  ".test-dist/tests/lan-auth.test.js",
  ".test-dist/tests/lan-controller.test.js",
  ".test-dist/tests/lan-client-retry.test.js",
  ".test-dist/tests/lan-persistence.test.js",
  ".test-dist/tests/default-pet-external-show.test.js",
  ".test-dist/tests/onboarding-state.test.js",
  ".test-dist/tests/update-version.test.js",
  ".test-dist/tests/reaction-animation-mapping.test.js",
  ".test-dist/tests/zip-safety.test.js",
  ".test-dist/tests/codex-pets.test.js",
  ".test-dist/tests/claude-memory.test.js",
  ".test-dist/tests/plugin-config.test.js",
  ".test-dist/tests/plugin-assets.test.js",
  ".test-dist/tests/plugin-delivery.test.js",
  ".test-dist/tests/plugin-state.test.js",
  ".test-dist/tests/plugin-runtime.test.js",
  ".test-dist/tests/plugin-catalog-validation.test.js",
  ".test-dist/tests/plugin-package.test.js",
  ".test-dist/tests/plugin-service.test.js",
  ".test-dist/tests/plugin-bridge-fuzz.test.js",
  ".test-dist/tests/pet-fallback-notify.test.js",
  ".test-dist/tests/pet-pool-order.test.js",
  ".test-dist/tests/pet-pool.test.js",
  ".test-dist/tests/pool-toggle.test.js",
  ".test-dist/tests/local-ipc-confinement.test.js",
  ".test-dist/tests/confinement-permission.test.js",
  ".test-dist/tests/confinement-poller-backoff.test.js",
  ".test-dist/tests/window-tracker.test.js",
  ".test-dist/tests/window-tracker-chain.test.js",
  ".test-dist/tests/window-tracker-win32.test.js",
  ".test-dist/tests/window-tracker-reentry.test.js",
  ".test-dist/tests/confinement-manager.test.js",
  ".test-dist/tests/pet-confinement-enabled.test.js",
  ".test-dist/tests/pet-motion-gravity.test.js",
  ".test-dist/tests/pet-motion-engine-clamp.test.js",
  ".test-dist/tests/pet-motion-engine-shared-ticker.test.js",
  ".test-dist/tests/pet-motion-engine-single-writer.test.js",
  ".test-dist/tests/pet-motion-engine-gravity-seam.test.js",
  ".test-dist/tests/pet-motion-engine-hidden-move.test.js",
  ".test-dist/tests/pet-motion-engine-nan-guard.test.js",
  ".test-dist/tests/pet-roaming-controller.test.js",
  ".test-dist/tests/display.test.js",
  ".test-dist/tests/preference-patch.test.js",
  ".test-dist/tests/plugin-agent-activity.test.js",
  ".test-dist/tests/pet-window-wayland-predicate.test.js",
];
const contractTests = [
  ".test-dist/contracts/local-ipc-protocol.contract.js",
  ".test-dist/contracts/catalog-fixture.contract.js",
  ".test-dist/contracts/plugin-manifest.contract.js",
];
const distChecks = [
  "dist/check-opencode-desktop-setup.js",
  "dist/check-cursor-desktop.js",
  "dist/check-packaging-contract.js",
];

function commandForPlatform(command, args) {
  if (process.platform === "win32" && command === "pnpm") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd", ...args] };
  }
  return { command, args };
}

function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const platformCommand = commandForPlatform(command, args);
    const child = spawn(platformCommand.command, platformCommand.args, {
      stdio: "inherit",
      cwd: rootDir,
      env: { ...process.env, OPENPETS_DESKTOP_ROOT: rootDir },
      ...options,
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed with exit code ${code}: ${command} ${args.join(" ")}`));
      } else {
        resolve();
      }
    });
    child.on("error", reject);
  });
}

async function main() {
  // 1. Preload syntax checks
  console.log("\n[1/5] Checking preload syntax...");
  for (const preload of preloadChecks) await run("node", ["--check", preload]);

  // 2. Build tests
  console.log("\n[2/5] Building tests...");
  await run("pnpm", ["test:build"]);

  // 3. Run behavior tests
  console.log("\n[3/5] Running behavior tests...");
  for (const test of behaviorTests) await run("node", [test]);

  // 4. Run contract tests
  console.log("\n[4/5] Running contract tests...");
  for (const test of contractTests) await run("node", [test]);

  // 5. Run remaining dist checks
  console.log("\n[5/5] Running dist checks...");
  for (const check of distChecks) {
    await run("node", [check]);
  }

  console.log("\nâœ“ All tests passed!");
}

main().catch((err) => {
  console.error("\nâœ— Test suite failed:", err.message);
  process.exit(1);
});
