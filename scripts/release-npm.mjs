#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const repository = "alvinunreal/openpets";
const npmRegistry = "https://registry.npmjs.org";
const npmRegistryProbeTimeoutMs = 30_000;

const publishOrder = [
  "packages/sdk",
  "packages/client",
  "packages/agent-events",
  "packages/dsh",
  "packages/mcp",
  "packages/claude",
  "packages/opencode",
  "packages/cursor",
  "packages/pi",
  "packages/cli",
  "packages/install-pet",
];

const allowedArgs = new Set([
  "--yes",
  "--dry-run",
  "--skip-checks",
  "--help",
]);

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const options = parseArgs(rawArgs);
if (options.help) {
  printHelp();
  process.exit(0);
}

const packages = publishOrder.map((relativePath) => {
  const packageDir = join(repoRoot, relativePath);
  const packageJson = readJson(join(packageDir, "package.json"));
  return { relativePath, packageDir, packageJson, name: packageJson.name, version: packageJson.version };
});

await main();

async function main() {
  preflight();
  assertPublishablePackages();

  if (!options.skipChecks) {
    run("pnpm", ["build"], { cwd: repoRoot });
    run("pnpm", ["check"], { cwd: repoRoot });
  }

  const existing = await findAlreadyPublishedPackages();

  console.log("\nNPM publish plan:");
  for (const pkg of packages) {
    const alreadyPublished = existing.some((candidate) => candidate.name === pkg.name && candidate.version === pkg.version);
    console.log(`- ${pkg.name}@${pkg.version}${alreadyPublished ? " (already published)" : ""}`);
  }

  if (!options.yes || options.dryRun) {
    console.log("\nDry run: package publish commands will be validated without uploading.");
  }

  for (const pkg of packages) {
    const alreadyPublished = existing.some((candidate) => candidate.name === pkg.name && candidate.version === pkg.version);
    if (alreadyPublished) {
      console.log(`\nSkipping already published ${pkg.name}@${pkg.version}`);
      continue;
    }

    const args = ["publish", "--access", "public", "--tag", options.tag, "--no-git-checks", "--registry", npmRegistry];
    if (!options.yes || options.dryRun) args.push("--dry-run");
    if (options.otp) args.push("--otp", options.otp);
    run("pnpm", args, { cwd: pkg.packageDir });
  }

  if (options.yes && !options.dryRun) {
    console.log("\nNPM packages published successfully.");
  } else {
    console.log("\nDry run complete. Re-run with --yes to publish to npm.");
  }
}

function parseArgs(args) {
  const parsed = { yes: false, dryRun: false, skipChecks: false, help: false, tag: "latest", otp: "" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--tag" || arg === "--otp") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      if (arg === "--tag") parsed.tag = value;
      if (arg === "--otp") parsed.otp = value;
      index += 1;
      continue;
    }

    if (!allowedArgs.has(arg)) throw new Error(`Unknown npm release option: ${arg}`);
    if (arg === "--yes") parsed.yes = true;
    if (arg === "--dry-run") parsed.dryRun = true;
    if (arg === "--skip-checks") parsed.skipChecks = true;
    if (arg === "--help") parsed.help = true;
  }
  return parsed;
}

function preflight() {
  requireCommand("pnpm", ["--version"]);
  requireCommand("npm", ["--version"]);
  if (options.yes && !options.dryRun) run("npm", ["whoami", "--registry", npmRegistry], { cwd: repoRoot });

  const remoteUrl = commandOutput("git", ["remote", "get-url", "origin"], { cwd: repoRoot }).trim();
  if (!remoteUrl.includes(repository)) throw new Error(`Expected origin remote to point at ${repository}. Current origin: ${remoteUrl}`);

  const status = commandOutput("git", ["status", "--porcelain"], { cwd: repoRoot }).trim();
  if (status) throw new Error(`Git working tree must be clean before npm release.\n${status}`);

  run("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  const upstream = commandOutput("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: repoRoot }).trim();
  if (!upstream) throw new Error("Release branch must have an upstream remote branch.");
  run("git", ["fetch", "origin"], { cwd: repoRoot });
  const localHead = commandOutput("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).trim();
  const remoteHead = commandOutput("git", ["rev-parse", upstream], { cwd: repoRoot }).trim();
  if (localHead !== remoteHead) throw new Error(`HEAD must be pushed to ${upstream} before npm release.`);
}

function assertPublishablePackages() {
  const versions = new Set(packages.map((pkg) => pkg.version));
  if (versions.size !== 1) throw new Error(`Publishable packages must use one shared version. Found: ${[...versions].join(", ")}`);

  for (const pkg of packages) {
    if (!pkg.name || !pkg.version) throw new Error(`${pkg.relativePath}/package.json must include name and version.`);
    if (pkg.packageJson.private) throw new Error(`${pkg.name} is private and cannot be published.`);
    if (pkg.packageJson.publishConfig?.access !== "public") throw new Error(`${pkg.name} must set publishConfig.access to "public".`);
    if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error(`${pkg.name} version must be stable semver. Current: ${pkg.version}`);
  }
}

async function findAlreadyPublishedPackages() {
  const existing = [];
  for (const pkg of packages) {
    if (await npmPackageIsPublished(pkg)) existing.push(pkg);
  }
  return existing;
}

async function npmPackageIsPublished(pkg) {
  const args = ["view", `${pkg.name}@${pkg.version}`, "version", "--json", "--registry", npmRegistry];
  const command = `npm ${args.join(" ")}`;
  console.log(`Checking npm registry: ${pkg.name}@${pkg.version}`);
  let result;
  try {
    result = await runNpmRegistryProbe(args);
  } catch (error) {
    throw new Error(`npm registry probe failed for ${pkg.name}@${pkg.version}: ${command}. ${error.message}. Check npm registry connectivity and authentication, then retry.`);
  }

  if (result.status === 0) return true;
  const output = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
  if (isUnpublishedNpmPackage(pkg, result)) return false;

  const reason = `exited with code ${result.status ?? "unknown"}`;
  throw new Error(`npm registry probe failed for ${pkg.name}@${pkg.version}: ${command} ${reason}. Check npm registry connectivity and authentication, then retry.${output ? `\n${output}` : ""}`);
}

function isUnpublishedNpmPackage(pkg, result) {
  if (result.status !== 1) return false;
  let error;
  try {
    ({ error } = JSON.parse(result.stdout));
  } catch {
    return false;
  }
  const packageVersion = `${pkg.name}@${pkg.version}`;
  return error?.code === "E404"
    && error.summary === `No match found for version ${pkg.version}`
    && error.detail?.startsWith(`The requested resource '${packageVersion}' could not be found`);
}

function runNpmRegistryProbe(args) {
  return new Promise((resolveProbe, rejectProbe) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("npm", args, {
      cwd: repoRoot,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      terminateProcessTree(child);
      rejectProbe(new Error(`timed out after ${npmRegistryProbeTimeoutMs / 1_000} seconds`));
    }, npmRegistryProbeTimeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectProbe(error);
    });
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveProbe({ status, stdout, stderr });
    });
  });
}

function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const terminator = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { detached: true, stdio: "ignore", windowsHide: true });
    terminator.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function requireCommand(command, args) {
  if (!commandSucceeds(command, args, { cwd: repoRoot })) throw new Error(`Required command is unavailable: ${command}`);
}

function commandSucceeds(command, args, options) {
  return spawnSync(command, args, { cwd: options.cwd, stdio: "ignore" }).status === 0;
}

function commandOutput(command, args, options) {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function run(command, args, options) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: options.cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
}

function printHelp() {
  console.log(`Usage: pnpm release:npm -- --yes

Publishes the public OpenPets npm packages in dependency order.

Packages:
  1. @open-pets/plugin-sdk
  2. @open-pets/client
  3. @open-pets/agent-events
  4. @open-pets/dsh
  5. @open-pets/mcp
  6. @open-pets/claude
  7. @open-pets/opencode
  8. @open-pets/cursor
  9. @open-pets/pi
  10. @open-pets/cli
  11. install-pet

Options:
  --yes            publish to npm; without this, runs pnpm publish --dry-run
  --dry-run        force dry-run behavior even with --yes
  --skip-checks    skip pnpm build and pnpm check
  --tag <tag>      npm dist-tag to publish under (default: latest)
  --otp <code>     npm two-factor authentication one-time password
  --help           show this help
`);
}
