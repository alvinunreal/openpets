import electron from "electron";
const { app, shell } = electron || {};
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogScope = "app" | "ipc" | "lease" | "pet.default" | "pet.agent" | "pet.window" | "plugin" | "state" | "tray" | "ui" | "remote" | "terminal-focus" | "window-tracker" | "capabilities";

type LogFields = Record<string, unknown>;

const levelPriority = { debug: 10, info: 20, warn: 30, error: 40 } as const satisfies Record<LogLevel, number>;
const maxLogBytes = 2 * 1024 * 1024;

let configuredLevel: LogLevel = normalizeLogLevel(process.env.OPENPETS_LOG_LEVEL) ?? "debug";
let logFilePath: string | null = null;
let previousLogFilePath: string | null = null;
let mirrorToConsole = isDevRun() || process.env.OPENPETS_LOG_CONSOLE === "1";

export function initializeLogger(): void {
  try {
    const logsDir = getLogsDir();
    mkdirSync(logsDir, { recursive: true });
    logFilePath = join(logsDir, "openpets.log");
    previousLogFilePath = join(logsDir, "openpets.previous.log");
    rotateCurrentLog(logFilePath, previousLogFilePath);
    writeFileSync(logFilePath, "", { flag: "a" });
    info("app", "logger initialized", { logFile: logFilePath, previousLogFile: previousLogFilePath, level: configuredLevel, console: mirrorToConsole });
  } catch (initError: unknown) {
    const message = initError instanceof Error ? initError.message : String(initError);
    logFilePath = null;
    previousLogFilePath = null;
    console.error("OpenPets file logger unavailable; continuing without log file.", redactLogText(message));
  }
}

export function getLogsDir(): string {
  return join(app.getPath("userData"), "logs");
}

export function getLogFilePath(): string | null {
  return logFilePath;
}

export async function openLogsFolder(): Promise<void> {
  try {
    mkdirSync(getLogsDir(), { recursive: true });
    await shell.openPath(getLogsDir());
  } catch (openError: unknown) {
    error("app", "open logs folder failed", openError);
  }
}

export function debug(scope: LogScope, message: string, fields?: LogFields): void {
  writeLog("debug", scope, message, fields);
}

export function info(scope: LogScope, message: string, fields?: LogFields): void {
  writeLog("info", scope, message, fields);
}

export function warn(scope: LogScope, message: string, fields?: LogFields): void {
  writeLog("warn", scope, message, fields);
}

export function error(scope: LogScope, message: string, errorOrFields?: unknown, fields?: LogFields): void {
  const normalized = errorOrFields instanceof Error ? { ...fields, error: formatError(errorOrFields) } : { ...(isRecord(errorOrFields) ? errorOrFields : { error: errorOrFields }), ...fields };
  writeLog("error", scope, message, normalized);
}

/** Redact bearer tokens and remote endpoints before they reach any log sink. */
export function redactLogText(value: string): string {
  return value
    .replace(/\btcp:\/\/(?:\[[^\]\s]+\]|[A-Za-z0-9._:-]+):\d{1,5}\b/gi, "[redacted-endpoint]")
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g, "[redacted-token]")
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43,}(?![A-Za-z0-9_-])/g, "[redacted-token]")
    .replace(/[A-Za-z0-9+/=]{40,}/g, "[redacted-token]");
}

function writeLog(level: LogLevel, scope: LogScope, message: string, fields: LogFields | undefined): void {
  if (levelPriority[level] < levelPriority[configuredLevel]) return;
  let line: string;
  try {
    line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${scope.padEnd(12)} ${redactLogText(message)}${formatFields(fields)}\n`;
  } catch (formatError) {
    line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${scope.padEnd(12)} ${redactLogText(message)} logFormatError=${JSON.stringify(redactLogText(formatError instanceof Error ? formatError.message : String(formatError)))}\n`;
  }

  if (mirrorToConsole) {
    try {
      const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      writer(line.trimEnd());
    } catch {
      // Logging must never affect app behavior.
    }
  }

  if (!logFilePath) return;
  void appendFile(logFilePath, line, "utf8").catch((appendError: unknown) => {
    if (mirrorToConsole) console.error("Failed to write OpenPets log file.", appendError instanceof Error ? formatError(appendError) : redactLogText(String(appendError)));
  });
}

function rotateCurrentLog(currentPath: string, previousPath: string): void {
  if (!existsSync(currentPath)) return;
  try {
    const current = statSync(currentPath);
    if (current.size <= 0) return;
    if (existsSync(previousPath)) renameSync(previousPath, join(dirname(previousPath), "openpets.previous.old.log"));
    renameSync(currentPath, previousPath);
  } catch (rotationError: unknown) {
    if (mirrorToConsole) console.error("Failed to rotate OpenPets log file.", rotationError instanceof Error ? formatError(rotationError) : redactLogText(String(rotationError)));
  }
}

function normalizeLogLevel(value: string | undefined): LogLevel | null {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  return null;
}

function isDevRun(): boolean {
  return process.env.OPENPETS_DEV === "1" || process.env.NODE_ENV === "development" || app?.isPackaged === false;
}

function formatFields(fields: LogFields | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  return ` ${Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${formatValue(value)}`).join(" ")}`;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(redact(value));
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Error) return JSON.stringify(formatError(value));
  return JSON.stringify(sanitize(value));
}

function sanitize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Error) return formatError(value);
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitize);
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).slice(0, 30)) {
      output[key] = isSensitiveKey(key) ? "[redacted]" : sanitize(nested);
    }
    return output;
  }
  return String(value);
}

function formatError(error: Error): { readonly name: string; readonly message: string; readonly stack?: string } {
  return { name: error.name, message: redact(error.message), stack: error.stack ? redact(error.stack) : undefined };
}

function redact(value: string): string {
  return redactLogText(value);
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|authorization|credential/i.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
