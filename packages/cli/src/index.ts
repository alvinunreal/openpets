#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

import { createOpenPetsClient, OpenPetsClientError, type OpenPetsPetListItem } from "@open-pets/client";
import { claudeHookEvents, openPetsHookMarker, removeOpenPetsHooks, runClaudeHookFromStdin, validateOpenPetsPetArg } from "@open-pets/claude";
import { prepareOpenCodeProjectSetup, writePreparedOpenCodeProjectSetup } from "@open-pets/opencode";

export const cliPackageName = "@open-pets/cli";

interface ConfigureOptions {
  readonly agent: "claude" | "opencode" | "codex";
  readonly petId?: string;
  readonly cwd: string;
  readonly yes: boolean;
  readonly force: boolean;
  readonly localDev: boolean;
}

interface InstallOptions {
  readonly petId: string;
}

interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
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
  throw new CliError(`Unknown command: ${command}`);
}

async function installPetFromCatalog(options: InstallOptions): Promise<void> {
  const client = createOpenPetsClient({ responseTimeoutMs: 60_000 });
  const result = await client.installPet(options.petId);
  process.stdout.write(`Installed OpenPets pet: ${sanitizeTerminalText(result.displayName)} (${result.petId})\n`);
}

export async function configureProject(options: ConfigureOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.cwd);
  if (options.agent === "opencode") {
    await configureOpenCodeProject(options, projectDir);
    return;
  }
  if (options.agent === "codex") {
    await configureCodexProject(options, projectDir);
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

async function configureOpenCodeProject(options: ConfigureOptions, projectDir: string): Promise<void> {
  const client = createOpenPetsClient();
  const selectedPet = await resolveConfiguredPet(client, options.petId);
  const packageVersion = getPackageVersion();
  const prepared = prepareOpenCodeProjectSetup({ projectDir, petId: selectedPet.id, cliVersion: packageVersion, commandMode: options.localDev ? "local" : "published", cliEntryPath: options.localDev ? fileURLToPath(import.meta.url) : undefined });
  writePreparedOpenCodeProjectSetup(prepared);
  process.stdout.write(`OpenPets configured for OpenCode in ${projectDir}.\nPet: ${sanitizeTerminalText(selectedPet.displayName)} (${selectedPet.id})\nConfig: ${prepared.configPath}\nInstructions: ${prepared.instructionPath}\nWarning: .opencode config/instructions can be committed and include the selected pet id.\nRestart OpenCode in this project to load OpenPets.\n`);
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
  let yes = false;
  let force = false;
  let localDev = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--force" || arg === "--replace") force = true;
    else if (arg === "--local-dev") localDev = true;
    else if (arg === "--agent") { agent = readRequiredArg(args, index, "--agent"); index += 1; }
    else if (arg.startsWith("--agent=")) agent = arg.slice("--agent=".length);
    else if (arg === "--pet") { petId = validateOpenPetsPetArg(readRequiredArg(args, index, "--pet")); index += 1; }
    else if (arg.startsWith("--pet=")) petId = validateOpenPetsPetArg(arg.slice("--pet=".length));
    else if (arg === "--cwd") { cwd = readRequiredArg(args, index, "--cwd"); index += 1; }
    else if (arg.startsWith("--cwd=")) cwd = arg.slice("--cwd=".length);
    else throw new CliError(`Unknown configure option: ${arg}`);
  }
  if (agent !== "claude" && agent !== "opencode" && agent !== "codex") throw new CliError(`Unsupported agent: ${agent}. Supported agents: claude, opencode, codex.`);
  return { agent, petId, cwd, yes, force, localDev };
}

export function parseInstallArgs(args: readonly string[]): InstallOptions {
  if (args.length !== 1) throw new CliError("Usage: openpets install <pet-id>");
  return { petId: validateOpenPetsPetArg(args[0] ?? "") };
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


async function configureCodexProject(options: ConfigureOptions, projectDir: string): Promise<void> {
  const client = createOpenPetsClient();
  const selectedPet = await resolveConfiguredPet(client, options.petId);
  const packageVersion = getPackageVersion();
  const mcpCommand = options.localDev ? createLocalDevCliCommand(["mcp", "--pet", selectedPet.id]) : createVersionPinnedCliCommand(packageVersion, ["mcp", "--pet", selectedPet.id]);
  const configPath = join(projectDir, ".codex", "config.toml");
  writeCodexProjectConfig(configPath, mcpCommand, options.force);
  process.stdout.write(`OpenPets configured for Codex in ${projectDir}.\nPet: ${sanitizeTerminalText(selectedPet.displayName)} (${selectedPet.id})\nConfig: ${configPath}\nRestart Codex in this project to load OpenPets tools.\n`);
}

function writeCodexProjectConfig(configPath: string, command: CommandSpec, force: boolean): void {
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (!force && /\[mcp_servers\.openpets\]/.test(existing)) {
    throw new CliError("Codex config already has [mcp_servers.openpets]. Use --force to replace the OpenPets block.");
  }
  const block = buildCodexOpenPetsBlock(command);
  const cleaned = existing.replace(/\n?\[mcp_servers\.openpets\][\s\S]*?(?=\n\[[^\]]+\]|$)/g, "").trimEnd();
  const next = `${cleaned.length > 0 ? `${cleaned}\n\n` : ""}${block}\n`;
  writeTextFile(configPath, next);
}

function buildCodexOpenPetsBlock(command: CommandSpec): string {
  const args = command.args.map((arg) => tomlString(arg)).join(", ");
  return `[mcp_servers.openpets]\ncommand = ${tomlString(command.command)}\nargs = [${args}]`;
}

function tomlString(value: string): string {
  if (/\r|\n|\0/.test(value)) throw new CliError("Codex TOML value contains unsupported characters.");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function writeTextFile(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parentStats = lstatSync(dirname(path));
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) throw new CliError("Config directory is unsafe after creation.");
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, value, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, path);
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
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

function printUsage(): void {
  process.stdout.write("Usage:\n  openpets install <pet-id>\n  openpets configure [--agent claude|opencode|codex] [--pet <id>] [--cwd <path>] [--yes] [--force]\n  openpets mcp [--pet <id>]\n  openpets hook --openpets-managed [--pet <id>]\n\nRun `openpets <command> --help` for command options.\n");
}

function printInstallUsage(): void {
  process.stdout.write("Usage:\n  openpets install <pet-id>\n\nDownloads a gallery pet through the running OpenPets desktop app and installs it locally.\n");
}

function printConfigureUsage(): void {
  process.stdout.write("Usage:\n  openpets configure [--agent claude|opencode|codex] [--pet <id>] [--cwd <path>] [--yes] [--force]\n\nOptions:\n  --pet <id>           Pet id to use for this project. If omitted, prompts with installed pets.\n  --agent <agent>      Agent to configure: claude, opencode, or codex. Defaults to claude.\n  --cwd <path>         Project directory to configure. Defaults to current directory.\n  --yes, -y            Accepted for scripts; no confirmation prompt is shown.\n  --force              Replace supported managed entries where applicable.\n  --replace            Alias for --force.\n  --local-dev          Use local development command paths where supported.\n  -h, --help           Show this help.\n");
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
