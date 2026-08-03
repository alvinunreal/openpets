import { spawn } from "node:child_process";
import { constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, accessSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";

import { app } from "electron";
import { buildClaudeMcpGetCommand, buildClaudeMcpPreview, classifyClaudeMcpStatus, createOpenPetsHookSettingsPreview, doctorClaudeHooks, installClaudeHooks, mapAsarPathToUnpacked, uninstallClaudeHooks, type ClaudeCommandSpec, type ClaudeHookDoctorResult, type ClaudeMcpPreview, type OpenPetsCommandMode, type ParsedClaudeMcpEntry } from "@open-pets/claude";
import { buildCursorRulesPreview, classifyCursorMcpStatus, executeCursorMcpWrite, getCursorGlobalMcpPath, planCursorMcpInstall, planCursorMcpRemove, planCursorMcpReplace, readCursorMcpConfig, type CursorMcpStatusResult } from "@open-pets/cursor";
import { buildOpenPetsOnlyPreview, type RedactedPreview } from "@open-pets/cursor";
import { doctorOpenCodeGlobalSetup, getGlobalOpenCodeConfigDir, parseOpenCodeConfig, prepareOpenCodeGlobalRemove, prepareOpenCodeGlobalSetup, writePreparedOpenCodeGlobalRemove, writePreparedOpenCodeGlobalSetup } from "@open-pets/opencode";

import { getAppStateSnapshot, updatePreferences, type InstalledPetState, type OpenPetsStateV1 } from "./app-state.js";
import { doctorClaudeOpenPetsMemory, installClaudeOpenPetsMemory, uninstallClaudeOpenPetsMemory, type ClaudeOpenPetsMemoryStatus } from "./claude-memory.js";
import { getDefaultOpenCodeCommand, getOpenCodeCommandCandidates } from "./opencode-command.js";

export type AgentSetupAction = "configure" | "replace" | "remove" | "install-memory" | "doctor-hooks" | "install-hooks" | "uninstall-hooks" | "opencode-install" | "opencode-remove" | "cursor-install" | "cursor-replace" | "cursor-remove";
export type JournalAction = "configure" | "update" | "replace" | "remove";

export interface AgentSetupPetOption {
  readonly id: string;
  readonly displayName: string;
  readonly default: boolean;
}

export interface ClaudeCodeStatus {
  readonly state: "detected" | "not_detected" | "configured" | "needs_setup" | "error";
  readonly label: string;
  readonly details: string;
  readonly claudeCommand?: string;
  readonly version?: string;
  readonly mcpListWorks: boolean;
  readonly openPetsEntry: ParsedClaudeMcpEntry;
  readonly canConfigure: boolean;
  readonly canReplace: boolean;
  readonly canRemove: boolean;
}

export interface AgentSetupSnapshot {
  readonly selectedPetId?: string;
  readonly commandMode: OpenPetsCommandMode;
  readonly localDevAvailable: boolean;
  readonly petOptions: readonly AgentSetupPetOption[];
  readonly preview: ClaudeMcpPreview;
  readonly status: ClaudeCodeStatus;
  readonly hookStatus: ClaudeHookDoctorResult;
  readonly memoryStatus: ClaudeOpenPetsMemoryStatus;
  readonly opencodeStatus: OpenCodeSetupStatus;
  readonly opencodePreview: OpenCodeSetupPreview;
  readonly cursorStatus: CursorSetupStatus;
  readonly cursorPreview: CursorSetupPreview;
  readonly commandPaths: AgentSetupCommandPaths;
  readonly busy: boolean;
  readonly lastAction?: AgentSetupActionResult;
}

export interface AgentSetupCommandPaths {
  readonly claude: string;
  readonly node: string;
  readonly opencode: string;
}

export interface OpenCodeSetupStatus {
  readonly state: "configured" | "needs_setup" | "not_detected" | "error";
  readonly label: string;
  readonly details: string;
  readonly configDir: string;
  readonly canInstall: boolean;
  readonly canRemove: boolean;
}

export interface OpenCodeSetupPreview {
  readonly global: true;
  readonly configDir: string;
  readonly configPath: string;
  readonly cleanupConfigPaths: readonly string[];
  readonly mcpCommand: readonly string[];
  readonly plugin: readonly unknown[] | string;
  readonly instructionPath: string;
  readonly configPreview: Record<string, unknown>;
}

export interface CursorSetupStatus {
  readonly state: "configured" | "needs_setup" | "not_detected" | "error" | "conflict" | "needs_update";
  readonly label: string;
  readonly details: string;
  readonly configPath: string;
  readonly canInstall: boolean;
  readonly canReplace: boolean;
  readonly canRemove: boolean;
}

export interface CursorSetupPreview {
  readonly global: true;
  readonly configPath: string;
  readonly mcpEntry: RedactedPreview;
  readonly rulesPath: string;
  readonly rulesContent: string;
  readonly commandMode: "published" | "local" | "bundled";
}

export interface AgentSetupActionResult {
  readonly ok: boolean;
  readonly action: AgentSetupAction;
  readonly message: string;
  readonly changed: boolean;
}

export interface AgentSetupJournalEntry {
  readonly timestamp: string;
  readonly action: JournalAction;
  readonly selectedPetId?: string;
  readonly command: readonly string[];
  readonly previousStatus: string;
  readonly success: boolean;
  readonly message: string;
}

interface CommandResult {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

const commandTimeoutMs = 6_000;
const maxOutputBytes = 16_384;
const require = createRequire(import.meta.url);
let operationRunning = false;
let lastAction: AgentSetupActionResult | undefined;

export async function getAgentSetupSnapshot(selectedPetId?: unknown, commandModeInput?: unknown): Promise<AgentSetupSnapshot> {
  const petId = validateSelectedPetId(selectedPetId);
  const commandMode = validateCommandMode(commandModeInput);
  const preview = safeBuildClaudeMcpPreview(petId, commandMode);
  const status = preview.error ? createBundledResourceErrorStatus(preview.error) : await detectClaudeCodeStatus(petId, commandMode);
  const rawHookStatus = preview.error ? createHookErrorStatus(preview.error) : safeDoctorClaudeHooks(commandMode, petId);
  const hookStatus = { ...rawHookStatus, settingsPath: formatUserPath(rawHookStatus.settingsPath) ?? rawHookStatus.settingsPath, backupPath: formatUserPath(rawHookStatus.backupPath) };
  const rawMemoryStatus = doctorClaudeOpenPetsMemory(app.getPath("home"));
  const memoryStatus = { ...rawMemoryStatus, claudeMdPath: formatUserPath(rawMemoryStatus.claudeMdPath) ?? rawMemoryStatus.claudeMdPath, openPetsMemoryPath: formatUserPath(rawMemoryStatus.openPetsMemoryPath) ?? rawMemoryStatus.openPetsMemoryPath };
  const opencode = await getOpenCodeSetup(commandMode, petId);
  const cursor = await getCursorSetup(commandMode, petId);

  return {
    selectedPetId: petId,
    commandMode,
    localDevAvailable: !app.isPackaged,
    petOptions: getPetOptions(),
    preview: preview.preview,
    status,
    hookStatus,
    memoryStatus,
    opencodeStatus: opencode.status,
    opencodePreview: opencode.preview,
    cursorStatus: cursor.status,
    cursorPreview: cursor.preview,
    commandPaths: getAgentSetupCommandPaths(),
    busy: operationRunning,
    lastAction,
  };
}

export function updateAgentSetupCommandPaths(patch: unknown): AgentSetupCommandPaths {
  if (!isRecord(patch)) throw new Error("Invalid command path settings.");
  for (const key of Object.keys(patch)) {
    if (key !== "claude" && key !== "node" && key !== "opencode") throw new Error("Invalid command path setting.");
  }
  const updates: Writable<Partial<OpenPetsStateV1["preferences"]>> = {};
  if ("claude" in patch) updates.claudeCommandPath = normalizeOptionalCommandPath(patch.claude, "Claude");
  if ("node" in patch) updates.nodeCommandPath = normalizeOptionalCommandPath(patch.node, "Node.js");
  if ("opencode" in patch) updates.opencodeCommandPath = normalizeOptionalCommandPath(patch.opencode, "OpenCode");
  updatePreferences(updates);
  return getAgentSetupCommandPaths();
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

export async function runAgentSetupAction(action: AgentSetupAction, selectedPetId?: unknown, commandModeInput?: unknown): Promise<AgentSetupSnapshot> {
  if (operationRunning) throw new Error("Another Claude setup operation is already running.");
  const petId = validateSelectedPetId(selectedPetId);
  const commandMode = validateCommandMode(commandModeInput);
  operationRunning = true;

  try {
    lastAction = await runAction(action, petId, commandMode);
    operationRunning = false;
    return getAgentSetupSnapshot(petId, commandMode);
  } finally {
    operationRunning = false;
  }
}

export function sanitizeAgentSetupOutput(value: string): string {
  const home = app.isReady() ? app.getPath("home") : "";
  return value
    .replaceAll(home, "~")
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"']{2,}/g, "<path>")
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi, "<redacted-private-key>")
    .replace(/bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer <redacted>")
    .replace(/\b(api[_-]?key|secret|password|token)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .slice(0, 500);
}

function safeBuildClaudeMcpPreview(selectedPetId: string | undefined, commandMode: OpenPetsCommandMode): { readonly preview: ClaudeMcpPreview; readonly error?: string } {
  try {
    return { preview: withPreferredClaudeCommand(buildClaudeMcpPreview(selectedPetId, commandMode, getPreferredNodeCommand())) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Packaged OpenPets command resources are unavailable.";
    return { preview: createErrorPreview(commandMode, message), error: message };
  }
}

function safeDoctorClaudeHooks(commandMode: OpenPetsCommandMode, selectedPetId: string | undefined): ClaudeHookDoctorResult {
  try {
    return doctorClaudeHooks(undefined, commandMode, selectedPetId, getPreferredNodeCommand());
  } catch (error) {
    return createHookErrorStatus(error instanceof Error ? error.message : "Packaged OpenPets hook resources are unavailable.");
  }
}

function createErrorPreview(commandMode: OpenPetsCommandMode, message: string): ClaudeMcpPreview {
  const claude = getPreferredClaudeCommand();
  return {
    commandMode,
    add: { command: claude, args: [] },
    remove: { command: claude, args: ["mcp", "remove", "--scope", "user", "openpets"] },
    mcpJson: { mcpServers: { openpets: { type: "stdio", command: "node", args: [] } } },
    displayCommand: message,
  };
}

function withPreferredClaudeCommand(preview: ClaudeMcpPreview): ClaudeMcpPreview {
  const claude = getPreferredClaudeCommand();
  if (claude === preview.add.command && claude === preview.remove.command) return preview;
  return {
    ...preview,
    add: { ...preview.add, command: claude },
    remove: { ...preview.remove, command: claude },
    displayCommand: preview.displayCommand.replace(/^claude(?=\s|$)/, quoteCommandForDisplay(claude)),
  };
}

function createBundledResourceErrorStatus(message: string): ClaudeCodeStatus {
  return createStatus("error", "Packaged commands unavailable", message, undefined, { ok: false, timedOut: false, exitCode: null, stdout: "", stderr: "", error: message }, { present: false, source: "none", verified: false, matchesExpected: false });
}

function createHookErrorStatus(message: string): ClaudeHookDoctorResult {
  return { status: "error", settingsPath: "~/.claude/settings.json", exists: false, valid: false, message, preview: {}, asyncSupported: false };
}

async function runAction(action: AgentSetupAction, selectedPetId: string | undefined, commandMode: OpenPetsCommandMode): Promise<AgentSetupActionResult> {
  if (action === "opencode-install") return installOpenCodeGlobal(selectedPetId, commandMode);
  if (action === "opencode-remove") return removeOpenCodeGlobal();
  if (action === "cursor-install") return installCursorGlobal(selectedPetId, commandMode);
  if (action === "cursor-replace") return replaceCursorGlobal(selectedPetId, commandMode);
  if (action === "cursor-remove") return removeCursorGlobal();
  if (action === "doctor-hooks") {
    const doctor = safeDoctorClaudeHooks(commandMode, selectedPetId);
    writeActionJournal({ action: "update", selectedPetId, command: createHookJournalCommand("doctor-hooks", selectedPetId), previousStatus: doctor.status, success: doctor.status !== "error", message: doctor.message });
    return { ok: doctor.status !== "error", action, message: doctor.message, changed: false };
  }
  if (action === "uninstall-hooks") {
    let result;
    try {
      result = uninstallClaudeHooks(undefined, commandMode);
    } catch (error) {
      return { ok: false, action, message: error instanceof Error ? error.message : "OpenPets hook uninstall failed.", changed: false };
    }
    const message = result.changed ? `Uninstalled OpenPets Claude hooks. Backup: ${formatUserPath(result.backupPath) ?? "not needed"}` : result.message;
    writeActionJournal({ action: "remove", selectedPetId, command: ["open-pets-claude", "uninstall-hooks"], previousStatus: result.status, success: result.status !== "error", message });
    return { ok: result.status !== "error", action, message, changed: result.changed };
  }
  if (action === "install-memory") {
    const result = safeInstallClaudeMemory();
    return { ok: result.ok, action, message: result.ok ? result.message : `Claude instructions were not updated: ${result.message}`, changed: result.ok && result.message.startsWith("Added") };
  }
  if (action === "remove") {
    return runRemove(createErrorPreview(commandMode, ""), selectedPetId, "Unknown", action);
  }
  if (commandMode === "bundled") {
    const node = await runCommand({ command: getPreferredNodeCommand(), args: ["--version"] });
    if (!node.ok) return { ok: false, action, message: `Node.js is required for packaged OpenPets commands. Open Claude configuration, set the Node.js command path, then try again. ${summarizeCommandResult(node)}`, changed: false };
  }
  const previewResult = safeBuildClaudeMcpPreview(selectedPetId, commandMode);
  if (previewResult.error) return { ok: false, action, message: previewResult.error, changed: false };

  if (action === "install-hooks") {
    let result;
    try {
      result = installClaudeHooks(undefined, commandMode, selectedPetId, getPreferredNodeCommand());
    } catch (error) {
      return { ok: false, action, message: error instanceof Error ? error.message : "OpenPets hook install failed.", changed: false };
    }
    const message = result.changed ? `Installed OpenPets Claude hooks. Backup: ${formatUserPath(result.backupPath) ?? "not needed"}` : result.message;
    writeActionJournal({ action: "update", selectedPetId, command: createHookJournalCommand("install-hooks", selectedPetId), previousStatus: result.status, success: result.status !== "error", message });
    return { ok: result.status !== "error", action, message, changed: result.changed };
  }
  const detection = await detectClaudeCodeStatus(selectedPetId, commandMode);
  const previousStatus = detection.label;
  const preview = previewResult.preview;

  if (detection.state === "not_detected") {
    const result = { ok: false, action, message: "Claude Code was not found. Install Claude Code or use Copy command to configure manually.", changed: false };
    writeActionJournal({ action: journalActionFor(action), selectedPetId, command: [preview.add.command, ...preview.add.args], previousStatus, success: false, message: result.message });
    return result;
  }

  if (action === "configure") {
    if (detection.openPetsEntry.present && detection.openPetsEntry.verified && detection.openPetsEntry.matchesExpected) {
      const memoryResult = safeInstallClaudeMemory();
      const message = `OpenPets MCP is already configured for Claude Code.${memoryResult.ok ? ` ${memoryResult.message}` : ` Claude instructions were not updated: ${memoryResult.message}`}`;
      return { ok: true, action, message, changed: memoryResult.ok && memoryResult.message.startsWith("Added") };
    }
    if (detection.openPetsEntry.present) {
      return { ok: false, action, message: "Claude already has an openpets MCP entry. OpenPets will keep it as installed; use Replace only if you want to recreate it with the recommended command.", changed: false };
    }
    return runAdd(preview, selectedPetId, previousStatus, action);
  }

  if (!detection.openPetsEntry.present) {
    return runAdd(preview, selectedPetId, previousStatus, action);
  }

  const removed = await runRemove(preview, selectedPetId, previousStatus, action);
  if (!removed.ok) return removed;
  const added = await runAdd(preview, selectedPetId, previousStatus, action);
  if (!added.ok) {
    return {
      ok: false,
      action,
      message: `${added.message} The previous openpets entry was removed; use this command to restore the intended entry: ${preview.displayCommand}`,
      changed: true,
    };
  }
  return { ok: true, action, message: `Replaced Claude Code OpenPets MCP entry.${summarizeMemoryMessages(removed.message, added.message)}`, changed: true };
}

async function getOpenCodeSetup(commandMode: OpenPetsCommandMode, selectedPetId: string | undefined): Promise<{ readonly status: OpenCodeSetupStatus; readonly preview: OpenCodeSetupPreview }> {
  const configDir = getGlobalOpenCodeConfigDir(process.env, app.getPath("home"), process.platform);
  const petId = selectedPetId || undefined;
  const cliVersion = getCliPackageVersion();
  const pluginVersion = getOpenCodePackageVersion();
  const cliEntryPath = commandMode === "published" ? undefined : getDesktopCliEntryPath(commandMode);
  const prepared = safePrepareOpenCode(configDir, petId, cliVersion, pluginVersion, commandMode, cliEntryPath);
  const detected = await runOpenCodeCommand(["--version"]);
  const globalState = doctorOpenCodeGlobalSetup(configDir);
  const configured = globalState.status === "installed";
  return {
    status: {
      state: globalState.status === "error" || globalState.status === "custom" || globalState.status === "conflict" ? "error" : configured ? "configured" : detected.ok ? "needs_setup" : "not_detected",
      label: configured ? "Installed" : globalState.status === "custom" || globalState.status === "conflict" ? "Needs attention" : detected.ok ? "Ready" : "Not detected",
      details: globalState.status === "custom" || globalState.status === "conflict" || globalState.status === "error" ? globalState.message : configured ? globalState.message : detected.ok ? "OpenCode was detected. Desktop setup writes global OpenCode config." : getPreferredOpenCodeCommand() === getDefaultOpenCodeCommand() ? "OpenCode was not found on PATH or in a Scoop shim directory. You can still preview setup, but OpenCode must be installed to use it." : "OpenCode did not run from the saved command path. You can still preview setup, but OpenCode must be installed to use it.",
      configDir: formatUserPath(configDir) ?? configDir,
      canInstall: prepared.ok && !configured,
      canRemove: configured,
    },
    preview: {
      global: true,
      configDir: formatUserPath(configDir) ?? configDir,
      configPath: prepared.ok ? (formatUserPath(prepared.configPath) ?? prepared.configPath) : "",
      cleanupConfigPaths: prepared.ok ? prepared.cleanupConfigPaths.map((path) => formatUserPath(path) ?? path) : [],
      mcpCommand: prepared.ok ? prepared.command : [],
      plugin: prepared.ok ? prepared.plugin : (petId ? [`@open-pets/opencode@${pluginVersion}`, { pet: petId }] : `@open-pets/opencode@${pluginVersion}`),
      instructionPath: prepared.ok ? (formatUserPath(prepared.instructionPath) ?? prepared.instructionPath) : "",
      configPreview: prepared.ok ? prepared.configPreview : {},
    },
  };
}

async function getCursorSetup(commandMode: OpenPetsCommandMode, selectedPetId: string | undefined): Promise<{ readonly status: CursorSetupStatus; readonly preview: CursorSetupPreview }> {
  const homeDir = app.getPath("home");
  const configPath = getCursorGlobalMcpPath(homeDir);
  const petId = selectedPetId || undefined;
  const mcpVersion = getMcpPackageVersion();

  const configResult = readCursorMcpConfig(configPath);
  const statusResult = classifyCursorMcpStatus(configResult, configPath, { mcpVersion, petId, commandMode: "published" });

  const state = mapCursorStatusToState(statusResult.status);
  const label = mapCursorStatusToLabel(statusResult.status);
  const details = statusResult.message;

  return {
    status: {
      state,
      label,
      details,
      configPath: formatUserPath(configPath) ?? configPath,
      canInstall: statusResult.canInstall,
      canReplace: statusResult.canReplace,
      canRemove: statusResult.canRemove,
    },
    preview: {
      global: true,
      configPath: formatUserPath(configPath) ?? configPath,
      mcpEntry: buildOpenPetsOnlyPreview({ mcpVersion, petId, commandMode: "published" }),
      rulesPath: ".cursor/rules/openpets.mdc",
      rulesContent: buildCursorRulesPreview(),
      commandMode: "published",
    },
  };
}

function mapCursorStatusToState(status: CursorMcpStatusResult["status"]): CursorSetupStatus["state"] {
  switch (status) {
    case "installed":
      return "configured";
    case "missing":
      return "needs_setup";
    case "needs-update":
      return "needs_update";
    case "conflict":
      return "conflict";
    case "invalid":
    case "error":
      return "error";
    default:
      return "error";
  }
}

function mapCursorStatusToLabel(status: CursorMcpStatusResult["status"]): string {
  switch (status) {
    case "installed":
      return "Configured";
    case "missing":
      return "Not configured";
    case "needs-update":
      return "Needs update";
    case "conflict":
      return "Conflict";
    case "invalid":
    case "error":
      return "Config error";
    default:
      return "Checking";
  }
}

function getAgentSetupCommandPaths(): AgentSetupCommandPaths {
  const preferences = getAppStateSnapshot().preferences;
  return {
    claude: preferences.claudeCommandPath ?? "",
    node: preferences.nodeCommandPath ?? "",
    opencode: preferences.opencodeCommandPath ?? "",
  };
}

function getPreferredClaudeCommand(): string {
  return getAppStateSnapshot().preferences.claudeCommandPath || "claude";
}

function getPreferredNodeCommand(): string {
  return getAppStateSnapshot().preferences.nodeCommandPath || "node";
}

function getPreferredOpenCodeCommand(): string {
  return getAppStateSnapshot().preferences.opencodeCommandPath || getDefaultOpenCodeCommand();
}

function normalizeOptionalCommandPath(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} command path must be text.`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 4096 || /[\r\n\0]/.test(trimmed)) throw new Error(`${label} command path is invalid.`);
  if (!isAbsolute(trimmed)) throw new Error(`${label} command path must be a full absolute path.`);
  if (process.platform === "win32" && /[&|<>^%!]/.test(trimmed)) throw new Error(`${label} command path contains unsupported shell characters.`);
  try {
    const stat = statSync(trimmed);
    if (!stat.isFile()) throw new Error();
    if (process.platform !== "win32") accessSync(trimmed, constants.X_OK);
  } catch {
    throw new Error(`${label} command path must point to an existing executable file.`);
  }
  return trimmed;
}

function quoteCommandForDisplay(command: string): string {
  return /\s/.test(command) ? JSON.stringify(command) : command;
}

function safePrepareOpenCode(configDir: string, selectedPetId: string | undefined, cliVersion: string, pluginVersion: string, commandMode: OpenPetsCommandMode, cliEntryPath: string | undefined): { readonly ok: true; readonly command: readonly string[]; readonly configPath: string; readonly cleanupConfigPaths: readonly string[]; readonly instructionPath: string; readonly plugin: readonly unknown[] | string; readonly configPreview: Record<string, unknown> } | { readonly ok: false; readonly message: string } {
  try {
    const prepared = prepareOpenCodeGlobalSetup({ configDir, petId: selectedPetId || undefined, cliVersion, pluginVersion, commandMode, cliEntryPath });
    const parsed = parseOpenCodeConfig(prepared.configWrite.content);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    const config = parsed.value as { mcp?: { openpets?: { command?: readonly string[] } }; plugin?: readonly unknown[] };
    const plugin = Array.isArray(config.plugin) ? config.plugin[config.plugin.length - 1] : undefined;
    return { ok: true, command: config.mcp?.openpets?.command ?? [], configPath: prepared.configPath, cleanupConfigPaths: prepared.cleanupConfigWrites.map((write) => write.targetPath), instructionPath: prepared.instructionPath, plugin: plugin === undefined ? [] : (plugin as readonly unknown[] | string), configPreview: parsed.value };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "OpenCode setup preview failed." };
  }
}

async function installOpenCodeGlobal(selectedPetId: string | undefined, commandMode: OpenPetsCommandMode): Promise<AgentSetupActionResult> {
  if (commandMode === "bundled") {
    const node = await runCommand({ command: getPreferredNodeCommand(), args: ["--version"] });
    if (!node.ok) return { ok: false, action: "opencode-install", message: `Node.js is required for packaged OpenPets commands. Open OpenCode configuration, set the Node.js command path, then try again. ${summarizeCommandResult(node)}`, changed: false };
  }
  try {
    const configDir = getGlobalOpenCodeConfigDir(process.env, app.getPath("home"), process.platform);
    const prepared = prepareOpenCodeGlobalSetup({ configDir, petId: selectedPetId || undefined, cliVersion: getCliPackageVersion(), pluginVersion: getOpenCodePackageVersion(), commandMode, cliEntryPath: commandMode === "published" ? undefined : getDesktopCliEntryPath(commandMode) });
    writePreparedOpenCodeGlobalSetup(prepared);
    return { ok: true, action: "opencode-install", message: `Installed global OpenCode OpenPets setup. Config: ${formatUserPath(prepared.configPath) ?? prepared.configPath}. Instructions: ${formatUserPath(prepared.instructionPath) ?? prepared.instructionPath}.`, changed: true };
  } catch (error) {
    return { ok: false, action: "opencode-install", message: error instanceof Error ? error.message : "OpenCode setup failed.", changed: false };
  }
}

async function removeOpenCodeGlobal(): Promise<AgentSetupActionResult> {
  try {
    const configDir = getGlobalOpenCodeConfigDir(process.env, app.getPath("home"), process.platform);
    const prepared = prepareOpenCodeGlobalRemove(configDir);
    writePreparedOpenCodeGlobalRemove(prepared);
    return { ok: true, action: "opencode-remove", message: prepared.configWrites.length > 0 ? "Removed global OpenCode OpenPets setup." : "Global OpenCode OpenPets setup was already absent.", changed: prepared.configWrites.length > 0 };
  } catch (error) {
    return { ok: false, action: "opencode-remove", message: error instanceof Error ? error.message : "OpenCode removal failed.", changed: false };
  }
}

async function installCursorGlobal(selectedPetId: string | undefined, commandMode: OpenPetsCommandMode): Promise<AgentSetupActionResult> {
  void commandMode;
  try {
    const homeDir = app.getPath("home");
    const configPath = getCursorGlobalMcpPath(homeDir);
    const mcpVersion = getMcpPackageVersion();
    const plan = planCursorMcpInstall(configPath, { mcpVersion, petId: selectedPetId || undefined, commandMode: "published" });
    if ("ok" in plan && !plan.ok) {
      return { ok: false, action: "cursor-install", message: plan.message, changed: false };
    }
    if ("targetPath" in plan) {
      executeCursorMcpWrite(plan);
      const backupMsg = plan.backupPath ? ` Backup: ${formatUserPath(plan.backupPath) ?? plan.backupPath}.` : "";
      return { ok: true, action: "cursor-install", message: `Installed Cursor OpenPets MCP config at ${formatUserPath(configPath) ?? configPath}.${backupMsg} Cursor may need to be restarted or reloaded.`, changed: true };
    }
    return { ok: false, action: "cursor-install", message: "Failed to plan Cursor MCP install.", changed: false };
  } catch (error) {
    return { ok: false, action: "cursor-install", message: error instanceof Error ? error.message : "Cursor MCP install failed.", changed: false };
  }
}

async function replaceCursorGlobal(selectedPetId: string | undefined, commandMode: OpenPetsCommandMode): Promise<AgentSetupActionResult> {
  void commandMode;
  try {
    const homeDir = app.getPath("home");
    const configPath = getCursorGlobalMcpPath(homeDir);
    const mcpVersion = getMcpPackageVersion();
    const plan = planCursorMcpReplace(configPath, { mcpVersion, petId: selectedPetId || undefined, commandMode: "published" });
    if ("ok" in plan && !plan.ok) {
      return { ok: false, action: "cursor-replace", message: plan.message, changed: false };
    }
    if ("targetPath" in plan) {
      executeCursorMcpWrite(plan);
      const backupMsg = plan.backupPath ? ` Backup: ${formatUserPath(plan.backupPath) ?? plan.backupPath}.` : "";
      return { ok: true, action: "cursor-replace", message: `Replaced Cursor OpenPets MCP config at ${formatUserPath(configPath) ?? configPath}.${backupMsg} Cursor may need to be restarted or reloaded.`, changed: true };
    }
    return { ok: false, action: "cursor-replace", message: "Failed to plan Cursor MCP replace.", changed: false };
  } catch (error) {
    return { ok: false, action: "cursor-replace", message: error instanceof Error ? error.message : "Cursor MCP replace failed.", changed: false };
  }
}

async function removeCursorGlobal(): Promise<AgentSetupActionResult> {
  try {
    const homeDir = app.getPath("home");
    const configPath = getCursorGlobalMcpPath(homeDir);
    const plan = planCursorMcpRemove(configPath);
    if ("ok" in plan && !plan.ok) {
      return { ok: false, action: "cursor-remove", message: plan.message, changed: false };
    }
    if ("targetPath" in plan) {
      executeCursorMcpWrite(plan);
      return { ok: true, action: "cursor-remove", message: `Removed Cursor OpenPets MCP config at ${formatUserPath(configPath) ?? configPath}. Cursor may need to be restarted or reloaded.`, changed: true };
    }
    return { ok: false, action: "cursor-remove", message: "Failed to plan Cursor MCP remove.", changed: false };
  } catch (error) {
    return { ok: false, action: "cursor-remove", message: error instanceof Error ? error.message : "Cursor MCP remove failed.", changed: false };
  }
}

function getDesktopCliEntryPath(commandMode: OpenPetsCommandMode): string {
  const path = require.resolve("@open-pets/cli");
  return commandMode === "bundled" ? mapAsarPathToUnpacked(path) : path;
}

function getCliPackageVersion(): string {
  return getWorkspacePackageVersion("@open-pets/cli");
}

function getOpenCodePackageVersion(): string {
  return getWorkspacePackageVersion("@open-pets/opencode");
}

function getWorkspacePackageVersion(packageName: string): string {
  try {
    const entryPath = require.resolve(packageName);
    const packageJsonPath = join(dirname(dirname(entryPath)), "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { readonly version?: unknown };
    return typeof packageJson.version === "string" && packageJson.version ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function getMcpPackageVersion(): string {
  return getWorkspacePackageVersion("@open-pets/mcp");
}

function summarizeMemoryMessages(...messages: readonly string[]): string {
  const memoryMessages = messages.flatMap((message) => message.match(/Claude (?:OpenPets )?instructions[^.]*\./g) ?? []);
  return memoryMessages.length > 0 ? ` ${memoryMessages.join(" ")}` : "";
}

function createHookJournalCommand(command: "doctor-hooks" | "install-hooks", selectedPetId: string | undefined): readonly string[] {
  return selectedPetId ? ["open-pets-claude", command, "--pet", selectedPetId] : ["open-pets-claude", command];
}

async function runAdd(preview: ClaudeMcpPreview, selectedPetId: string | undefined, previousStatus: string, action: AgentSetupAction): Promise<AgentSetupActionResult> {
  const result = await runClaudeCommand(preview.add);
  const memoryResult = result.ok ? safeInstallClaudeMemory() : { ok: false as const, message: "" };
  const message = result.ok
    ? `Configured Claude Code OpenPets MCP entry.${memoryResult.ok ? ` ${memoryResult.message}` : ` Claude instructions were not updated: ${memoryResult.message}`}`
    : `Claude MCP add failed: ${summarizeCommandResult(result)}`;
  writeActionJournal({ action: journalActionFor(action), selectedPetId, command: [preview.add.command, ...preview.add.args], previousStatus, success: result.ok, message });
  return { ok: result.ok, action, message, changed: result.ok };
}

async function runRemove(preview: ClaudeMcpPreview, selectedPetId: string | undefined, previousStatus: string, action: AgentSetupAction): Promise<AgentSetupActionResult> {
  const result = await runClaudeCommand(preview.remove);
  const memoryResult = result.ok ? safeUninstallClaudeMemory() : { ok: false as const, message: "" };
  const message = result.ok
    ? `Removed Claude Code OpenPets MCP entry.${memoryResult.ok ? ` ${memoryResult.message}` : ` Claude instructions were not updated: ${memoryResult.message}`}`
    : `Claude MCP remove failed: ${summarizeCommandResult(result)}`;
  writeActionJournal({ action: journalActionFor(action), selectedPetId, command: [preview.remove.command, ...preview.remove.args], previousStatus, success: result.ok, message });
  return { ok: result.ok, action, message, changed: result.ok };
}

function safeInstallClaudeMemory(): { readonly ok: true; readonly message: string } | { readonly ok: false; readonly message: string } {
  try {
    const result = installClaudeOpenPetsMemory(app.getPath("home"));
    return { ok: true, message: result.changed ? "Added Claude OpenPets instructions." : "Claude OpenPets instructions already present." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Unknown error." };
  }
}

function safeUninstallClaudeMemory(): { readonly ok: true; readonly message: string } | { readonly ok: false; readonly message: string } {
  try {
    const result = uninstallClaudeOpenPetsMemory(app.getPath("home"));
    return { ok: true, message: result.changed ? "Removed Claude OpenPets instructions." : "Claude OpenPets instructions were already absent." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Unknown error." };
  }
}

async function detectClaudeCodeStatus(selectedPetId: string | undefined, commandMode: OpenPetsCommandMode): Promise<ClaudeCodeStatus> {
  if (commandMode === "bundled") {
    const node = await runCommand({ command: getPreferredNodeCommand(), args: ["--version"] });
    if (!node.ok) return createStatus("error", "Node required", `Node.js is required for packaged OpenPets commands. Open Claude configuration, expand Advanced detection, set the Node.js command path, then try again. ${summarizeCommandResult(node)}`, undefined, node, { present: false, source: "none", verified: false, matchesExpected: false });
  }

  const version = await runClaudeCommand({ command: "claude", args: ["--version"] });
  if (!version.ok) {
    const hasOverride = getPreferredClaudeCommand() !== "claude";
    return createStatus("not_detected", "Not detected", `${hasOverride ? "Claude Code did not run from the saved command path" : "Claude Code was not found or did not run"}: ${summarizeCommandResult(version)}`, undefined, version, { present: false, source: "none", verified: false, matchesExpected: false });
  }

  const list = await runClaudeCommandWithTimeoutRetry({ command: "claude", args: ["mcp", "list"] });
  if (!list.ok) {
    return createStatus("error", "Error / needs attention", `Claude Code was detected, but MCP status failed: ${summarizeCommandResult(list)}`, sanitizeAgentSetupOutput(version.stdout || version.stderr), list, { present: false, source: "none", verified: false, matchesExpected: false });
  }

  const listed = classifyClaudeMcpStatus(list.stdout, undefined, selectedPetId, commandMode, getPreferredNodeCommand());
  let entry = listed;
  if (listed.present) {
    const get = await runClaudeCommand(buildClaudeMcpGetCommand());
    if (get.ok) entry = classifyClaudeMcpStatus(list.stdout, get.stdout, selectedPetId, commandMode, getPreferredNodeCommand());
  }

  if (!entry.present) return createStatus("needs_setup", "Needs setup", "Claude Code is detected, but OpenPets MCP is not configured.", sanitizeAgentSetupOutput(version.stdout || version.stderr), list, entry);
  if (entry.verified && entry.matchesExpected) return createStatus("configured", "Configured", "Claude Code has the expected OpenPets MCP entry.", sanitizeAgentSetupOutput(version.stdout || version.stderr), list, entry);
  if (entry.verified) return createStatus("configured", "Installed — custom", "Claude Code has an openpets MCP entry with a custom command. OpenPets will leave it alone unless you choose Replace with recommended.", sanitizeAgentSetupOutput(version.stdout || version.stderr), list, entry);
  return createStatus("configured", "Installed — unverified", "Claude Code lists an openpets MCP entry, but command details were not available. OpenPets will leave it alone unless you choose Replace with recommended.", sanitizeAgentSetupOutput(version.stdout || version.stderr), list, entry);
}

async function runClaudeCommandWithTimeoutRetry(spec: ClaudeCommandSpec): Promise<CommandResult> {
  const first = await runClaudeCommand(spec);
  if (!first.timedOut) return first;
  await delay(250);
  const second = await runClaudeCommand(spec);
  return second.ok ? second : first;
}

function createStatus(state: ClaudeCodeStatus["state"], label: string, details: string, version: string | undefined, listResult: CommandResult, entry: ParsedClaudeMcpEntry): ClaudeCodeStatus {
  return {
    state,
    label,
    details,
    claudeCommand: "claude",
    version,
    mcpListWorks: listResult.ok,
    openPetsEntry: entry,
    canConfigure: state === "needs_setup",
    canReplace: entry.present && !(entry.verified && entry.matchesExpected),
    canRemove: entry.present,
  };
}

function validateSelectedPetId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Invalid selected pet id.");
  const pet = getAppStateSnapshot().pets.installed.find((candidate) => candidate.id === value);
  if (!pet || pet.broken) throw new Error("Selected pet is not installed or is broken.");
  return pet.id;
}

function validateCommandMode(value: unknown): OpenPetsCommandMode {
  if (app.isPackaged) return "bundled";
  return value === "local" ? "local" : "published";
}

function getPetOptions(): readonly AgentSetupPetOption[] {
  const state = getAppStateSnapshot();
  return state.pets.installed.filter(isUsablePet).map((pet) => ({ id: pet.id, displayName: pet.displayName, default: pet.id === state.preferences.defaultPetId }));
}

function isUsablePet(pet: InstalledPetState): boolean {
  return pet.installed && !pet.broken && !pet.builtIn;
}

async function runClaudeCommand(spec: ClaudeCommandSpec): Promise<CommandResult> {
  for (const command of getClaudeCommandCandidates(spec.command)) {
    const result = await runCommand({ command, args: spec.args });
    if (result.ok || !isCommandNotFound(result)) return result;
  }
  return { ok: false, timedOut: false, exitCode: null, stdout: "", stderr: "", error: "Claude command was not found." };
}

async function runOpenCodeCommand(args: readonly string[]): Promise<CommandResult> {
  const preferences = getAppStateSnapshot().preferences;
  const commands = getOpenCodeCommandCandidates({
    configuredCommand: preferences.opencodeCommandPath,
    env: process.env,
    homeDir: app.getPath("home"),
    platform: process.platform,
  });
  for (const command of commands) {
    const result = await runCommand({ command, args });
    if (result.ok || !isCommandNotFound(result)) return result;
  }
  return { ok: false, timedOut: false, exitCode: null, stdout: "", stderr: "", error: "OpenCode command was not found." };
}

function runCommand(spec: ClaudeCommandSpec): Promise<CommandResult> {
  return new Promise((resolve) => {
    const command = process.platform === "win32" && spec.command.toLowerCase().endsWith(".cmd") ? "cmd.exe" : spec.command;
    const args = process.platform === "win32" && spec.command.toLowerCase().endsWith(".cmd") ? ["/d", "/s", "/c", spec.command, ...spec.args] : spec.args;
    let child;
    try {
      child = spawn(command, args, { cwd: app.getPath("home"), env: createCommandEnv(), windowsHide: true, shell: false });
    } catch (error) {
      resolve({ ok: false, timedOut: false, exitCode: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : "Command failed to start." });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, timedOut: true, exitCode: null, stdout: sanitizeAgentSetupOutput(stdout), stderr: sanitizeAgentSetupOutput(stderr), error: "Command timed out." });
    }, commandTimeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => { stdout = appendBounded(stdout, chunk.toString("utf8")); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, chunk.toString("utf8")); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, timedOut: false, exitCode: null, stdout: sanitizeAgentSetupOutput(stdout), stderr: sanitizeAgentSetupOutput(stderr), error: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, timedOut: false, exitCode: code, stdout: sanitizeAgentSetupOutput(stdout), stderr: sanitizeAgentSetupOutput(stderr), error: undefined });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClaudeCommandCandidates(command: string): readonly string[] {
  if (command !== "claude") return [command];
  const preferred = getPreferredClaudeCommand();
  if (preferred !== "claude") return [preferred];
  if (process.platform === "win32") return ["claude", "claude.cmd"];
  return ["claude"];
}

function createCommandEnv(): NodeJS.ProcessEnv {
  const separator = process.platform === "win32" ? ";" : ":";
  const existingPath = process.env.PATH ?? "";
  return { ...process.env, PATH: dedupePathEntries([existingPath, ...getExtraCommandPaths()], separator).join(separator) };
}

function getExtraCommandPaths(): readonly string[] {
  if (process.platform === "win32") return [];
  const home = app.getPath("home");
  const env = process.env;
  return filterExistingPaths([
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    join(home, "bin"),
    join(home, ".local", "bin"),
    join(home, ".opencode", "bin"),
    join(env.VOLTA_HOME || join(home, ".volta"), "bin"),
    join(env.BUN_INSTALL || join(home, ".bun"), "bin"),
    join(env.MISE_DATA_DIR || join(home, ".local", "share", "mise"), "shims"),
    join(env.ASDF_DATA_DIR || join(home, ".asdf"), "shims"),
    env.PNPM_HOME,
    join(home, ".local", "share", "pnpm"),
    join(home, "Library", "pnpm"),
    join(env.NVM_DIR || join(home, ".nvm"), "current", "bin"),
  ]);
}

function filterExistingPaths(paths: readonly (string | undefined)[]): readonly string[] {
  return paths.filter((path): path is string => Boolean(path && existsSync(path)));
}

function dedupePathEntries(paths: readonly string[], separator: string): readonly string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const path of paths.flatMap((value) => value.split(separator)).filter(Boolean)) {
    if (seen.has(path)) continue;
    seen.add(path);
    entries.push(path);
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCommandNotFound(result: CommandResult): boolean {
  return Boolean(result.error && /ENOENT|not found/i.test(result.error));
}

function summarizeCommandResult(result: CommandResult): string {
  if (result.timedOut) return "command timed out.";
  const output = sanitizeAgentSetupOutput(result.stderr || result.stdout || result.error || `exit code ${result.exitCode ?? "unknown"}`);
  return output || "command failed.";
}

function formatUserPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.replace(app.getPath("home"), "~");
}

function appendBounded(existing: string, next: string): string {
  const combined = existing + next;
  return combined.length > maxOutputBytes ? combined.slice(combined.length - maxOutputBytes) : combined;
}

function writeActionJournal(entry: Omit<AgentSetupJournalEntry, "timestamp"> & { readonly timestamp?: string }): void {
  try {
    const path = getJournalPath();
    const entries = readActionJournal().concat({ ...entry, command: entry.command.map((part) => formatUserPath(part) ?? part), message: sanitizeAgentSetupOutput(entry.message), timestamp: entry.timestamp || new Date().toISOString() }).slice(-20);
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    console.error("Failed to write OpenPets agent setup action journal.", error);
  }
}

function readActionJournal(): AgentSetupJournalEntry[] {
  const path = getJournalPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isJournalEntry).slice(-20) : [];
  } catch {
    return [];
  }
}

function getJournalPath(): string {
  return join(app.getPath("userData"), "agent-setup-actions.json");
}

function isJournalEntry(value: unknown): value is AgentSetupJournalEntry {
  return typeof value === "object" && value !== null && typeof (value as { timestamp?: unknown }).timestamp === "string";
}

function journalActionFor(action: AgentSetupAction): JournalAction {
  if (action === "replace") return "replace";
  if (action === "remove") return "remove";
  return "configure";
}

export const agentSetupInternalsForChecks = {
  sanitizeAgentSetupOutput,
  createOpenPetsHookSettingsPreview,
};
