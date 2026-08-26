#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

import { allowedReactions, createOpenPetsClient, OpenPetsClientError, type OpenPetsPetListItem, type OpenPetsReaction } from "@open-pets/client";
import { claudeHookEvents, doctorClaudeHooks, openPetsHookMarker, removeOpenPetsHooks, runClaudeHookFromStdin, validateOpenPetsPetArg } from "@open-pets/claude";
import { buildCursorRulesPreview, buildOpenPetsOnlyPreview, classifyCursorMcpStatus, classifyCursorRulesStatus, executeCursorMcpWrite, executeCursorRulesWrite, getCursorProjectMcpPath, getCursorProjectRulesPath, planCursorMcpInstall, planCursorMcpReplace, planCursorRulesInstall, planCursorRulesRemove, planCursorRulesReplace, readCursorMcpConfig, readCursorOpenPetsRules } from "@open-pets/cursor";
import { prepareOpenCodeProjectSetup, writePreparedOpenCodeProjectSetup } from "@open-pets/opencode";
import { buildOpenClawCommand, classifyOpenClawStatus, openClawMaxStructuredOutputBytes, parseOpenClawVersion, planOpenClawMutation, type OpenClawCommandAction, type OpenClawPluginStatus } from "@open-pets/openclaw/management";

import { pluginTemplateNames, pluginTemplates, type PluginTemplateName } from "./plugin-templates.js";
import { validatePluginFolder } from "./plugin-validate.js";

export const cliPackageName = "@open-pets/cli";

interface ConfigureOptions {
  readonly agent: "claude" | "opencode" | "cursor" | "openclaw";
  readonly petId?: string;
  readonly cwd: string;
  readonly yes: boolean;
  readonly force: boolean;
  readonly localDev: boolean;
  readonly cursorRulesMode?: "with" | "only" | "remove";
}

interface InstallOptions {
  readonly petId?: string;
  readonly fromZip?: string;
  readonly fromFolder?: string;
}

interface ReactOptions {
  readonly reaction: OpenPetsReaction;
}

interface SayOptions {
  readonly message: string;
  readonly reaction?: OpenPetsReaction;
}

interface DoctorOptions {
  readonly cwd: string;
  readonly json: boolean;
}

interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
}

interface BoundedProcessResult {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly overflow: boolean;
}

interface BoundedOutput {
  readonly value: string;
  readonly overflow: boolean;
}

interface PluginNewOptions {
  readonly name: string;
  readonly id: string;
  readonly dir: string;
  readonly author?: string;
  readonly template: PluginTemplateName;
}

interface PreparedHooks {
  readonly settingsPath: string;
  readonly settings: Record<string, unknown>;
}

interface ConfiguredPet {
  readonly id: string;
  readonly displayName: string;
}

const require = createRequire(import.meta.url);

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (command === "configure") {
    if (hasHelp(args)) {
      printConfigureUsage();
      return;
    }
    await configureProject(parseConfigureArgs(args));
    return;
  }
  if (command === "install") {
    if (hasHelp(args)) {
      printInstallUsage();
      return;
    }
    await installPetFromCatalog(parseInstallArgs(args));
    return;
  }
  if (command === "status") {
    if (hasHelp(args)) {
      printStatusUsage();
      return;
    }
    await showStatus(args);
    return;
  }
  if (command === "pets") {
    if (hasHelp(args)) {
      printPetsUsage();
      return;
    }
    await showPets(args);
    return;
  }
  if (command === "doctor") {
    if (hasHelp(args)) {
      printDoctorUsage();
      return;
    }
    await runDoctor(parseDoctorArgs(args));
    return;
  }
  if (command === "react") {
    if (hasHelp(args)) {
      printReactUsage();
      return;
    }
    await sendReaction(parseReactArgs(args));
    return;
  }
  if (command === "say") {
    if (hasHelp(args)) {
      printSayUsage();
      return;
    }
    await sendMessage(parseSayArgs(args));
    return;
  }
  if (command === "mcp") {
    if (hasHelp(args)) {
      printMcpUsage();
      return;
    }
    await runMcp(args);
    return;
  }
  if (command === "hook") {
    if (hasHelp(args)) {
      printHookUsage();
      return;
    }
    const code = await runClaudeHookFromStdin(process.stdin, { configuredPetId: readPetArg(args), projectLocal: hasProjectLocalArg(args), debug: process.env.OPENPETS_DEBUG === "1" });
    process.exitCode = code;
    return;
  }
  if (command === "plugin") {
    const [subcommand, ...rest] = args;
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      printPluginUsage();
      return;
    }
    if (subcommand === "new" || subcommand === "init") {
      if (hasHelp(rest)) {
        printPluginUsage();
        return;
      }
      scaffoldPlugin(parsePluginNewArgs(rest));
      return;
    }
    if (subcommand === "validate") {
      if (hasHelp(rest)) {
        printPluginUsage();
        return;
      }
      const target = rest.find((arg) => !arg.startsWith("--")) ?? ".";
      const result = validatePluginFolder(target);
      if (result.ok) {
        process.stdout.write(`Plugin manifest and declared files look valid: ${resolve(target)}\n`);
        return;
      }
      process.stderr.write(`Plugin validation failed (${result.issues.length} issue${result.issues.length === 1 ? "" : "s"}):\n`);
      for (const issue of result.issues) process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw new CliError(`Unknown plugin subcommand: ${subcommand}`);
  }
  throw new CliError(`Unknown command: ${command}`);
}

async function installPetFromCatalog(options: InstallOptions): Promise<void> {
  const client = createOpenPetsClient({ responseTimeoutMs: 60_000 });
  if (options.petId !== undefined) {
    const result = await client.installPet(options.petId);
    process.stdout.write(`Installed OpenPets pet: ${sanitizeTerminalText(result.displayName)} (${result.petId})\n`);
  } else {
    const path = options.fromZip ?? options.fromFolder;
    if (path === undefined) {
      throw new CliError("Missing install path.");
    }
    const absPath = resolve(path);
    const result = await client.installLocalPet(absPath, { kind: options.fromZip !== undefined ? "zip" : "folder" });
    process.stdout.write(`Installed OpenPets pet: ${sanitizeTerminalText(result.displayName)} (${result.petId})\n`);
  }
}

async function showStatus(args: readonly string[]): Promise<void> {
  if (args.length !== 0) throw new CliError(`Unknown status option: ${args[0]}`);
  const result = await createOpenPetsClient().status();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok || !result.appRunning) process.exitCode = 1;
}

export function parseDoctorArgs(args: readonly string[]): DoctorOptions {
  let cwd = process.cwd();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--cwd") { cwd = readRequiredArg(args, index, "--cwd"); index += 1; }
    else if (arg.startsWith("--cwd=")) cwd = arg.slice("--cwd=".length);
    else throw new CliError(`Unknown doctor option: ${arg}`);
  }
  return { cwd, json };
}

export async function runDoctor(options: DoctorOptions): Promise<void> {
  const claude = doctorClaudeHooks();

  const projectDir = resolveProjectDir(options.cwd);
  const cursorConfigPath = getCursorProjectMcpPath(projectDir);
  const cursorRead = readCursorMcpConfig(cursorConfigPath);
  const cursor = classifyCursorMcpStatus(cursorRead, cursorConfigPath, { mcpVersion: getPackageVersion() });

  const appStatus = await createOpenPetsClient().status();
  const app = { running: appStatus.appRunning, reason: appStatus.unavailableReason };

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      claude: { status: claude.status, settingsPath: claude.settingsPath, asyncSupported: claude.asyncSupported },
      cursor: { status: cursor.status, configPath: cursor.configPath },
      app,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`Claude hooks: ${claude.status} (${claude.settingsPath})\n`);
    process.stdout.write(`Cursor MCP: ${cursor.status} (${cursor.configPath})\n`);
    process.stdout.write(`OpenPets app: ${app.running ? "running" : `not running${app.reason ? ` (${app.reason})` : ""}`}\n`);
  }

  if (claude.status === "error" || cursor.status === "error" || cursor.status === "invalid") process.exitCode = 1;
}

async function showPets(args: readonly string[]): Promise<void> {
  if (args.length !== 0) throw new CliError(`Unknown pets option: ${args[0]}`);
  const result = await createOpenPetsClient().listPets();
  for (const pet of result.pets) {
    const flags = [pet.id === result.defaultPetId ? "default" : undefined, pet.broken ? "broken" : undefined].filter(Boolean).join(", ");
    process.stdout.write(`${sanitizeTerminalText(pet.displayName)} (${pet.id})${flags ? ` [${flags}]` : ""}\n`);
  }
}

async function sendReaction(options: ReactOptions): Promise<void> {
  await createOpenPetsClient().react(options.reaction);
  process.stdout.write(`OpenPets reaction sent: ${options.reaction}\n`);
}

async function sendMessage(options: SayOptions): Promise<void> {
  await createOpenPetsClient().say(options.message, options.reaction ? { reaction: options.reaction } : undefined);
  process.stdout.write("OpenPets message sent.\n");
}

export async function configureProject(options: ConfigureOptions): Promise<void> {
  if (options.agent === "openclaw") {
    await configureOpenClawGlobal();
    return;
  }
  const projectDir = resolveProjectDir(options.cwd);
  if (options.agent === "cursor") {
    await configureCursorProject(options, projectDir);
    return;
  }
  if (options.agent === "opencode") {
    await configureOpenCodeProject(options, projectDir);
    return;
  }
  assertClaudeAvailable();
  assertSafeProjectHookPath(projectDir);
  const client = createOpenPetsClient();
  const selectedPet = await resolveConfiguredPet(client, options.petId);
  const petId = selectedPet.id;
  const packageVersion = getPackageVersion();
  const mcpCommand = options.localDev ? createLocalDevCliCommand(["mcp", "--pet", petId]) : createVersionPinnedCliCommand(packageVersion, ["mcp", "--pet", petId]);
  const hookCommand = formatShellCommand(options.localDev ? createLocalDevCliCommand(["hook", openPetsHookMarker, "--project-local", "--pet", petId]) : createVersionPinnedCliCommand(packageVersion, ["hook", openPetsHookMarker, "--project-local", "--pet", petId]));
  const mcpConfig = { type: "stdio", command: mcpCommand.command, args: mcpCommand.args, env: {} };
  const preparedHooks = prepareProjectLocalHooks(projectDir, hookCommand);
  runClaudeMcpAddJson(projectDir, mcpConfig, options.force);
  writePreparedHooks(preparedHooks);
  process.stdout.write(`OpenPets configured for Claude in ${projectDir}.\nPet: ${sanitizeTerminalText(selectedPet.displayName)} (${selectedPet.id})\n`);
}

async function configureCursorProject(options: ConfigureOptions, projectDir: string): Promise<void> {
  const configPath = getCursorProjectMcpPath(projectDir);
  const rulesPath = getCursorProjectRulesPath(projectDir);

  if (options.cursorRulesMode === "only") {
    configureCursorRulesOnly(projectDir, rulesPath, options.force);
    return;
  }

  if (options.cursorRulesMode === "remove") {
    removeCursorRulesOnly(projectDir, rulesPath);
    return;
  }

  const client = createOpenPetsClient();
  const selectedPet = await resolveConfiguredPet(client, options.petId);
  const packageVersion = getPackageVersion();
  const previewOptions = { mcpVersion: packageVersion, petId: selectedPet.id, commandMode: options.localDev ? "local" as const : "published" as const, mcpEntryPath: options.localDev ? require.resolve("@open-pets/mcp") : undefined };
  const readResult = readCursorMcpConfig(configPath);
  const status = classifyCursorMcpStatus(readResult, configPath, previewOptions);
  process.stdout.write(`Cursor config: ${configPath}\nStatus: ${status.status} - ${status.message}\nOpenPets MCP preview:\n${JSON.stringify(buildOpenPetsOnlyPreview(previewOptions), null, 2)}\n`);

  const rulesRequested = options.cursorRulesMode === "with";
  const rulesReadResult = rulesRequested ? readCursorOpenPetsRules(projectDir) : undefined;
  const rulesStatus = rulesReadResult ? classifyCursorRulesStatus(rulesReadResult, rulesPath) : undefined;
  if (rulesStatus) {
    process.stdout.write(`Cursor rules: ${rulesPath}\nRules status: ${rulesStatus.status} - ${rulesStatus.message}\nOpenPets rules preview:\n${buildCursorRulesPreview()}\n`);
  }

  if (status.status === "installed" && (!rulesRequested || rulesStatus?.status === "installed")) {
    process.stdout.write(`OpenPets is already configured for Cursor in ${projectDir}.\nRestart or reload Cursor or start a new chat in this project to load OpenPets.\n`);
    return;
  }
  if (status.status === "invalid" || status.status === "error") {
    throw new CliError(`${status.message} Fix ${configPath}, then rerun setup.`);
  }
  if (status.status === "conflict" && !options.force) {
    throw new CliError(`Cursor already has a non-OpenPets openpets MCP entry. Rerun with --force to replace only mcpServers.openpets.`);
  }
  if (rulesStatus && (rulesStatus.status === "invalid" || rulesStatus.status === "error")) {
    throw new CliError(`${rulesStatus.message} Fix ${rulesPath}, then rerun setup.`);
  }
  if (rulesStatus?.status === "conflict" && !options.force) {
    throw new CliError("Cursor already has .cursor/rules/openpets.mdc with user content. Rerun with --force to replace only that file.");
  }

  const plan = status.status === "installed" ? undefined : status.status === "conflict" ? planCursorMcpReplace(configPath, previewOptions) : planCursorMcpInstall(configPath, previewOptions, options.force);
  if (plan && "ok" in plan) throw new CliError(plan.message);
  const rulesPlan = rulesRequested && rulesStatus?.status !== "installed" ? rulesStatus?.status === "conflict" ? planCursorRulesReplace(projectDir) : planCursorRulesInstall(projectDir, options.force) : undefined;
  if (rulesPlan && "ok" in rulesPlan) throw new CliError(rulesPlan.message);

  if (plan) executeCursorMcpWrite(plan);
  if (rulesPlan) executeCursorRulesWrite(rulesPlan);

  const backups = [plan?.backupPath ? `MCP backup: ${plan.backupPath}` : undefined, rulesPlan?.backupPath ? `Rules backup: ${rulesPlan.backupPath}` : undefined].filter(Boolean).join("\n");
  process.stdout.write(`OpenPets configured for Cursor in ${projectDir}.\nPet: ${sanitizeTerminalText(selectedPet.displayName)} (${selectedPet.id})\n${backups ? `${backups}\n` : ""}Restart or reload Cursor or start a new chat in this project to load OpenPets.\nTo remove MCP, delete mcpServers.openpets from ${configPath}. To remove rules, run with --remove-rules.\n`);
}

function configureCursorRulesOnly(projectDir: string, rulesPath: string, force: boolean): void {
  const readResult = readCursorOpenPetsRules(projectDir);
  const status = classifyCursorRulesStatus(readResult, rulesPath);
  process.stdout.write(`Cursor rules: ${rulesPath}\nRules status: ${status.status} - ${status.message}\nOpenPets rules preview:\n${buildCursorRulesPreview()}\n`);
  if (status.status === "installed") {
    process.stdout.write("OpenPets Cursor rules are already installed. Cursor may use changed rules in a new or refreshed chat.\n");
    return;
  }
  if (status.status === "invalid" || status.status === "error") throw new CliError(`${status.message} Fix ${rulesPath}, then rerun setup.`);
  if (status.status === "conflict" && !force) throw new CliError("Cursor already has .cursor/rules/openpets.mdc with user content. Rerun with --force to replace only that file.");
  const plan = status.status === "conflict" ? planCursorRulesReplace(projectDir) : planCursorRulesInstall(projectDir, force);
  if ("ok" in plan) throw new CliError(plan.message);
  executeCursorRulesWrite(plan);
  process.stdout.write(`Installed OpenPets Cursor rules in ${projectDir}.\nRules file: ${rulesPath}\n${plan.backupPath ? `Backup: ${plan.backupPath}\n` : ""}Cursor may use changed rules in a new or refreshed chat.\n`);
}

function removeCursorRulesOnly(projectDir: string, rulesPath: string): void {
  const readResult = readCursorOpenPetsRules(projectDir);
  const status = classifyCursorRulesStatus(readResult, rulesPath);
  process.stdout.write(`Cursor rules: ${rulesPath}\nRules status: ${status.status} - ${status.message}\n`);
  if (status.status === "missing") {
    process.stdout.write("OpenPets Cursor rules are already absent.\n");
    return;
  }
  if (status.status === "invalid" || status.status === "error") throw new CliError(`${status.message} Fix ${rulesPath}, then rerun setup.`);
  if (status.status === "conflict") throw new CliError("Cannot remove .cursor/rules/openpets.mdc because it is not managed by OpenPets.");
  const plan = planCursorRulesRemove(projectDir);
  if ("ok" in plan) throw new CliError(plan.message);
  executeCursorRulesWrite(plan);
  process.stdout.write(`Removed OpenPets Cursor rules from ${projectDir}.\n${plan.backupPath ? `Backup: ${plan.backupPath}\n` : ""}Cursor may use changed rules in a new or refreshed chat.\n`);
}

async function configureOpenCodeProject(options: ConfigureOptions, projectDir: string): Promise<void> {
  const client = createOpenPetsClient();
  const selectedPet = await resolveConfiguredPet(client, options.petId);
  const packageVersion = getPackageVersion();
  const prepared = prepareOpenCodeProjectSetup({ projectDir, petId: selectedPet.id, cliVersion: packageVersion, commandMode: options.localDev ? "local" : "published", cliEntryPath: options.localDev ? fileURLToPath(import.meta.url) : undefined });
  writePreparedOpenCodeProjectSetup(prepared);
  process.stdout.write(`OpenPets configured for OpenCode in ${projectDir}.\nPet: ${sanitizeTerminalText(selectedPet.displayName)} (${selectedPet.id})\nConfig: ${prepared.configPath}\nInstructions: ${prepared.instructionPath}\nWarning: .opencode config/instructions can be committed and include the selected pet id.\nRestart OpenCode in this project to load OpenPets.\n`);
}

async function configureOpenClawGlobal(): Promise<void> {
  if (process.env.OPENCLAW_NIX_MODE === "1") throw new CliError("OpenClaw management is disabled in Nix mode; install @open-pets/openclaw through Nix and enable it there.");
  const targetVersion = getWorkspacePackageVersion("@open-pets/openclaw");
  const discovered = await discoverOpenClaw();
  if (discovered.state === "installed-enabled" && discovered.installedVersion === targetVersion) {
    process.stdout.write("OpenPets is already installed and enabled in OpenClaw.\n");
    return;
  }
  const actions = planOpenClawMutation(discovered, "configure", targetVersion);
  if (actions.length === 0) throw new CliError(discovered.details);
  let current = discovered;
  for (const action of actions) {
    const result = await runOpenClawProcess(action, targetVersion);
    const refreshed = await discoverOpenClaw(true);
    if (refreshed.state === "indeterminate") throw new CliError("OpenClaw setup is indeterminate because its post-operation status could not be refreshed; inspect OpenClaw status before retrying.");
    if (!result.ok && !isOpenClawCommandAchieved(action, refreshed, targetVersion)) {
      throw new CliError(result.timedOut ? "OpenClaw setup is indeterminate because the management command timed out; inspect OpenClaw status before retrying." : `OpenClaw setup failed (${action}).`);
    }
    current = refreshed;
  }
  if (!isOpenClawEnsureComplete(current, targetVersion)) throw new CliError(`OpenClaw setup did not reach its target state: ${current.details}`);
  process.stdout.write("OpenPets is installed and enabled in OpenClaw.\n");
}

async function discoverOpenClaw(indeterminateOnFailure = false): Promise<OpenClawPluginStatus> {
  const versionResult = await runOpenClawProcess("version");
  const version = parseOpenClawVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (!versionResult.ok || !version) {
    if (indeterminateOnFailure) return { state: "indeterminate", label: "Status indeterminate", details: "OpenClaw status could not be refreshed after a management operation.", canInstall: false, canUpdate: false, canEnable: false, canRemove: false };
    throw new CliError("OpenClaw was not found or did not report a supported version.");
  }
  const list = await runOpenClawProcess("list");
  if (!list.ok || list.overflow) {
    return { state: "indeterminate", label: "Status indeterminate", details: indeterminateOnFailure ? "OpenClaw plugin status could not be refreshed." : "OpenClaw plugin status could not be read.", version, canInstall: false, canUpdate: false, canEnable: false, canRemove: false };
  }
  const listPayload = parseJson(list.stdout);
  const inspect = await runOpenClawProcess("inspect");
  if (inspect.overflow) return { state: "indeterminate", label: "Status indeterminate", details: "OpenClaw returned more plugin status data than OpenPets can safely inspect.", version, canInstall: false, canUpdate: false, canEnable: false, canRemove: false };
  if (!inspect.ok) {
    const status = classifyOpenClawStatus({ version, list: listPayload, inspect: undefined, inspectMissing: true, hostSupported: true });
    if (status.state === "not-installed") return status;
    return { state: "indeterminate", label: "Status indeterminate", details: indeterminateOnFailure ? "OpenClaw plugin status could not be refreshed." : "OpenClaw plugin status could not be read.", version, canInstall: false, canUpdate: false, canEnable: false, canRemove: false };
  }
  const inspectPayload = parseJson(inspect.stdout);
  if (inspectPayload === undefined) return { state: "indeterminate", label: "Status indeterminate", details: "OpenClaw returned malformed plugin status.", version, canInstall: false, canUpdate: false, canEnable: false, canRemove: false };
  return classifyOpenClawStatus({ version, list: listPayload, inspect: inspectPayload, hostSupported: true });
}

async function runOpenClawProcess(action: OpenClawCommandAction, targetVersion?: string): Promise<BoundedProcessResult> {
  const spec = buildOpenClawCommand(action, targetVersion);
  const command = process.platform === "win32" && spec.command.toLowerCase().endsWith(".cmd") ? "cmd.exe" : spec.command;
  const args = process.platform === "win32" && spec.command.toLowerCase().endsWith(".cmd") ? ["/d", "/s", "/c", spec.command, ...spec.args] : [...spec.args];
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: process.cwd(), env: process.env, shell: false, windowsHide: true });
    } catch {
      resolvePromise({ ok: false, timedOut: false, stdout, stderr, overflow: false });
      return;
    }
    let overflow = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolvePromise({ ok: false, timedOut: true, stdout, stderr, overflow });
    }, 60_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (overflow) return;
      const captured = appendBounded(stdout, chunk.toString("utf8"), openClawMaxStructuredOutputBytes);
      stdout = captured.value;
      overflow ||= captured.overflow;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (overflow) return;
      const captured = appendBounded(stderr, chunk.toString("utf8"), openClawMaxStructuredOutputBytes);
      stderr = captured.value;
      overflow ||= captured.overflow;
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok: false, timedOut: false, stdout, stderr, overflow });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok: code === 0, timedOut: false, stdout, stderr, overflow });
    });
  });
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function isOpenClawEnsureComplete(status: OpenClawPluginStatus, targetVersion: string): boolean {
  return status.state === "installed-enabled" && status.installedVersion === targetVersion;
}

function isOpenClawCommandAchieved(action: OpenClawCommandAction, status: OpenClawPluginStatus, targetVersion: string): boolean {
  if (action === "remove") return status.state === "not-installed";
  if (action === "enable") return isOpenClawEnsureComplete(status, targetVersion);
  return (status.state === "installed-disabled" || status.state === "installed-enabled") && status.installedVersion === targetVersion;
}

export async function resolveConfiguredPet(client: Pick<ReturnType<typeof createOpenPetsClient>, "listPets">, petId?: string): Promise<ConfiguredPet> {
  if (petId) {
    const id = validateOpenPetsPetArg(petId);
    return { id, displayName: id };
  }

  const petList = await getInstalledPets(client);
  const id = validateOpenPetsPetArg(await pickPet(petList.pets));
  const selectedPet = petList.pets.find((pet) => pet.id === id);
  if (!selectedPet || selectedPet.broken) throw new CliError(`Pet is not installed or usable: ${id}`);
  return { id: selectedPet.id, displayName: selectedPet.displayName };
}

export function parseConfigureArgs(args: readonly string[]): ConfigureOptions {
  let agent = "claude";
  let petId: string | undefined;
  let cwd = process.cwd();
  let cwdProvided = false;
  let yes = false;
  let force = false;
  let localDev = false;
  let cursorRulesMode: ConfigureOptions["cursorRulesMode"];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--force" || arg === "--replace") force = true;
    else if (arg === "--local-dev") localDev = true;
    else if (arg === "--with-rules") cursorRulesMode = setCursorRulesMode(cursorRulesMode, "with");
    else if (arg === "--rules-only") cursorRulesMode = setCursorRulesMode(cursorRulesMode, "only");
    else if (arg === "--remove-rules") cursorRulesMode = setCursorRulesMode(cursorRulesMode, "remove");
    else if (arg === "--agent") { agent = readRequiredArg(args, index, "--agent"); index += 1; }
    else if (arg.startsWith("--agent=")) agent = arg.slice("--agent=".length);
    else if (arg === "--pet") { petId = validateOpenPetsPetArg(readRequiredArg(args, index, "--pet")); index += 1; }
    else if (arg.startsWith("--pet=")) petId = validateOpenPetsPetArg(arg.slice("--pet=".length));
    else if (arg === "--cwd") { cwd = readRequiredArg(args, index, "--cwd"); cwdProvided = true; index += 1; }
    else if (arg.startsWith("--cwd=")) { cwd = arg.slice("--cwd=".length); cwdProvided = true; }
    else throw new CliError(`Unknown configure option: ${arg}`);
  }
  if (agent !== "claude" && agent !== "opencode" && agent !== "cursor" && agent !== "openclaw") throw new CliError(`Unsupported agent: ${agent}. Supported agents: claude, opencode, cursor, openclaw.`);
  if (cursorRulesMode && agent !== "cursor") throw new CliError("Cursor rules flags require --agent cursor.");
  if (agent === "openclaw" && (petId !== undefined || cwdProvided || force || localDev || cursorRulesMode)) throw new CliError("OpenClaw setup is global and does not accept --cwd, --pet, --force, --local-dev, or Cursor rules flags.");
  return { agent, petId, cwd, yes, force, localDev, cursorRulesMode };
}

function setCursorRulesMode(current: ConfigureOptions["cursorRulesMode"], next: ConfigureOptions["cursorRulesMode"]): ConfigureOptions["cursorRulesMode"] {
  if (current && current !== next) throw new CliError("Use only one of --with-rules, --rules-only, or --remove-rules.");
  return next;
}

export function parseInstallArgs(args: readonly string[]): InstallOptions {
  let petId: string | undefined;
  let fromZip: string | undefined;
  let fromFolder: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--from-zip") {
      if (fromZip !== undefined) throw new CliError("Duplicate --from-zip option.");
      if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
        throw new CliError("Missing value for --from-zip.");
      }
      fromZip = args[i + 1];
      i++;
    } else if (arg.startsWith("--from-zip=")) {
      if (fromZip !== undefined) throw new CliError("Duplicate --from-zip option.");
      fromZip = arg.slice("--from-zip=".length);
      if (!fromZip) throw new CliError("Missing value for --from-zip.");
    } else if (arg === "--from-folder") {
      if (fromFolder !== undefined) throw new CliError("Duplicate --from-folder option.");
      if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
        throw new CliError("Missing value for --from-folder.");
      }
      fromFolder = args[i + 1];
      i++;
    } else if (arg.startsWith("--from-folder=")) {
      if (fromFolder !== undefined) throw new CliError("Duplicate --from-folder option.");
      fromFolder = arg.slice("--from-folder=".length);
      if (!fromFolder) throw new CliError("Missing value for --from-folder.");
    } else if (arg.startsWith("--")) {
      throw new CliError(`Unknown install option: ${arg}`);
    } else {
      if (petId !== undefined) {
        throw new CliError("Unexpected multiple pet IDs / arguments.");
      }
      petId = arg;
    }
  }

  const presentCount = [
    petId !== undefined,
    fromZip !== undefined,
    fromFolder !== undefined
  ].filter(Boolean).length;

  if (presentCount === 0) {
    throw new CliError("Usage: openpets install <pet-id> or openpets install --from-zip <path> or openpets install --from-folder <path>");
  }
  if (presentCount > 1) {
    throw new CliError("Conflicting install options. Choose only one of <pet-id>, --from-zip, or --from-folder.");
  }

  if (petId !== undefined) {
    return { petId: validateOpenPetsPetArg(petId) };
  }
  if (fromZip !== undefined) {
    return { fromZip };
  }
  return { fromFolder };
}

export function parsePluginNewArgs(args: readonly string[]): PluginNewOptions {
  let name: string | undefined;
  let id: string | undefined;
  let dir: string | undefined;
  let author: string | undefined;
  let template: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--id") { id = readRequiredArg(args, index, "--id"); index += 1; }
    else if (arg.startsWith("--id=")) id = arg.slice("--id=".length);
    else if (arg === "--dir") { dir = readRequiredArg(args, index, "--dir"); index += 1; }
    else if (arg.startsWith("--dir=")) dir = arg.slice("--dir=".length);
    else if (arg === "--author") { author = readRequiredArg(args, index, "--author"); index += 1; }
    else if (arg.startsWith("--author=")) author = arg.slice("--author=".length);
    else if (arg === "--template") { template = readRequiredArg(args, index, "--template"); index += 1; }
    else if (arg.startsWith("--template=")) template = arg.slice("--template=".length);
    else if (arg.startsWith("--")) throw new CliError(`Unknown plugin new option: ${arg}`);
    else if (name === undefined) name = arg;
    else throw new CliError(`Unexpected argument: ${arg}`);
  }
  const cleanName = (name ?? "").trim();
  if (!cleanName) throw new CliError("Usage: openpets plugin new <name> [--template <template>] [--id <id>] [--dir <path>] [--author <name>]");
  if (cleanName.length > 60 || /[\x00-\x1F\x7F]/.test(cleanName)) throw new CliError("Plugin name must be 1-60 printable characters.");
  const slug = slugifyPluginName(cleanName);
  if (!slug) throw new CliError("Plugin name must contain at least one letter or number.");
  const finalId = (id ?? `local.${slug}`).trim();
  if (!isValidPluginId(finalId)) throw new CliError("Plugin id must be 1-64 chars (letters, numbers, dot, dash, underscore) and cannot start with a dot.");
  const finalTemplate = (template ?? "blank").trim() as PluginTemplateName;
  if (!pluginTemplateNames.includes(finalTemplate)) throw new CliError(`Unknown plugin template: ${finalTemplate}. Templates: ${pluginTemplateNames.join(", ")}.`);
  return { name: cleanName, id: finalId, dir: dir ?? slug, author: author?.trim() || undefined, template: finalTemplate };
}

function slugifyPluginName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function isValidPluginId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);
}

export function scaffoldPlugin(options: PluginNewOptions): { readonly dir: string; readonly manifestPath: string; readonly entryPath: string } {
  const targetDir = resolve(options.dir);
  const manifestPath = join(targetDir, "openpets.plugin.json");
  const entryPath = join(targetDir, "index.js");
  if (existsSync(manifestPath) || existsSync(entryPath)) throw new CliError(`A plugin already exists at ${targetDir}. Choose another --dir.`);
  mkdirSync(targetDir, { recursive: true });
  const dirStats = lstatSync(targetDir);
  if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) throw new CliError("Target plugin path must be a directory.");

  const template = pluginTemplates[options.template];
  const manifest = {
    $schema: "https://openpets.dev/schemas/openpets.plugin.schema.json",
    manifestVersion: 3,
    id: options.id,
    name: options.name,
    version: "1.0.0",
    description: `${options.name} — ${template.description}`,
    runtime: "javascript",
    entry: "index.js",
    sdkVersion: "3.0.0",
    permissions: template.permissions,
    configSchema: template.configSchema,
  };
  const templateContext = { id: options.id, name: options.name };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  writeFileSync(entryPath, template.entry(templateContext), { encoding: "utf8", flag: "wx" });
  writeFileSync(join(targetDir, "test.js"), template.test(templateContext), { encoding: "utf8", flag: "wx" });
  // Templates that localize host-rendered strings ($t:) or runtime bodies
  // (ctx.t) ship a source locales/en.json; the host loads locales/<locale>.json
  // and falls back to en. Write it whenever the template declares one.
  if (template.locales) {
    const localesDir = join(targetDir, "locales");
    mkdirSync(localesDir, { recursive: true });
    writeFileSync(join(localesDir, "en.json"), `${JSON.stringify(template.locales(templateContext), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }
  const packageJsonPath = join(targetDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    writeFileSync(packageJsonPath, `${JSON.stringify({ name: slugifyPluginName(options.name) || "openpets-plugin", private: true, type: "module", scripts: { test: "node test.js" }, devDependencies: { "@open-pets/plugin-sdk": "^3.0.0" } }, null, 2)}\n`, { encoding: "utf8" });
  }
  const readmePath = join(targetDir, "README.md");
  if (!existsSync(readmePath)) writeFileSync(readmePath, pluginReadmeTemplate(options, targetDir), { encoding: "utf8" });

  process.stdout.write(
    `Created OpenPets plugin "${sanitizeTerminalText(options.name)}" (${options.id}) from the ${options.template} template\n  ${targetDir}\n\n` +
      "Next steps:\n" +
      "  1. npm install              # pulls @open-pets/plugin-sdk for types + the test kit\n" +
      "  2. npm test                 # deterministic harness, no app needed\n" +
      "  3. From the OpenPets repo root, run it live with hot reload:\n" +
      `     OPENPETS_DEV_PLUGIN_PATHS=${targetDir} pnpm dev:desktop\n` +
      "  4. Open Tray → Plugins, enable it, then right-click your pet.\n\n" +
      `Validate anytime: openpets plugin validate ${targetDir}\n` +
      "Docs: https://openpets.dev/sdk\n",
  );
  return { dir: targetDir, manifestPath, entryPath };
}

function pluginReadmeTemplate(options: PluginNewOptions, targetDir: string): string {
  return `# ${options.name}

An OpenPets plugin (\`${options.id}\`).

## Develop

\`\`\`bash
# optional: editor autocomplete + type-checking
npm i -D @open-pets/plugin-sdk

# from the OpenPets repo root, load this folder and launch the app
OPENPETS_DEV_PLUGIN_PATHS=${targetDir} pnpm dev:desktop
\`\`\`

Then open **Tray → Plugins**, enable the plugin, and right-click your pet to
run its commands.

## Learn more

- SDK guide: https://openpets.dev/sdk
- Reference: https://openpets.dev/docs/plugin-sdk
`;
}

export function parseReactArgs(args: readonly string[]): ReactOptions {
  if (args.length !== 1) throw new CliError("Usage: openpets react <reaction>");
  return { reaction: parseReaction(args[0] ?? "") };
}

export function parseSayArgs(args: readonly string[]): SayOptions {
  let reaction: OpenPetsReaction | undefined;
  const messageParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--reaction") {
      reaction = parseReaction(readRequiredArg(args, index, "--reaction"));
      index += 1;
    } else if (arg.startsWith("--reaction=")) {
      reaction = parseReaction(arg.slice("--reaction=".length));
    } else if (arg.startsWith("--")) {
      throw new CliError(`Unknown say option: ${arg}`);
    } else {
      messageParts.push(arg);
    }
  }
  const message = messageParts.join(" ").trim();
  if (!message) throw new CliError("Usage: openpets say <message> [--reaction <reaction>]");
  return { message, reaction };
}

function parseReaction(value: string): OpenPetsReaction {
  if (!allowedReactions.includes(value as OpenPetsReaction)) {
    throw new CliError(`Invalid OpenPets reaction: ${value}. Allowed reactions: ${allowedReactions.join(", ")}.`);
  }
  return value as OpenPetsReaction;
}

export function createVersionPinnedCliCommand(version: string, args: readonly string[]): CommandSpec {
  return { command: "npx", args: ["-y", `${cliPackageName}@${version}`, ...args] };
}

export function createLocalDevCliCommand(args: readonly string[]): CommandSpec {
  return { command: process.execPath, args: [fileURLToPath(import.meta.url), ...args] };
}

export function createClaudeMcpAddJsonArgs(config: unknown): readonly string[] {
  return ["mcp", "add-json", "openpets", JSON.stringify(config), "--scope", "local"];
}

export function installProjectLocalHooks(projectDir: string, hookCommand: string): void {
  writePreparedHooks(prepareProjectLocalHooks(projectDir, hookCommand));
}

export function prepareProjectLocalHooks(projectDir: string, hookCommand: string): PreparedHooks {
  assertSafeProjectHookPath(projectDir);
  const settingsPath = getProjectLocalSettingsPath(realpathSync(projectDir));
  const current = readJsonObject(settingsPath);
  const cleaned = removeOpenPetsHooks(current);
  const hooks = isRecord(cleaned.hooks) ? { ...cleaned.hooks } : {};
  for (const event of claudeHookEvents) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new CliError(`Claude local settings hooks.${event} must be an array.`);
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...existing, { hooks: [createHookCommandEntry(hookCommand)] }];
  }
  return { settingsPath, settings: { ...cleaned, hooks } };
}

function writePreparedHooks(prepared: PreparedHooks): void {
  writeJsonFile(prepared.settingsPath, prepared.settings);
}

function createHookCommandEntry(command: string): Record<string, unknown> {
  return { type: "command", command, timeout: 10, async: true, asyncRewake: false };
}

export function runClaudeMcpAddJson(projectDir: string, config: unknown, force = false): void {
  if (force) runClaudeMcpRemove(projectDir);
  const result = spawnSync("claude", createClaudeMcpAddJsonArgs(config), { cwd: projectDir, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  if (result.error) throw new CliError(`Claude Code is unavailable on PATH: ${result.error.message}`);
  if (result.status !== 0) throw new CliError(`Claude MCP configuration failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
}

function runClaudeMcpRemove(projectDir: string): void {
  const result = spawnSync("claude", ["mcp", "remove", "openpets", "--scope", "local"], { cwd: projectDir, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  if (result.error) throw new CliError(`Claude Code is unavailable on PATH: ${result.error.message}`);
  const output = `${result.stderr || ""}\n${result.stdout || ""}`;
  if (result.status !== 0 && !/not found|does not exist|no server|unknown/i.test(output)) {
    throw new CliError(`Claude MCP remove failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
}

async function runMcp(args: readonly string[]): Promise<void> {
  const entry = require.resolve("@open-pets/mcp");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: "inherit" });
    const forwardSigint = (): void => { child.kill("SIGINT"); };
    const forwardSigterm = (): void => { child.kill("SIGTERM"); };
    process.once("SIGINT", forwardSigint);
    process.once("SIGTERM", forwardSigterm);
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      process.off("SIGINT", forwardSigint);
      process.off("SIGTERM", forwardSigterm);
      if (signal) { process.kill(process.pid, signal); return; }
      process.exitCode = code ?? 1;
      resolvePromise();
    });
  });
}

async function getInstalledPets(client: Pick<ReturnType<typeof createOpenPetsClient>, "listPets">) {
  try {
    return await client.listPets();
  } catch (error) {
    if (error instanceof OpenPetsClientError && error.code === "unknown_method") throw new CliError("OpenPets desktop app is too old for project setup. Update/restart OpenPets and try again.");
    throw new CliError("OpenPets desktop app is not running. Open OpenPets, then run this command again.");
  }
}

async function pickPet(pets: readonly OpenPetsPetListItem[]): Promise<string> {
  const usable = pets.filter((pet) => !pet.broken);
  if (usable.length === 0) throw new CliError("No usable installed pets found. Open OpenPets and install a pet first.");
  if (!process.stdin.isTTY) throw new CliError("Missing --pet <id>. Non-interactive shells must pass --pet.");
  process.stdout.write("Pick pet for this project:\n");
  usable.forEach((pet, index) => process.stdout.write(`  ${index + 1}. ${sanitizeTerminalText(pet.displayName)} (${pet.id})\n`));
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Pet number: ");
    const index = Number(answer.trim()) - 1;
    if (!Number.isInteger(index) || !usable[index]) throw new CliError("Invalid pet selection.");
    return usable[index].id;
  } finally {
    rl.close();
  }
}

function sanitizeTerminalText(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, "").slice(0, 100);
}

function appendBounded(existing: string, next: string, maxBytes: number): BoundedOutput {
  const existingBytes = Buffer.byteLength(existing, "utf8");
  const nextBytes = Buffer.byteLength(next, "utf8");
  if (existingBytes + nextBytes <= maxBytes) return { value: existing + next, overflow: false };
  const availableBytes = Math.max(0, maxBytes - existingBytes);
  return { value: existing + Buffer.from(next, "utf8").subarray(0, availableBytes).toString("utf8"), overflow: true };
}

function resolveProjectDir(cwd: string): string {
  const resolved = resolve(cwd);
  const stats = lstatSync(resolved);
  if (stats.isSymbolicLink()) throw new CliError("Project directory cannot be a symlink.");
  if (!stats.isDirectory()) throw new CliError("Project path must be a directory.");
  return realpathSync(resolved);
}

function assertClaudeAvailable(): void {
  const result = spawnSync("claude", ["--version"], { shell: false, stdio: "ignore", timeout: 5_000 });
  if (result.error || result.status !== 0) throw new CliError("Claude Code is unavailable on PATH. Install Claude Code, then try again.");
}

export function assertSafeProjectHookPath(projectDir: string): void {
  const projectReal = realpathSync(projectDir);
  const claudeDir = join(projectReal, ".claude");
  if (existsSync(claudeDir)) {
    const claudeStats = lstatSync(claudeDir);
    if (claudeStats.isSymbolicLink()) throw new CliError("Project .claude directory cannot be a symlink.");
    if (!claudeStats.isDirectory()) throw new CliError("Project .claude path must be a directory.");
    const rel = relative(projectReal, realpathSync(claudeDir));
    if (rel.startsWith("..") || isAbsolute(rel)) throw new CliError("Project .claude directory escapes the project.");
  }
  const settingsPath = getProjectLocalSettingsPath(projectReal);
  if (existsSync(settingsPath)) {
    const settingsStats = lstatSync(settingsPath);
    if (settingsStats.isSymbolicLink()) throw new CliError("Project Claude local settings file cannot be a symlink.");
    if (!settingsStats.isFile()) throw new CliError("Project Claude local settings path must be a file.");
  }
  const settingsRel = relative(projectReal, resolve(settingsPath));
  if (settingsRel.startsWith("..") || isAbsolute(settingsRel)) throw new CliError("Project Claude local settings path escapes the project.");
}

function getProjectLocalSettingsPath(projectDir: string): string {
  return join(projectDir, ".claude", "settings.local.json");
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed) || Array.isArray(parsed)) throw new CliError("Claude local settings must be a JSON object.");
  if (parsed.hooks !== undefined && !isRecord(parsed.hooks)) throw new CliError("Claude local settings hooks field must be an object.");
  return parsed;
}

function writeJsonFile(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parentStats = lstatSync(dirname(path));
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) throw new CliError("Project .claude directory is unsafe after creation.");
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, path);
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

function readPetArg(args: readonly string[]): string | undefined {
  const equals = args.find((arg) => arg.startsWith("--pet="));
  if (equals) return validateOpenPetsPetArg(equals.slice("--pet=".length));
  const index = args.indexOf("--pet");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && (!value || value.startsWith("--"))) throw new CliError("Missing value for --pet.");
  return value && value.length > 0 ? validateOpenPetsPetArg(value) : undefined;
}

function hasProjectLocalArg(args: readonly string[]): boolean {
  return args.includes("--project-local");
}

function readRequiredArg(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new CliError(`Missing value for ${flag}.`);
  return value;
}

function formatShellCommand(command: CommandSpec): string {
  return [command.command, ...command.args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(value)) return value;
  if (/[\r\n"]/.test(value) || value.includes("\0")) throw new CliError("Command argument contains unsupported shell characters.");
  return `"${value.replaceAll("\\", "\\\\").replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function getPackageVersion(): string {
  const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown;
  if (!isRecord(parsed) || typeof parsed.version !== "string") throw new CliError("Cannot read OpenPets CLI package version.");
  return parsed.version;
}

function getWorkspacePackageVersion(packageName: string): string {
  try {
    const entryPath = require.resolve(packageName);
    const packageJsonPath = join(dirname(dirname(entryPath)), "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { readonly version?: unknown };
    if (typeof packageJson.version !== "string" || !packageJson.version) throw new Error("Package version is missing.");
    return packageJson.version;
  } catch {
    throw new CliError(`Cannot read ${packageName} package version.`);
  }
}

function printUsage(): void {
  process.stdout.write("Usage:\n  openpets status\n  openpets doctor [--cwd <path>] [--json]\n  openpets pets\n  openpets react <reaction>\n  openpets say <message> [--reaction <reaction>]\n  openpets install <pet-id> | --from-zip <path> | --from-folder <path>\n  openpets configure [--agent claude|opencode|cursor|openclaw] [--pet <id>] [--cwd <path>] [--yes] [--force] [--with-rules|--rules-only|--remove-rules]\n  openpets plugin new <name> [--id <id>] [--dir <path>] [--author <name>]\n  openpets mcp [--pet <id>]\n  openpets hook --openpets-managed [--pet <id>]\n\nRun `openpets <command> --help` for command options.\n");
}

function printPluginUsage(): void {
  process.stdout.write(
    "Usage:\n" +
      "  openpets plugin new <name> [--template <template>] [--id <id>] [--dir <path>] [--author <name>]\n" +
      "  openpets plugin validate [dir]\n\n" +
      "plugin new scaffolds a typed SDK v3 plugin with a manifest, a working entry, and a passing\n" +
      "test built on @open-pets/plugin-sdk/testing. plugin validate checks the manifest, config\n" +
      "schema, declared assets/panels, permissions, and network hosts at author time.\n\n" +
      "Options:\n" +
      `  --template <t>   Template: ${pluginTemplateNames.join(", ")}. Defaults to blank.\n` +
      "  --id <id>        Plugin id (reverse-DNS style). Defaults to local.<name-slug>.\n" +
      "  --dir <path>     Target directory. Defaults to ./<name-slug>.\n" +
      "  --author <name>  Author name (informational).\n" +
      "  -h, --help       Show this help.\n\n" +
      "Learn more: https://openpets.dev/sdk\n",
  );
}

function printInstallUsage(): void {
  process.stdout.write("Usage:\n  openpets install <pet-id>\n  openpets install --from-zip <path>\n  openpets install --from-folder <path>\n\nDownloads and installs a gallery pet by ID, or installs a local pet from a zip file or a folder, through the running OpenPets desktop app.\n");
}

function printStatusUsage(): void {
  process.stdout.write("Usage:\n  openpets status\n\nChecks whether the OpenPets desktop app is reachable and prints the status response as JSON.\n");
}

function printDoctorUsage(): void {
  process.stdout.write("Usage:\n  openpets doctor [--cwd <path>] [--json]\n\nReports whether the Claude hook and project Cursor MCP integrations are installed, need an update, or are broken, and whether the OpenPets desktop app is reachable.\n\nOptions:\n  --cwd <path>   Project directory to inspect for .cursor/mcp.json. Defaults to current directory.\n  --json         Print the report as JSON instead of labeled lines.\n  -h, --help     Show this help.\n");
}

function printPetsUsage(): void {
  process.stdout.write("Usage:\n  openpets pets\n\nLists pets installed in the running OpenPets desktop app.\n");
}

function printReactUsage(): void {
  process.stdout.write(`Usage:\n  openpets react <reaction>\n\nSends a reaction to the running OpenPets desktop app.\nAllowed reactions: ${allowedReactions.join(", ")}.\n`);
}

function printSayUsage(): void {
  process.stdout.write(`Usage:\n  openpets say <message> [--reaction <reaction>]\n\nShows a short message in the running OpenPets desktop app. Optionally sends a reaction with the message.\nAllowed reactions: ${allowedReactions.join(", ")}.\n`);
}

function printConfigureUsage(): void {
  process.stdout.write("Usage:\n  openpets configure [--agent claude|opencode|cursor|openclaw] [--pet <id>] [--cwd <path>] [--yes] [--force] [--with-rules|--rules-only|--remove-rules]\n\nOptions:\n  --pet <id>           Pet id to use for this project. If omitted, prompts with installed pets. Cursor --rules-only/--remove-rules do not need a pet.\n  --agent <agent>      Agent to configure: claude, opencode, cursor, or global openclaw. Defaults to claude.\n  --cwd <path>         Project directory to configure. Defaults to current directory. Cursor uses <cwd>/.cursor/mcp.json and <cwd>/.cursor/rules/openpets.mdc; global Cursor setup is not enabled here.\n  --with-rules         For Cursor, install MCP config and project rules after preflighting both writes.\n  --rules-only         For Cursor, install/update only .cursor/rules/openpets.mdc.\n  --remove-rules       For Cursor, remove only managed .cursor/rules/openpets.mdc.\n  --yes, -y            Accepted for scripts; no confirmation prompt is shown.\n  --force              Replace supported managed entries where applicable. Required for conflicting Cursor rules.\n  --replace            Alias for --force.\n  --local-dev          Use local development command paths where supported.\n  -h, --help           Show this help.\n\nOpenClaw setup is global and accepts only --agent openclaw and optional --yes.\n");
}

function printMcpUsage(): void {
  process.stdout.write("Usage:\n  openpets mcp [--pet <id>]\n\nStarts the OpenPets MCP server wrapper. This command is written into Claude MCP config by `openpets configure`.\n");
}

function printHookUsage(): void {
  process.stdout.write("Usage:\n  openpets hook --openpets-managed [--pet <id>]\n\nRuns one Claude hook event from stdin. This command is written into Claude project hooks by `openpets configure`.\n");
}

function hasHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class CliError extends Error {}

if (isMainModule()) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}
