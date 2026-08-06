#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptsDir, "..");
const repoRoot = resolve(desktopDir, "../..");
const outputDir = join(desktopDir, "dist-electron");
const repository = "alvinunreal/openpets";
const signPathWorkflow = "signpath-windows.yml";
const signedWindowsArtifact = "signed-openpets-windows-x64";
const signedWindowsChecksum = "SHA256SUMS.windows.txt";
const signPathPollIntervalMs = 10_000;
const signPathTimeoutMs = 2 * 60 * 60 * 1_000;
const minimumLinuxPackageBytes = 1 * 1024 * 1024;

const allowedArgs = new Set([
  "--dry-run",
  "--yes",
  "--resume",
  "--include-experimental-arm",
  "--skip-checks",
  "--help",
]);
const rawArgs = process.argv.slice(2);
const args = new Set();
let linuxPackageDir = null;
for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (arg === "--") continue;
  if (arg === "--linux-package-dir" || arg.startsWith("--linux-package-dir=")) {
    if (linuxPackageDir !== null) throw new Error("Duplicate --linux-package-dir option.");
    const value = arg === "--linux-package-dir" ? rawArgs[index + 1] : arg.slice("--linux-package-dir=".length);
    if (!value || value === "--" || value.startsWith("--")) throw new Error("--linux-package-dir requires a non-empty absolute directory path.");
    if (!isAbsolute(value)) throw new Error(`--linux-package-dir must be an absolute path. Received: ${value}`);
    linuxPackageDir = value;
    if (arg === "--linux-package-dir") index += 1;
    continue;
  }
  if (!allowedArgs.has(arg)) throw new Error(`Unknown release option or positional value: ${arg}`);
  args.add(arg);
}
const dryRun = args.has("--dry-run");
const yes = args.has("--yes");
const resume = args.has("--resume");
const includeExperimentalArm = args.has("--include-experimental-arm");
const skipChecks = args.has("--skip-checks");

if (args.has("--help")) {
  printHelp();
  process.exit(0);
}

if (skipChecks && yes) throw new Error("Refusing to create or resume a release with --skip-checks. Run checks before using --yes.");
if (resume && !yes) throw new Error("--resume requires --yes.");
if (dryRun && yes) throw new Error("--dry-run cannot be combined with --yes; it never tags, signs, or changes GitHub.");

const desktopPackageJson = readJson(join(desktopDir, "package.json"));
const version = desktopPackageJson.version;
const tag = `v${version}`;
const expectedWindowsInstaller = `OpenPets-${version}-win-x64-setup.exe`;
const requiredDefaultArtifactNames = new Set([
  `OpenPets-${version}-mac-x64.dmg`,
  `OpenPets-${version}-mac-arm64.dmg`,
  `OpenPets-${version}-mac-x64.zip`,
  `OpenPets-${version}-mac-arm64.zip`,
  expectedWindowsInstaller,
  `OpenPets-${version}-linux-x86_64.AppImage`,
  `OpenPets-${version}-linux-amd64.deb`,
  `OpenPets-${version}-linux-x86_64.rpm`,
  `OpenPets-${version}-linux-x64.tar.gz`,
]);
const optionalExperimentalArtifactNames = new Set([`OpenPets-${version}-linux-arm64.AppImage`]);

main();

function main() {
  preflight();
  const target = commandOutput("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).trim();
  const previousTag = findPreviousReleaseTag(target, resume);
  if (!skipChecks) {
    run("pnpm", ["build"], { cwd: repoRoot });
    run("pnpm", ["--filter", "@open-pets/desktop", "check"], { cwd: repoRoot });
  }

  run("node", ["scripts/clean-package-output.cjs"], { cwd: desktopDir });
  mkdirSync(outputDir, { recursive: true });

  for (const build of createBuildPlan()) {
    run("pnpm", ["exec", "electron-builder", ...build.args, "--publish", "never"], { cwd: desktopDir });
  }
  copyLinuxPackageArtifacts();

  const postBuildStatus = getGitStatusIgnoringPackageOutput();
  if (postBuildStatus) throw new Error(`Build/checks changed tracked or source files. Commit or revert them before releasing.\n${postBuildStatus}`);

  const localArtifacts = collectArtifacts(outputDir);
  validateArtifactSet(localArtifacts, "local build");
  requireFile(join(outputDir, expectedWindowsInstaller), "local Windows NSIS installer");

  console.log("\nLocal build artifacts (the Windows installer will be replaced by the signed workflow artifact):");
  for (const artifact of localArtifacts) console.log(`- ${relative(repoRoot, artifact)}`);

  if (dryRun) {
    const checksumsPath = writeChecksums(localArtifacts);
    console.log(`- ${relative(repoRoot, checksumsPath)}`);
    console.log(`\nDry run complete. No tag, SignPath signing, GitHub release, or publication was performed for ${tag}.`);
    console.log("The dry-run Windows installer is unsigned and was not exposed publicly.");
    return;
  }
  if (!yes) {
    throw new Error("Re-run with --yes to create the draft GitHub release after reviewing the artifact list.");
  }

  if (!resume) {
    createAndPushTag(target);
  }

  const priorSignPathRunIds = new Set(listSignPathRuns()
    .filter((runInfo) => runInfo.event === "workflow_dispatch" && runInfo.headSha === target && (!runInfo.headBranch || runInfo.headBranch === tag))
    .map((runInfo) => String(runInfo.databaseId)));
  const dispatchedAt = Date.now();
  dispatchSignPathWorkflow(tag);
  const signingRun = waitForSignPathRun(target, tag, dispatchedAt, priorSignPathRunIds);
  const signedArtifactDir = mkdtempSync(join(tmpdir(), `openpets-signpath-${version}-`));
  try {
    downloadSignedWindowsArtifact(signingRun.databaseId, signedArtifactDir);
    replaceUnsignedWindowsInstaller(signedArtifactDir);
  } finally {
    rmSync(signedArtifactDir, { recursive: true, force: true });
  }

  const finalArtifacts = collectArtifacts(outputDir);
  validateArtifactSet(finalArtifacts, "signed release");
  requireFile(join(outputDir, expectedWindowsInstaller), "signed Windows NSIS installer");
  const checksumsPath = writeChecksums(finalArtifacts);
  const uploadArtifacts = [...finalArtifacts, checksumsPath];

  console.log("\nFinal release artifacts:");
  for (const artifact of uploadArtifacts) console.log(`- ${relative(repoRoot, artifact)}`);

  ensureDraftRelease(target, previousTag);
  removeUnexpectedDraftAssets(uploadArtifacts);
  run("gh", ["release", "upload", tag, "--repo", repository, ...uploadArtifacts, "--clobber"], { cwd: repoRoot });
  verifyReleaseAssets(uploadArtifacts);
  run("gh", ["release", "edit", tag, "--repo", repository, "--draft=false"], { cwd: repoRoot });
  const publishedRelease = getReleaseDetails();
  if (!publishedRelease || publishedRelease.isDraft) throw new Error(`GitHub release ${tag} was not published after asset verification.`);
  console.log(`\nPublished release created: https://github.com/${repository}/releases/tag/${tag}`);
  console.log("Published releases are visible to the app update checker.");
}

function preflight() {
  if (process.platform !== "darwin") throw new Error("This local release script is intended to run from macOS.");
  if (!isStableSemver(version) || version === "0.0.0") {
    throw new Error(`Desktop package version must be a stable non-zero semver version. Current: ${version}`);
  }
  requireCommand("pnpm", ["--version"]);
  requireCommand("gh", ["--version"]);
  run("gh", ["auth", "status", "--hostname", "github.com"], { cwd: repoRoot });

  const remoteUrl = commandOutput("git", ["remote", "get-url", "origin"], { cwd: repoRoot }).trim();
  if (!remoteUrl.includes(repository)) {
    throw new Error(`Expected origin remote to point at ${repository}. Current origin: ${remoteUrl}`);
  }
  const status = commandOutput("git", ["status", "--porcelain"], { cwd: repoRoot }).trim();
  if (status) throw new Error(`Git working tree must be clean before release.\n${status}`);

  run("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  const upstream = commandOutput("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: repoRoot }).trim();
  if (!upstream) throw new Error("Release branch must have an upstream remote branch.");
  run("git", ["fetch", "--tags", "origin"], { cwd: repoRoot });
  const localHead = commandOutput("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).trim();
  const remoteHead = commandOutput("git", ["rev-parse", upstream], { cwd: repoRoot }).trim();
  if (localHead !== remoteHead) throw new Error(`HEAD must be pushed to ${upstream} before release.`);

  const localTagExists = commandSucceeds("git", ["rev-parse", "--verify", `refs/tags/${tag}`], { cwd: repoRoot });
  const remoteTagCommit = getRemoteTagCommit();
  const release = getReleaseDetails();
  if (resume) {
    if (!localTagExists || !remoteTagCommit) {
      throw new Error(`--resume requires both local and origin ${tag} tags. If tag pushing failed, push it manually, then retry.`);
    }
    assertTagAtHead(localTagExists, remoteTagCommit);
    if (release && !release.isDraft) throw new Error(`GitHub release ${tag} is already published; --resume refuses to modify published releases.`);
    return;
  }

  if (localTagExists) throw new Error(`Git tag already exists locally: ${tag}`);
  if (remoteTagCommit) throw new Error(`Git tag already exists on origin: ${tag}`);
  if (release) {
    throw new Error(`GitHub release already exists: ${tag}`);
  }
}

function createAndPushTag(target) {
  run("git", ["tag", "--annotate", tag, "--message", `OpenPets ${tag}`, target], { cwd: repoRoot });
  run("git", ["push", "origin", `refs/tags/${tag}`], { cwd: repoRoot });
  assertTagAtHead(true, target);
}

function assertTagAtHead(localTagExists, remoteTagCommit) {
  const target = commandOutput("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).trim();
  if (!localTagExists) throw new Error(`Local tag ${tag} does not exist.`);
  const localTagCommit = commandOutput("git", ["rev-parse", `refs/tags/${tag}^{commit}`], { cwd: repoRoot }).trim();
  if (localTagCommit !== target) throw new Error(`Local tag ${tag} must point to HEAD ${target}; found ${localTagCommit}.`);
  if (remoteTagCommit && remoteTagCommit !== target) throw new Error(`Origin tag ${tag} must point to HEAD ${target}; found ${remoteTagCommit}.`);
}

function getRemoteTagCommit() {
  const result = spawnSync("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Unable to inspect origin tag ${tag}: ${result.stderr || result.stdout}`);
  const refs = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/));
  const peeled = refs.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
  const direct = refs.find(([, ref]) => ref === `refs/tags/${tag}`);
  return (peeled || direct)?.[0] || null;
}

function findPreviousReleaseTag(target, excludeTargetTag) {
  const revision = excludeTargetTag ? `${target}^` : target;
  const result = spawnSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", revision], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function getReleaseDetails() {
  const result = spawnSync("gh", ["release", "view", tag, "--repo", repository, "--json", "isDraft,assets,url"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status === 0) {
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`Could not parse GitHub release details for ${tag}: ${error.message}`);
    }
  }
  const message = `${result.stderr || ""}\n${result.stdout || ""}`;
  if (/not found|404|does not exist/i.test(message)) return null;
  throw new Error(`Unable to inspect GitHub release ${tag}: ${message.trim()}`);
}

function dispatchSignPathWorkflow(ref) {
  run(
    "gh",
    [
      "workflow",
      "run",
      signPathWorkflow,
      "--repo",
      repository,
      "--ref",
      ref,
      "-f",
      "signing_policy_slug=release-signing",
      "-f",
      "artifact_configuration_app_exe_slug=openpets-windows-app-exe-zip",
      "-f",
      "artifact_configuration_installer_slug=openpets-windows-installer-zip",
    ],
    { cwd: repoRoot },
  );
}

function listSignPathRuns() {
  return JSON.parse(
    commandOutput(
      "gh",
      [
        "run",
        "list",
        "--workflow",
        signPathWorkflow,
        "--repo",
        repository,
        "--limit",
        "20",
        "--json",
        "databaseId,headSha,headBranch,event,status,conclusion,createdAt,url",
      ],
      { cwd: repoRoot },
    ),
  );
}

function waitForSignPathRun(target, ref, dispatchedAt, priorRunIds) {
  const deadline = Date.now() + signPathTimeoutMs;
  let lastError = "the run list was not available";
  console.log(`\nWaiting for the SignPath workflow run for ${ref} at ${target}. Manual approval may be required in SignPath.`);

  while (Date.now() < deadline) {
    try {
      const runs = listSignPathRuns();
      const candidates = runs
        .filter((runInfo) => {
          const createdAt = Date.parse(runInfo.createdAt || "");
          return (
            runInfo.event === "workflow_dispatch" &&
            runInfo.headSha === target &&
            (!runInfo.headBranch || runInfo.headBranch === ref) &&
            !priorRunIds.has(String(runInfo.databaseId)) &&
            Number.isFinite(createdAt) &&
            createdAt >= dispatchedAt - 60_000
          );
        })
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

      const runInfo = candidates[0];
      if (runInfo) {
        const status = runInfo.status || "unknown";
        const url = runInfo.url ? ` (${runInfo.url})` : "";
        if (status === "completed") {
          if (runInfo.conclusion === "success") return runInfo;
          throw new Error(`SignPath workflow run ${runInfo.databaseId} failed with conclusion ${runInfo.conclusion || "unknown"}${url}.`);
        }
        console.log(`SignPath workflow run ${runInfo.databaseId} is ${status}; still waiting${url}.`);
      } else {
        console.log("The dispatched SignPath workflow run is not visible yet; waiting...");
      }
    } catch (error) {
      lastError = error.message;
      if (error.message.startsWith("SignPath workflow run ")) throw error;
      console.log(`Could not inspect the SignPath workflow run yet: ${error.message}`);
    }

    sleepSync(Math.min(signPathPollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  throw new Error(`Timed out waiting for the SignPath workflow run for ${ref}. Last error: ${lastError}`);
}

function downloadSignedWindowsArtifact(runId, destination) {
  if (!runId) throw new Error(`The SignPath workflow did not provide a run ID for ${tag}.`);
  run("gh", ["run", "download", String(runId), "--repo", repository, "--name", signedWindowsArtifact, "--dir", destination], { cwd: repoRoot });
}

function replaceUnsignedWindowsInstaller(signedArtifactDir) {
  const files = listFilesRecursively(signedArtifactDir);
  const expectedNames = new Set([expectedWindowsInstaller, signedWindowsChecksum]);
  const unexpected = files.filter((filePath) => !expectedNames.has(basename(filePath)));
  if (unexpected.length > 0 || files.length !== expectedNames.size) {
    throw new Error(
      `SignPath artifact ${signedWindowsArtifact} must contain exactly ${expectedWindowsInstaller} and ${signedWindowsChecksum}; found ${files
        .map((filePath) => basename(filePath))
        .join(", ") || "nothing"}.`,
    );
  }

  const signedInstaller = files.find((filePath) => basename(filePath) === expectedWindowsInstaller);
  const checksumFile = files.find((filePath) => basename(filePath) === signedWindowsChecksum);
  if (!signedInstaller || !checksumFile) throw new Error(`SignPath artifact ${signedWindowsArtifact} is missing its expected files.`);

  const checksumLines = readFileSync(checksumFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
  if (checksumLines.length !== 1) throw new Error(`${signedWindowsChecksum} must contain exactly one checksum line.`);
  const checksumMatch = /^([a-f0-9]{64}) {2}(.+)$/i.exec(checksumLines[0]);
  if (!checksumMatch || checksumMatch[2] !== expectedWindowsInstaller) {
    throw new Error(`${signedWindowsChecksum} does not name exactly ${expectedWindowsInstaller}.`);
  }
  const actualChecksum = sha256(signedInstaller);
  if (actualChecksum !== checksumMatch[1].toLowerCase()) {
    throw new Error(`SignPath checksum mismatch for ${expectedWindowsInstaller}: expected ${checksumMatch[1]}, got ${actualChecksum}.`);
  }

  copyFileSync(signedInstaller, join(outputDir, expectedWindowsInstaller));
}

function listFilesRecursively(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursively(filePath));
    else if (entry.isFile()) files.push(filePath);
    else throw new Error(`Unexpected non-file in downloaded SignPath artifact: ${filePath}`);
  }
  return files;
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ensureDraftRelease(target, previousTag) {
  const release = getReleaseDetails();
  if (release && !release.isDraft) throw new Error(`GitHub release ${tag} is already published; refusing to replace published assets.`);
  const notes = defaultReleaseNotes(previousTag);
  if (release) {
    run("gh", ["release", "edit", tag, "--repo", repository, "--draft", "--title", `OpenPets ${tag}`, "--notes", notes], { cwd: repoRoot });
  } else {
    run("gh", ["release", "create", tag, "--repo", repository, "--target", target, "--draft", "--title", `OpenPets ${tag}`, "--notes", notes], { cwd: repoRoot });
  }
}

function removeUnexpectedDraftAssets(uploadArtifacts) {
  const expectedNames = new Set(uploadArtifacts.map((artifact) => basename(artifact)));
  const release = getReleaseDetails();
  if (!release || !release.isDraft) throw new Error(`Expected a draft GitHub release ${tag} before uploading assets.`);
  for (const asset of release.assets || []) {
    if (!expectedNames.has(asset.name)) {
      run("gh", ["release", "delete-asset", tag, asset.name, "--repo", repository, "--yes"], { cwd: repoRoot });
    }
  }
}

function verifyReleaseAssets(uploadArtifacts) {
  const release = getReleaseDetails();
  if (!release || !release.isDraft) throw new Error(`Expected a draft GitHub release ${tag} while verifying assets.`);
  const expectedNames = uploadArtifacts.map((artifact) => basename(artifact)).sort();
  const actualNames = (release.assets || []).map((asset) => asset.name).sort();
  if (expectedNames.length !== actualNames.length || expectedNames.some((name, index) => name !== actualNames[index])) {
    throw new Error(`GitHub release ${tag} asset mismatch. Expected exactly [${expectedNames.join(", ")}], found [${actualNames.join(", ")}].`);
  }
}

function createBuildPlan() {
  const plan = [
    { name: "mac dmg x64+arm64", args: ["--mac", "dmg", "--x64", "--arm64"] },
    { name: "mac zip x64+arm64", args: ["--mac", "zip", "--x64", "--arm64"] },
    { name: "windows nsis x64", args: ["--win", "nsis", "--x64"] },
    { name: "linux AppImage x64", args: ["--linux", "AppImage", "--x64"] },
  ];
  if (!linuxPackageDir) {
    plan.push({ name: "linux deb x64", args: ["--linux", "deb", "--x64"] });
    plan.push({ name: "linux rpm x64", args: ["--linux", "rpm", "--x64"] });
  }
  plan.push({ name: "linux tar.gz x64", args: ["--linux", "tar.gz", "--x64"] });
  if (includeExperimentalArm) {
    plan.push({ name: "windows nsis arm64", args: ["--win", "nsis", "--arm64"] });
    plan.push({ name: "linux AppImage arm64", args: ["--linux", "AppImage", "--arm64"] });
  }
  console.log("Build plan:");
  for (const build of plan) console.log(`- ${build.name}`);
  return plan;
}

function copyLinuxPackageArtifacts() {
  if (!linuxPackageDir) return;

  let directoryStat;
  try {
    directoryStat = lstatSync(linuxPackageDir);
  } catch {
    throw new Error(`Linux package staging directory does not exist: ${linuxPackageDir}`);
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Linux package staging path must be a real directory: ${linuxPackageDir}`);
  }

  for (const name of [`OpenPets-${version}-linux-amd64.deb`, `OpenPets-${version}-linux-x86_64.rpm`]) {
    const sourcePath = join(linuxPackageDir, name);
    let sourceStat;
    try {
      sourceStat = lstatSync(sourcePath);
    } catch {
      throw new Error(`Missing Linux package artifact in staging directory: ${sourcePath}`);
    }
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Error(`Linux package artifact must be an ordinary file, not a symlink or directory: ${sourcePath}`);
    }
    if (sourceStat.size < minimumLinuxPackageBytes) {
      throw new Error(`Linux package artifact is too small to be valid (${sourceStat.size} bytes; minimum ${minimumLinuxPackageBytes}): ${sourcePath}`);
    }
    copyFileSync(sourcePath, join(outputDir, name));
  }
}

function collectArtifacts(dir) {
  const allowedExtensions = new Set([".dmg", ".zip", ".exe", ".AppImage", ".deb", ".rpm"]);
  const artifacts = [];
  for (const entry of readdirSync(dir)) {
    const filePath = join(dir, entry);
    const stat = statSync(filePath);
    if (!stat.isFile()) continue;
    const name = basename(filePath);
    if (extname(name) === ".exe" && name !== expectedWindowsInstaller) continue;
    if (allowedExtensions.has(extname(name)) || name.endsWith(".tar.gz")) artifacts.push(filePath);
  }
  return artifacts.filter((path) => basename(path) !== "SHA256SUMS").sort();
}

function requireFile(filePath, description) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    throw new Error(`Missing ${description}: ${filePath}`);
  }
  if (!stat.isFile()) throw new Error(`Expected ${description} to be a file: ${filePath}`);
}

function validateArtifactSet(artifacts, stage) {
  const actualNames = new Set(artifacts.map((artifact) => basename(artifact)));
  const missing = [...requiredDefaultArtifactNames].filter((name) => !actualNames.has(name));
  const unexpected = [...actualNames].filter(
    (name) => !requiredDefaultArtifactNames.has(name) && !(includeExperimentalArm && optionalExperimentalArtifactNames.has(name)),
  );
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Incomplete ${stage} artifact set for ${version}. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`,
    );
  }
}

function writeChecksums(artifacts) {
  const lines = artifacts.map((artifact) => `${sha256(artifact)}  ${basename(artifact)}`);
  const checksumsPath = join(outputDir, "SHA256SUMS");
  writeFileSync(checksumsPath, `${lines.join("\n")}\n`);
  return checksumsPath;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function getGitStatusIgnoringPackageOutput() {
  return commandOutput("git", ["status", "--porcelain"], { cwd: repoRoot })
    .split("\n")
    .filter((line) => line.trim() && !line.includes("apps/desktop/dist-electron/"))
    .join("\n");
}

function isStableSemver(value) {
  return /^\d+\.\d+\.\d+$/.test(value);
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

function defaultReleaseNotes(previousTag) {
  const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
  const commits = commandOutput("git", ["log", "--pretty=format:%h %s", range], { cwd: repoRoot })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return [
    `OpenPets ${tag} desktop release.`,
    "",
    `Changes since ${previousTag || "the initial history"}:`,
    "",
    ...(commits.length > 0 ? commits.map((commit) => `- ${commit}`) : ["- No commits found in the release range."]),
    "",
    "## Artifacts",
    "",
    "This release includes the full desktop artifact set: macOS DMG/ZIP, Windows installer, Linux AppImage/DEB/RPM/tar.gz, and SHA256SUMS.",
    "",
    "## Notes",
    "",
    "The Windows x64 installer is Authenticode-signed by SignPath through GitHub Actions. macOS and Linux artifacts remain unsigned.",
  ].join("\n");
}

function printHelp() {
  console.log(`Usage: pnpm release:desktop -- --yes\n\nBuilds local desktop artifacts, obtains the SignPath-signed Windows installer, then creates and publishes a verified GitHub release.\n\nDefault targets:\n  - macOS dmg x64+arm64\n  - macOS zip x64+arm64\n  - Windows nsis x64 (local build is replaced by the signed workflow artifact)\n  - Linux AppImage x64\n  - Linux deb x64\n  - Linux rpm x64\n  - Linux tar.gz x64\n\nOptions:\n  --yes                       tag, sign, create a draft release, verify assets, and publish\n  --resume                    with --yes, rebuild/re-sign a tagged HEAD and clobber draft assets\n  --dry-run                   build/check locally without tagging, signing, or changing GitHub\n  --linux-package-dir <dir>  use validated Ubuntu-built DEB/RPM files from an absolute staging directory\n  --skip-checks               skip pnpm build and desktop check (incompatible with --yes)\n  --include-experimental-arm  also build Windows/Linux ARM64 targets; the unsigned Windows ARM installer is not published\n`);
}
