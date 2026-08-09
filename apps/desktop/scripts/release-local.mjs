#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptsDir, "..");
const repoRoot = resolve(desktopDir, "../..");
const outputDir = join(desktopDir, "dist-electron");
const stateDir = join(desktopDir, ".release-state");
const stateSchema = 1;
const repository = "alvinunreal/openpets";
const signPathWorkflow = "signpath-windows.yml";
const signedWindowsArtifact = "signed-openpets-windows-x64";
const signedWindowsChecksum = "SHA256SUMS.windows.txt";
const signPathPollIntervalMs = 10_000;
const signPathDiscoveryTimeoutMs = 10 * 60 * 1_000;
const signPathTimeoutMs = 2 * 60 * 60 * 1_000;
const minimumLinuxPackageBytes = 1 * 1024 * 1024;

const allowedArgs = new Set([
  "--dry-run",
  "--yes",
  "--resume",
  "--include-experimental-arm",
  "--skip-checks",
  "--status",
  "--reset",
  "--help",
]);
const rawArgs = process.argv.slice(2);
const args = new Set();
let linuxPackageDir = null;
let fromStage = null;
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
  if (arg === "--from" || arg.startsWith("--from=")) {
    if (fromStage !== null) throw new Error("Duplicate --from option.");
    const value = arg === "--from" ? rawArgs[index + 1] : arg.slice("--from=".length);
    if (!value || value === "--" || value.startsWith("--")) throw new Error("--from requires a stage id. Run --status to list stage ids.");
    fromStage = value;
    if (arg === "--from") index += 1;
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
const showStatus = args.has("--status");
const resetState = args.has("--reset");

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
const statePath = join(stateDir, `${tag}.json`);
const expectedWindowsInstaller = `OpenPets-${version}-win-x64-setup.exe`;
const requiredPreSigningArtifactNames = new Set([
  `OpenPets-${version}-mac-x64.dmg`,
  `OpenPets-${version}-mac-arm64.dmg`,
  `OpenPets-${version}-mac-x64.zip`,
  `OpenPets-${version}-mac-arm64.zip`,
  `OpenPets-${version}-linux-x86_64.AppImage`,
  `OpenPets-${version}-linux-amd64.deb`,
  `OpenPets-${version}-linux-x86_64.rpm`,
  `OpenPets-${version}-linux-x64.tar.gz`,
]);
const requiredFinalArtifactNames = new Set([...requiredPreSigningArtifactNames, expectedWindowsInstaller]);
const optionalExperimentalArtifactNames = new Set([`OpenPets-${version}-linux-arm64.AppImage`]);

main();

function main() {
  if (resetState) {
    clearState();
    return;
  }

  const head = commandOutput("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).trim();
  const state = loadState(head);
  const context = { head, previousTag: "", uploadArtifacts: [] };
  const stages = createStagePlan(context, state);

  if (fromStage) invalidateFromStage(stages, state, fromStage);
  if (showStatus) {
    printStatus(stages, state);
    return;
  }

  preflight(state);
  context.previousTag = findPreviousReleaseTag(head, resume || isStageComplete(state, "tag"));

  console.log(`\nStaged release plan for ${tag} (${stages.length} stages):`);
  for (const [index, stage] of stages.entries()) {
    const done = !stage.alwaysRun && isStageComplete(state, stage.id) && outputsIntact(state.stages[stage.id]);
    console.log(`  ${String(index + 1).padStart(2, " ")}. ${done ? "done   " : "pending"} ${stage.id} — ${stage.title}`);
  }
  console.log(`\nCheckpoint file: ${relative(repoRoot, statePath)}`);

  runStages(stages, state);

  if (dryRun) {
    console.log(`\nDry run complete. No tag, SignPath signing, GitHub release, or publication was performed for ${tag}.`);
    console.log("SignPath's Windows installer is deliberately absent from this local preview and was not exposed publicly.");
    return;
  }
  if (!yes) {
    console.log("\nLocal pre-signing artifacts are built and checkpointed.");
    console.log("Re-run the same command with --yes to tag, sign, and publish; completed stages will be skipped.");
    return;
  }
  console.log(`\nPublished release created: https://github.com/${repository}/releases/tag/${tag}`);
  console.log("Published releases are visible to the app update checker.");
  console.log(`Checkpoint retained at ${relative(repoRoot, statePath)}; remove it with --reset once the release is verified.`);
}

function createStagePlan(context, state) {
  const stages = [];
  const artifactPath = (name) => join(outputDir, name);

  if (!skipChecks) {
    stages.push({
      id: "checks",
      title: "Workspace build and desktop checks",
      run: () => {
        run("pnpm", ["build"], { cwd: repoRoot });
        run("pnpm", ["--filter", "@open-pets/desktop", "check"], { cwd: repoRoot });
        return [];
      },
    });
  }

  stages.push({
    id: "clean",
    title: "Clean apps/desktop/dist-electron",
    run: () => {
      run("node", ["scripts/clean-package-output.cjs"], { cwd: desktopDir });
      mkdirSync(outputDir, { recursive: true });
      return [];
    },
  });

  for (const build of createBuildPlan()) {
    stages.push({
      id: build.id,
      title: build.name,
      run: () => {
        run("pnpm", ["exec", "electron-builder", ...build.args, "--publish", "never"], { cwd: desktopDir });
        const outputs = build.outputs.map(artifactPath);
        for (const output of outputs) requireBuiltArtifact(output, build.name, build.minimumBytes);
        return outputs;
      },
    });
  }

  if (linuxPackageDir) {
    stages.push({
      id: "stage:linux-packages",
      title: `Copy validated Linux DEB/RPM from ${linuxPackageDir}`,
      run: () => copyLinuxPackageArtifacts(),
    });
  }

  stages.push({
    id: "verify:local",
    title: "Verify the working tree and the local pre-signing artifact set",
    alwaysRun: true,
    run: () => {
      const postBuildStatus = getGitStatusIgnoringPackageOutput();
      if (postBuildStatus) throw new Error(`Build/checks changed tracked or source files. Commit or revert them before releasing.\n${postBuildStatus}`);
      const localArtifacts = collectArtifacts(outputDir);
      validateArtifactSet(localArtifacts, "local pre-signing build", requiredPreSigningArtifactNames);
      console.log("\nLocal pre-signing artifacts (the Windows installer is deliberately supplied only by SignPath):");
      for (const artifact of localArtifacts) console.log(`- ${relative(repoRoot, artifact)}`);
      return [];
    },
  });

  if (dryRun) {
    stages.push({
      id: "preview:checksums",
      title: "Write SHA256SUMS.local-preview for the local artifacts",
      alwaysRun: true,
      run: () => {
        const checksumsPath = writeChecksums(collectArtifacts(outputDir), "SHA256SUMS.local-preview");
        console.log(`- ${relative(repoRoot, checksumsPath)}`);
        return [];
      },
    });
    return stages;
  }

  if (!yes) return stages;

  stages.push({
    id: "tag",
    title: `Create and push the annotated tag ${tag}`,
    run: () => {
      createAndPushTag(context.head);
      return [];
    },
  });

  stages.push({
    id: "sign:dispatch",
    title: "Dispatch the SignPath Windows workflow and record its run id",
    run: () => {
      const priorRunIds = new Set(
        listSignPathRuns()
          .filter((runInfo) => runInfo.event === "workflow_dispatch" && runInfo.headSha === context.head && (!runInfo.headBranch || runInfo.headBranch === tag))
          .map((runInfo) => String(runInfo.databaseId)),
      );
      const dispatchedAt = Date.now();
      dispatchSignPathWorkflow(tag);
      const runInfo = findDispatchedSignPathRun(context.head, tag, dispatchedAt, priorRunIds);
      state.signPath = { runId: String(runInfo.databaseId), url: runInfo.url || "", headSha: context.head };
      console.log(`\nSignPath workflow run ${state.signPath.runId} dispatched${state.signPath.url ? ` (${state.signPath.url})` : ""}.`);
      console.log("This run id is checkpointed; a later resume re-attaches to it instead of dispatching a second signing run.");
      return [];
    },
  });

  stages.push({
    id: "sign:collect",
    title: "Wait for SignPath and collect the signed Windows installer",
    run: () => {
      const signPath = state.signPath;
      if (!signPath || !signPath.runId) {
        throw new Error("No dispatched SignPath run is recorded in the checkpoint. Re-run with --from sign:dispatch.");
      }
      if (signPath.headSha !== context.head) {
        throw new Error(`The checkpointed SignPath run was dispatched for ${signPath.headSha}, not HEAD ${context.head}. Re-run with --from sign:dispatch.`);
      }
      waitForSignPathRunCompletion(signPath.runId, context.head);
      const signedArtifactDir = mkdtempSync(join(tmpdir(), `openpets-signpath-${version}-`));
      try {
        downloadSignedWindowsArtifact(signPath.runId, signedArtifactDir);
        installSignedWindowsInstaller(signedArtifactDir);
      } finally {
        rmSync(signedArtifactDir, { recursive: true, force: true });
      }
      return [join(outputDir, expectedWindowsInstaller)];
    },
  });

  stages.push({
    id: "verify:final",
    title: "Validate the signed artifact set and write SHA256SUMS",
    alwaysRun: true,
    run: () => {
      const finalArtifacts = collectArtifacts(outputDir);
      validateArtifactSet(finalArtifacts, "signed release", requiredFinalArtifactNames);
      requireFile(join(outputDir, expectedWindowsInstaller), "signed Windows NSIS installer");
      const checksumsPath = writeChecksums(finalArtifacts);
      context.uploadArtifacts = [...finalArtifacts, checksumsPath];
      console.log("\nFinal release artifacts:");
      for (const artifact of context.uploadArtifacts) console.log(`- ${relative(repoRoot, artifact)}`);
      return [];
    },
  });

  stages.push({
    id: "release:draft",
    title: `Create or refresh the draft GitHub release ${tag}`,
    run: () => {
      ensureDraftRelease(context.head, context.previousTag);
      return [];
    },
  });

  stages.push({
    id: "release:upload",
    title: "Upload missing release assets and verify the exact remote asset set",
    alwaysRun: true,
    run: () => {
      uploadReleaseAssets(context.uploadArtifacts);
      return [];
    },
  });

  stages.push({
    id: "release:publish",
    title: `Publish the GitHub release ${tag}`,
    run: () => {
      run("gh", ["release", "edit", tag, "--repo", repository, "--draft=false"], { cwd: repoRoot });
      const publishedRelease = getReleaseDetails();
      if (!publishedRelease || publishedRelease.isDraft) throw new Error(`GitHub release ${tag} was not published after asset verification.`);
      return [];
    },
  });

  return stages;
}

function runStages(stages, state) {
  const total = stages.length;
  for (const [index, stage] of stages.entries()) {
    const label = `[stage ${index + 1}/${total}] ${stage.id}`;
    const record = state.stages[stage.id];
    const reusable = !stage.alwaysRun && Boolean(record);

    if (reusable && outputsIntact(record)) {
      console.log(`\n${label} — already completed at ${record.completedAt}; skipping.`);
      continue;
    }
    if (reusable) {
      console.log(`\n${label} — checkpointed outputs are missing or changed; re-running.`);
    }
    console.log(`\n${label} — ${stage.title}`);

    let outputs;
    try {
      outputs = stage.run() || [];
    } catch (error) {
      reportStageFailure(stage, error);
      throw error;
    }

    state.stages[stage.id] = { completedAt: new Date().toISOString(), outputs: describeOutputs(outputs) };
    saveState(state);
  }
}

function reportStageFailure(stage, error) {
  console.error(`\nRelease stage "${stage.id}" failed: ${error.message}`);
  console.error(`Earlier stages stay checkpointed in ${relative(repoRoot, statePath)}.`);
  console.error("Fix the cause, then re-run the same command; the release resumes at this stage.");
  console.error(`To force this stage and everything after it to re-run anyway, add --from ${stage.id}.`);
}

function printStatus(stages, state) {
  console.log(`Release checkpoint for ${tag}`);
  console.log(`  file: ${relative(repoRoot, statePath)}`);
  console.log(`  head: ${state.head}`);
  console.log(`  options: includeExperimentalArm=${state.options.includeExperimentalArm}, linuxPackageDir=${state.options.linuxPackageDir || "none"}`);
  if (state.signPath) console.log(`  signPath run: ${state.signPath.runId}${state.signPath.url ? ` (${state.signPath.url})` : ""}`);
  console.log("\nStages:");
  for (const [index, stage] of stages.entries()) {
    const record = state.stages[stage.id];
    let status = "pending";
    if (stage.alwaysRun) status = "always";
    else if (record && outputsIntact(record)) status = "done";
    else if (record) status = "stale";
    const when = record ? ` (${record.completedAt})` : "";
    console.log(`  ${String(index + 1).padStart(2, " ")}. ${status.padEnd(7, " ")} ${stage.id} — ${stage.title}${when}`);
  }
  const unknown = Object.keys(state.stages).filter((id) => !stages.some((stage) => stage.id === id));
  if (unknown.length > 0) console.log(`\nCheckpointed stages outside the current plan: ${unknown.join(", ")}`);
}

function invalidateFromStage(stages, state, requestedStage) {
  const startIndex = stages.findIndex((stage) => stage.id === requestedStage);
  if (startIndex === -1) {
    throw new Error(`Unknown stage id for --from: ${requestedStage}. Known stages: ${stages.map((stage) => stage.id).join(", ")}`);
  }
  const invalidated = stages.slice(startIndex).map((stage) => stage.id);
  let changed = false;
  for (const id of invalidated) {
    if (state.stages[id]) {
      delete state.stages[id];
      changed = true;
    }
  }
  if (invalidated.includes("sign:dispatch") && state.signPath) {
    delete state.signPath;
    changed = true;
  }
  if (changed) {
    saveState(state);
    console.log(`Invalidated checkpointed stages from ${requestedStage} onward: ${invalidated.join(", ")}`);
  } else {
    console.log(`No checkpointed stages to invalidate from ${requestedStage} onward.`);
  }
}

function loadState(head) {
  const fresh = { schema: stateSchema, version, tag, head, options: currentOptions(), stages: {} };
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return fresh;
  }

  if (raw.schema !== stateSchema || raw.version !== version) {
    console.log(`Existing release checkpoint is for a different version or format; starting a new checkpoint for ${tag}.`);
    return fresh;
  }
  if (raw.head !== head) {
    console.log(`HEAD moved since the last checkpoint (${String(raw.head).slice(0, 7)} -> ${head.slice(0, 7)}); starting a new checkpoint for ${tag}.`);
    return fresh;
  }

  const state = { ...fresh, stages: raw.stages && typeof raw.stages === "object" ? raw.stages : {} };
  if (raw.signPath) state.signPath = raw.signPath;
  if (JSON.stringify(raw.options || {}) !== JSON.stringify(state.options)) {
    console.log("Build options changed since the last checkpoint; the output directory will be cleaned and every build stage re-run.");
    delete state.stages.clean;
  }
  return state;
}

function currentOptions() {
  return { includeExperimentalArm, linuxPackageDir };
}

function saveState(state) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function clearState() {
  try {
    unlinkSync(statePath);
  } catch {
    console.log(`No release checkpoint to remove for ${tag}.`);
    return;
  }
  console.log(`Removed release checkpoint ${relative(repoRoot, statePath)}. The next run rebuilds every stage.`);
}

function isStageComplete(state, stageId) {
  const record = state.stages[stageId];
  return Boolean(record) && outputsIntact(record);
}

function describeOutputs(outputs) {
  return outputs.map((filePath) => ({ name: relative(repoRoot, filePath), size: statSync(filePath).size }));
}

function outputsIntact(record) {
  if (!record) return false;
  for (const output of record.outputs || []) {
    let stat;
    try {
      stat = statSync(join(repoRoot, output.name));
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size !== output.size) return false;
  }
  return true;
}

function requireBuiltArtifact(filePath, stageName, minimumBytes) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    throw new Error(`${stageName} did not produce ${basename(filePath)} in ${relative(repoRoot, outputDir)}.`);
  }
  if (!stat.isFile()) throw new Error(`${stageName} produced a non-file at ${filePath}.`);
  if (minimumBytes && stat.size < minimumBytes) {
    throw new Error(`${stageName} produced an implausibly small ${basename(filePath)} (${stat.size} bytes; minimum ${minimumBytes}). See the Linux DEB/RPM fallback in docs/release.md.`);
  }
}

function preflight(state) {
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
  const tagAlreadyCreated = resume || isStageComplete(state, "tag");

  if (tagAlreadyCreated) {
    if (!localTagExists || !remoteTagCommit) {
      throw new Error(`Resuming a tagged release requires both local and origin ${tag} tags. If tag pushing failed, push it manually, then retry.`);
    }
    assertTagAtHead(localTagExists, remoteTagCommit);
    if (release && !release.isDraft) throw new Error(`GitHub release ${tag} is already published; the release script refuses to modify published releases.`);
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

function getSignPathRun(runId) {
  return JSON.parse(
    commandOutput("gh", ["run", "view", String(runId), "--repo", repository, "--json", "databaseId,headSha,status,conclusion,url"], { cwd: repoRoot }),
  );
}

function findDispatchedSignPathRun(target, ref, dispatchedAt, priorRunIds) {
  const deadline = Date.now() + signPathDiscoveryTimeoutMs;
  let lastError = "the run list was not available";

  while (Date.now() < deadline) {
    try {
      const candidates = listSignPathRuns()
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
      if (candidates[0]) return candidates[0];
      console.log("The dispatched SignPath workflow run is not visible yet; waiting...");
    } catch (error) {
      lastError = error.message;
      console.log(`Could not inspect the SignPath workflow run list yet: ${error.message}`);
    }
    sleepSync(Math.min(signPathPollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  throw new Error(`Timed out locating the dispatched SignPath workflow run for ${ref}. Last error: ${lastError}`);
}

function waitForSignPathRunCompletion(runId, target) {
  const deadline = Date.now() + signPathTimeoutMs;
  let lastError = "the run was not available";
  console.log(`\nWaiting for SignPath workflow run ${runId}. Manual approval may be required in the SignPath dashboard.`);

  while (Date.now() < deadline) {
    try {
      const runInfo = getSignPathRun(runId);
      if (runInfo.headSha !== target) {
        throw new Error(`SignPath workflow run ${runId} was built from ${runInfo.headSha}, not HEAD ${target}. Re-run with --from sign:dispatch.`);
      }
      const url = runInfo.url ? ` (${runInfo.url})` : "";
      if (runInfo.status === "completed") {
        if (runInfo.conclusion === "success") return runInfo;
        throw new Error(
          `SignPath workflow run ${runId} finished with conclusion ${runInfo.conclusion || "unknown"}${url}. Fix the cause, then re-run with --from sign:dispatch to start a fresh signing run.`,
        );
      }
      console.log(`SignPath workflow run ${runId} is ${runInfo.status || "unknown"}; still waiting${url}.`);
    } catch (error) {
      if (error.message.startsWith("SignPath workflow run ")) throw error;
      lastError = error.message;
      console.log(`Could not inspect SignPath workflow run ${runId} yet: ${error.message}`);
    }
    sleepSync(Math.min(signPathPollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  throw new Error(`Timed out waiting for SignPath workflow run ${runId}. Last error: ${lastError}`);
}

function downloadSignedWindowsArtifact(runId, destination) {
  if (!runId) throw new Error(`The SignPath workflow did not provide a run ID for ${tag}.`);
  run("gh", ["run", "download", String(runId), "--repo", repository, "--name", signedWindowsArtifact, "--dir", destination], { cwd: repoRoot });
}

function installSignedWindowsInstaller(signedArtifactDir) {
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

function uploadReleaseAssets(uploadArtifacts) {
  if (uploadArtifacts.length === 0) throw new Error("No release artifacts were prepared for upload.");
  const release = getReleaseDetails();
  if (!release || !release.isDraft) throw new Error(`Expected a draft GitHub release ${tag} before uploading assets.`);

  const expectedNames = new Set(uploadArtifacts.map((artifact) => basename(artifact)));
  for (const asset of release.assets || []) {
    if (!expectedNames.has(asset.name)) {
      run("gh", ["release", "delete-asset", tag, asset.name, "--repo", repository, "--yes"], { cwd: repoRoot });
    }
  }

  const remoteAssets = new Map((release.assets || []).map((asset) => [asset.name, asset]));
  const pending = uploadArtifacts.filter((artifact) => {
    const asset = remoteAssets.get(basename(artifact));
    if (!asset || asset.state !== "uploaded") return true;
    if (Number(asset.size) !== statSync(artifact).size) return true;
    console.log(`- ${basename(artifact)} is already uploaded (${asset.size} bytes); skipping.`);
    return false;
  });

  if (pending.length === 0) console.log("Every release asset is already uploaded; only verification remains.");
  for (const [index, artifact] of pending.entries()) {
    console.log(`\nUploading asset ${index + 1}/${pending.length}: ${basename(artifact)}`);
    run("gh", ["release", "upload", tag, "--repo", repository, artifact, "--clobber"], { cwd: repoRoot });
  }

  verifyReleaseAssets(uploadArtifacts);
}

function verifyReleaseAssets(uploadArtifacts) {
  const release = getReleaseDetails();
  if (!release || !release.isDraft) throw new Error(`Expected a draft GitHub release ${tag} while verifying assets.`);
  const expectedNames = uploadArtifacts.map((artifact) => basename(artifact)).sort();
  const actualNames = (release.assets || []).map((asset) => asset.name).sort();
  if (expectedNames.length !== actualNames.length || expectedNames.some((name, index) => name !== actualNames[index])) {
    throw new Error(`GitHub release ${tag} asset mismatch. Expected exactly [${expectedNames.join(", ")}], found [${actualNames.join(", ")}].`);
  }
  const incomplete = (release.assets || []).filter((asset) => asset.state !== "uploaded").map((asset) => asset.name);
  if (incomplete.length > 0) throw new Error(`GitHub release ${tag} has assets that are not fully uploaded: ${incomplete.join(", ")}.`);
}

function createBuildPlan() {
  const plan = [
    { id: "build:mac-dmg", name: "macOS DMG x64 + arm64", args: ["--mac", "dmg", "--x64", "--arm64"], outputs: [`OpenPets-${version}-mac-x64.dmg`, `OpenPets-${version}-mac-arm64.dmg`] },
    { id: "build:mac-zip", name: "macOS ZIP x64 + arm64", args: ["--mac", "zip", "--x64", "--arm64"], outputs: [`OpenPets-${version}-mac-x64.zip`, `OpenPets-${version}-mac-arm64.zip`] },
    { id: "build:linux-appimage", name: "Linux AppImage x64", args: ["--linux", "AppImage", "--x64"], outputs: [`OpenPets-${version}-linux-x86_64.AppImage`] },
  ];
  if (!linuxPackageDir) {
    plan.push({
      id: "build:linux-deb",
      name: "Linux DEB x64",
      args: ["--linux", "deb", "--x64"],
      outputs: [`OpenPets-${version}-linux-amd64.deb`],
      minimumBytes: minimumLinuxPackageBytes,
    });
    plan.push({
      id: "build:linux-rpm",
      name: "Linux RPM x64",
      args: ["--linux", "rpm", "--x64"],
      outputs: [`OpenPets-${version}-linux-x86_64.rpm`],
      minimumBytes: minimumLinuxPackageBytes,
    });
  }
  plan.push({ id: "build:linux-targz", name: "Linux tar.gz x64", args: ["--linux", "tar.gz", "--x64"], outputs: [`OpenPets-${version}-linux-x64.tar.gz`] });
  if (includeExperimentalArm) {
    plan.push({ id: "build:arm-win-nsis", name: "Windows NSIS arm64 (disposable, never published)", args: ["--win", "nsis", "--arm64"], outputs: [] });
    plan.push({ id: "build:arm-linux-appimage", name: "Linux AppImage arm64 (experimental)", args: ["--linux", "AppImage", "--arm64"], outputs: [`OpenPets-${version}-linux-arm64.AppImage`] });
  }
  return plan;
}

function copyLinuxPackageArtifacts() {
  if (!linuxPackageDir) return [];

  let directoryStat;
  try {
    directoryStat = lstatSync(linuxPackageDir);
  } catch {
    throw new Error(`Linux package staging directory does not exist: ${linuxPackageDir}`);
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Linux package staging path must be a real directory: ${linuxPackageDir}`);
  }

  const copied = [];
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
    const destinationPath = join(outputDir, name);
    copyFileSync(sourcePath, destinationPath);
    copied.push(destinationPath);
  }
  return copied;
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

function validateArtifactSet(artifacts, stage, requiredArtifactNames) {
  const actualNames = new Set(artifacts.map((artifact) => basename(artifact)));
  const missing = [...requiredArtifactNames].filter((name) => !actualNames.has(name));
  const unexpected = [...actualNames].filter(
    (name) => !requiredArtifactNames.has(name) && !(includeExperimentalArm && optionalExperimentalArtifactNames.has(name)),
  );
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Incomplete ${stage} artifact set for ${version}. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`,
    );
  }
}

function writeChecksums(artifacts, fileName = "SHA256SUMS") {
  const lines = artifacts.map((artifact) => `${sha256(artifact)}  ${basename(artifact)}`);
  const checksumsPath = join(outputDir, fileName);
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
    .filter((line) => line.trim() && !line.includes("apps/desktop/dist-electron/") && !line.includes("apps/desktop/.release-state/"))
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
  console.log(`Usage: pnpm release:desktop -- --yes

Runs the desktop release as a sequence of checkpointed stages. Each stage that
succeeds is recorded in apps/desktop/.release-state/v<version>.json, so a failed
run is retried by re-running the same command: completed stages are skipped and
work resumes at the stage that failed.

Stages (default plan):
  checks                  pnpm build + desktop check
  clean                   clean apps/desktop/dist-electron
  build:mac-dmg           macOS DMG x64 + arm64
  build:mac-zip           macOS ZIP x64 + arm64
  build:linux-appimage    Linux AppImage x64
  build:linux-deb         Linux DEB x64
  build:linux-rpm         Linux RPM x64
  build:linux-targz       Linux tar.gz x64
  verify:local            working-tree check + pre-signing artifact set
  tag                     create and push the annotated v<version> tag
  sign:dispatch           dispatch the SignPath workflow, record its run id
  sign:collect            wait for that run, download and verify the signed installer
  verify:final            validate the signed artifact set, write SHA256SUMS
  release:draft           create or refresh the draft GitHub release
  release:upload          upload only the assets GitHub is missing, then verify
  release:publish         publish the verified draft

The Windows x64 installer is never built locally; it is produced by SignPath.

Options:
  --yes                       run the full staged release: build, tag, sign, publish
  --status                    print the stage plan and checkpoint state, then exit
  --from <stage>              force <stage> and every later stage to re-run
  --reset                     delete the checkpoint for this version, then exit
  --resume                    legacy alias for resuming a tagged HEAD without a checkpoint
  --linux-package-dir <dir>   use validated Ubuntu-built DEB/RPM files from an absolute staging directory
  --skip-checks               skip pnpm build and desktop check (incompatible with --yes)
  --include-experimental-arm  also build optional Windows/Linux ARM64 targets; Windows ARM is never published
  --dry-run                   discouraged: builds everything locally, then throws the work away
                              without tagging or publishing. The staged checkpoint already
                              gives you safe retries, so run --yes directly instead.

Without --yes or --dry-run, the script runs the build stages only and stops
before tagging, so you can inspect artifacts and then re-run with --yes.
`);
}
