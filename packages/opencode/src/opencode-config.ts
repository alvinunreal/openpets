import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";

import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

export interface OpenCodeConfigPaths {
  readonly candidates: readonly string[];
  readonly defaultCreatePath: string;
}

export interface ParsedOpenCodeConfig {
  readonly ok: true;
  readonly value: Record<string, unknown>;
}

export interface OpenCodeConfigError {
  readonly ok: false;
  readonly message: string;
}

export interface PlannedWrite {
  readonly rootPath: string;
  readonly targetPath: string;
  readonly backupPath?: string;
  readonly tempPath: string;
  readonly content: string;
}

export interface OpenCodeExecutableDetection {
  readonly command: "opencode" | "opencode.cmd";
  readonly platform: NodeJS.Platform | string;
  readonly available: boolean;
  readonly version?: string;
  readonly error?: string;
}

export const maxOpenCodeConfigBytes = 1024 * 1024;

export function getProjectOpenCodeConfigPaths(projectDir: string): OpenCodeConfigPaths {
  const root = assertSafeProjectRoot(projectDir);
  return {
    candidates: [join(root, "opencode.json"), join(root, "opencode.jsonc"), join(root, ".opencode", "opencode.json"), join(root, ".opencode", "opencode.jsonc")],
    defaultCreatePath: join(root, ".opencode", "opencode.jsonc"),
  };
}

export function selectProjectOpenCodeConfigPath(projectDir: string): string {
  const paths = getProjectOpenCodeConfigPaths(projectDir);
  return paths.candidates.find((candidate) => existsSync(candidate)) ?? paths.defaultCreatePath;
}

export function getGlobalOpenCodeConfigDir(env: NodeJS.ProcessEnv = process.env, homeDir = homedir(), _platform = process.platform): string {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME || join(homeDir, ".config"), "opencode");
}

export function getGlobalOpenCodeConfigPaths(env: NodeJS.ProcessEnv = process.env, homeDir = homedir(), platform = process.platform): OpenCodeConfigPaths {
  const configDir = getGlobalOpenCodeConfigDir(env, homeDir, platform);
  return {
    candidates: [join(configDir, "config.json"), join(configDir, "opencode.json"), join(configDir, "opencode.jsonc")],
    defaultCreatePath: join(configDir, "opencode.jsonc"),
  };
}

export function createOpenCodeExecutableDetection(input: Partial<OpenCodeExecutableDetection> & { readonly platform?: NodeJS.Platform | string } = {}): OpenCodeExecutableDetection {
  const platform = input.platform ?? process.platform;
  return {
    command: input.command ?? "opencode",
    platform,
    available: input.available ?? false,
    version: input.version,
    error: input.error,
  };
}

export function readOpenCodeConfigFile(path: string): ParsedOpenCodeConfig | OpenCodeConfigError {
  const safety = assertSafeExistingConfigFile(path);
  if (!safety.ok) return safety;
  return parseOpenCodeConfig(readFileSync(path, "utf8"));
}

export function parseOpenCodeConfig(text: string): ParsedOpenCodeConfig | OpenCodeConfigError {
  if (Buffer.byteLength(text, "utf8") > maxOpenCodeConfigBytes) return { ok: false, message: "OpenCode config is too large." };
  const errors: ParseError[] = [];
  const parsed = parse(text || "{}", errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0) return { ok: false, message: "OpenCode config JSONC is invalid." };
  if (!isRecord(parsed) || Array.isArray(parsed)) return { ok: false, message: "OpenCode config must be a JSON object." };
  const fields = validateKnownFieldTypes(parsed);
  if (!fields.ok) return fields;
  return { ok: true, value: parsed };
}

export function updateOpenCodeConfigText(text: string, updates: readonly { readonly path: readonly (string | number)[]; readonly value: unknown }[]): string | OpenCodeConfigError {
  const parsed = parseOpenCodeConfig(text);
  if (!parsed.ok) return parsed;
  let next = text.trim() ? text : "{}\n";
  for (const update of updates) {
    const edits = modify(next, [...update.path], update.value, { formattingOptions: { tabSize: 2, insertSpaces: true } });
    next = applyEdits(next, edits);
  }
  return next.endsWith("\n") ? next : `${next}\n`;
}

export function planOpenCodeConfigWrite(rootPath: string, targetPath: string, content: string): PlannedWrite | OpenCodeConfigError {
  const root = assertSafeProjectRoot(rootPath);
  const rel = relative(root, targetPath);
  if (rel.startsWith("..") || isAbsolute(rel)) return { ok: false, message: "OpenCode config target must stay inside the validated root." };
  const parent = dirname(targetPath);
  const parentSafety = assertSafeParentDirectory(parent);
  if (!parentSafety.ok) return parentSafety;
  const existing = assertSafeExistingConfigFile(targetPath, true);
  if (!existing.ok) return existing;
  const parsed = parseOpenCodeConfig(content);
  if (!parsed.ok) return parsed;
  const stamp = `${process.pid}-${Date.now()}-${randomUUID()}`;
  return {
    rootPath: root,
    targetPath,
    backupPath: existsSync(targetPath) ? uniquePath(`${targetPath}.openpets-backup-${stamp}.json`) : undefined,
    tempPath: uniquePath(join(parent, `.openpets-${stamp}.tmp`)),
    content,
  };
}

export function executePlannedWrite(plan: PlannedWrite): void {
  const root = assertSafeProjectRoot(plan.rootPath);
  const rel = relative(root, plan.targetPath);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("OpenCode write target escaped validated root.");
  for (const path of [plan.backupPath, plan.tempPath].filter((value): value is string => typeof value === "string")) {
    const pathRel = relative(root, path);
    if (pathRel.startsWith("..") || isAbsolute(pathRel)) throw new Error("OpenCode write support path escaped validated root.");
    if (dirname(path) !== dirname(plan.targetPath)) throw new Error("OpenCode write support path must stay next to target.");
  }
  const parentSafety = assertSafeParentDirectory(dirname(plan.targetPath));
  if (!parentSafety.ok) throw new Error(parentSafety.message);
  const targetSafety = assertSafeExistingConfigFile(plan.targetPath, true);
  if (!targetSafety.ok) throw new Error(targetSafety.message);
  const parsed = parseOpenCodeConfig(plan.content);
  if (!parsed.ok) throw new Error(parsed.message);
  mkdirSync(dirname(plan.targetPath), { recursive: true, mode: 0o700 });
  if (plan.backupPath && existsSync(plan.targetPath)) {
    const backupFd = openSync(plan.backupPath, "wx", 0o600);
    try {
      writeFileSync(backupFd, readFileSync(plan.targetPath));
    } finally {
      closeSync(backupFd);
    }
  }
  const fd = openSync(plan.tempPath, "wx", 0o600);
  try {
    writeFileSync(fd, plan.content, "utf8");
  } finally {
    closeSync(fd);
  }
  renameSync(plan.tempPath, plan.targetPath);
  try { chmodSync(plan.targetPath, 0o600); } catch { /* best effort */ }
}

export function assertSafeProjectRoot(projectDir: string): string {
  if (!isAbsolute(projectDir)) throw new Error("OpenCode project path must be absolute.");
  if (!existsSync(projectDir)) throw new Error("OpenCode project path does not exist.");
  const stat = lstatSync(projectDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("OpenCode project path must be a safe directory.");
  return projectDir;
}

function assertSafeExistingConfigFile(path: string, allowMissing = false): OpenCodeConfigError | { readonly ok: true } {
  if (!existsSync(path)) return allowMissing ? { ok: true } : { ok: false, message: "OpenCode config does not exist." };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, message: "OpenCode config path must be a regular file." };
  if (stat.size > maxOpenCodeConfigBytes) return { ok: false, message: "OpenCode config is too large." };
  return { ok: true };
}

function assertSafeParentDirectory(path: string): OpenCodeConfigError | { readonly ok: true } {
  const existing = nearestExistingParent(path);
  const rel = relative(existing, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return { ok: false, message: "OpenCode config parent escapes target directory." };
  let current = existing;
  while (current !== dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return { ok: false, message: "OpenCode config parent must not be a symlink." };
    if (current === path) break;
    current = dirname(current);
  }
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, message: "OpenCode config parent must be a safe directory." };
  }
  return { ok: true };
}

function nearestExistingParent(path: string): string {
  let current = path;
  while (!existsSync(current)) current = dirname(current);
  if (!statSync(current).isDirectory()) current = dirname(current);
  return current;
}

function validateKnownFieldTypes(config: Record<string, unknown>): OpenCodeConfigError | { readonly ok: true } {
  if (config.mcp !== undefined && !isRecord(config.mcp)) return { ok: false, message: "OpenCode config mcp field must be an object." };
  if (config.instructions !== undefined && !Array.isArray(config.instructions)) return { ok: false, message: "OpenCode config instructions field must be an array." };
  if (Array.isArray(config.instructions) && !config.instructions.every((entry) => typeof entry === "string")) return { ok: false, message: "OpenCode config instructions entries must be strings." };
  if (config.plugin !== undefined && !Array.isArray(config.plugin)) return { ok: false, message: "OpenCode config plugin field must be an array." };
  return { ok: true };
}

function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${path}.${index}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Unable to allocate unique OpenCode temp path.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
