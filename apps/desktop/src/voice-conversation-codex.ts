import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";

import type { VoiceConversationEvent, VoiceConversationHealth, VoiceConversationRequest, VoiceConversationResult, VoiceConversationTarget } from "./voice-conversation-targets.js";

type CodexRun = (request: VoiceConversationRequest) => Promise<VoiceConversationResult>;
type CodexProbe = () => Promise<{ version: string; execHelp: string; resumeHelp: string }>;

const maxStdoutBytes = 2 * 1024 * 1024;
const maxStderrBytes = 64 * 1024;

export class CodexConversationTarget implements VoiceConversationTarget {
  readonly id = "codex" as const;
  readonly #command: string;
  readonly #cwd: string;
  readonly #runOverride?: CodexRun;
  readonly #probeOverride?: CodexProbe;
  readonly #children = new Set<ChildProcessWithoutNullStreams>();
  #health: VoiceConversationHealth | null = null;

  constructor(options: { command?: string; cwd?: string; run?: CodexRun; probe?: CodexProbe } = {}) {
    this.#command = options.command ?? "codex";
    this.#cwd = options.cwd ?? homedir();
    this.#runOverride = options.run;
    this.#probeOverride = options.probe;
  }

  async health(force = false): Promise<VoiceConversationHealth> {
    if (!force && this.#health && Date.now() - this.#health.checkedAt < 30_000) return this.#health;
    try {
      const probe = this.#probeOverride ? await this.#probeOverride() : await this.#probe();
      const ready = /--json\b/.test(probe.execHelp) && /\bresume\b/.test(probe.execHelp) && /\[SESSION_ID\]/.test(probe.resumeHelp) && /--json\b/.test(probe.resumeHelp);
      this.#health = {
        targetId: "codex",
        checkedAt: Date.now(),
        ready,
        method: "codex --version and machine-readable exec/resume capability probe",
        version: probe.version.trim().slice(0, 120),
        reason: ready ? undefined : "This Codex CLI does not expose the required JSON exec/resume contract.",
      };
    } catch (error) {
      this.#health = { targetId: "codex", checkedAt: Date.now(), ready: false, method: "Codex CLI capability probe", reason: cleanError(error) };
    }
    return this.#health;
  }

  async sendText(request: VoiceConversationRequest): Promise<VoiceConversationResult> {
    const text = request.text.trim();
    if (!text || text.length > 8_000) throw new Error("Conversation text must contain 1–8000 characters.");
    if (request.signal.aborted) throw abortError();
    const health = await this.health();
    if (!health.ready) throw new Error(health.reason ?? "Codex CLI conversation is unavailable.");
    return this.#runOverride ? this.#runOverride({ ...request, text }) : this.#runCli({ ...request, text });
  }

  dispose(): void {
    for (const child of this.#children) terminateChild(child);
    this.#children.clear();
  }

  async #probe(): Promise<{ version: string; execHelp: string; resumeHelp: string }> {
    const [version, execHelp, resumeHelp] = await Promise.all([
      this.#capture(["--version"], 5_000, 32 * 1024),
      this.#capture(["exec", "--help"], 5_000, 128 * 1024),
      this.#capture(["exec", "resume", "--help"], 5_000, 128 * 1024),
    ]);
    return { version, execHelp, resumeHelp };
  }

  #capture(args: string[], timeoutMs: number, limit: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return this.#spawnAndCollect(args, controller.signal, limit).finally(() => clearTimeout(timer));
  }

  async #runCli(request: VoiceConversationRequest): Promise<VoiceConversationResult> {
    const args = request.sessionId
      ? ["exec", "resume", "--json", request.sessionId, request.text]
      : ["exec", "--json", "--skip-git-repo-check", request.text];
    const output = await this.#spawnAndCollect(args, request.signal, maxStdoutBytes, request.onEvent);
    let sessionId = request.sessionId ?? "";
    let finalText = "";
    let reportedError = "";
    for (const line of output.split(/\r?\n/)) {
      const event = parseCodexJsonLine(line);
      if (!event) continue;
      if (event.type === "session") sessionId = event.sessionId;
      else if (event.type === "text" && event.final) finalText = event.text;
      else if (event.type === "error") reportedError = event.message;
    }
    if (!sessionId) throw new Error("Codex did not return a conversation session ID.");
    if (!finalText.trim()) throw new Error(reportedError || "Codex did not return an assistant message.");
    return { sessionId, text: finalText.trim() };
  }

  #spawnAndCollect(args: string[], signal: AbortSignal, limit: number, onEvent?: (event: VoiceConversationEvent) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#command, args, { cwd: this.#cwd, env: process.env, shell: false, windowsHide: true });
      this.#children.add(child);
      let stdout = "";
      let stderr = "";
      let eventBuffer = "";
      let settled = false;
      const emitLines = (flush = false) => {
        if (!onEvent) return;
        const lines = eventBuffer.split(/\r?\n/);
        eventBuffer = flush ? "" : lines.pop() ?? "";
        for (const line of lines) {
          const event = parseCodexJsonLine(line);
          if (event) onEvent(event);
        }
        if (flush && eventBuffer.trim()) {
          const event = parseCodexJsonLine(eventBuffer);
          if (event) onEvent(event);
          eventBuffer = "";
        }
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.#children.delete(child);
        if (error) reject(error); else resolve(stdout);
      };
      const onAbort = () => { terminateChild(child); finish(abortError()); };
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        eventBuffer += chunk;
        emitLines();
        if (Buffer.byteLength(stdout) > limit) { terminateChild(child); finish(new Error("Codex CLI output exceeded the allowed size.")); }
      });
      child.stderr.on("data", (chunk: string) => { if (Buffer.byteLength(stderr) < maxStderrBytes) stderr += chunk; });
      child.on("error", (error) => finish(new Error(`Unable to start Codex CLI: ${cleanError(error)}`)));
      child.on("close", (code) => {
        if (settled) return;
        emitLines(true);
        if (signal.aborted) finish(abortError());
        else if (code !== 0) finish(new Error(cleanError(stderr) || `Codex CLI exited with status ${code}.`));
        else finish();
      });
    });
  }
}

export function parseCodexJsonLine(line: string): VoiceConversationEvent | null {
  if (!line.trim()) return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!isRecord(value)) return null;
  if (value.type === "thread.started" && typeof value.thread_id === "string" && value.thread_id) return { type: "session", sessionId: value.thread_id };
  if (value.type !== "item.completed" || !isRecord(value.item)) return null;
  if (value.item.type === "agent_message" && typeof value.item.text === "string") return { type: "text", text: value.item.text, final: true };
  if (value.item.type === "error" && typeof value.item.message === "string") return { type: "error", message: cleanError(value.item.message) };
  return null;
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return;
  try { child.kill("SIGTERM"); } catch { return; }
  const timer = setTimeout(() => { if (child.exitCode === null) { try { child.kill("SIGKILL"); } catch { /* already stopped */ } } }, 1_500);
  timer.unref?.();
}

function abortError(): Error {
  const error = new Error("Codex conversation was cancelled.");
  error.name = "AbortError";
  return error;
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/[^\s]+/gi, "endpoint").replace(/[A-Za-z0-9+/=_-]{48,}/g, "[redacted]").trim().slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
