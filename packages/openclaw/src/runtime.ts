import { pickHookSpeech, validateHookSpeech } from "@open-pets/agent-events";
import { createOpenPetsClient, type OpenPetsClient } from "@open-pets/client";

export type OpenClawActivity = "thinking" | "working";

export interface OpenPetsOpenClawRuntimeOptions {
  readonly clientFactory?: () => OpenPetsClient;
  readonly schedule?: (work: () => Promise<void>) => void;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly debug?: boolean;
  readonly debugLog?: (code: OpenPetsDebugCode) => void;
  readonly thinkingCooldownMs?: number;
  readonly workingCooldownMs?: number;
  readonly speechCooldownMs?: number;
}

export type OpenPetsDebugCode =
  | "dispatch_failed"
  | "dispatch_pending"
  | "cooldown"
  | "schedule_failed";

export interface OpenPetsOpenClawRuntime {
  readonly handleModelCallStarted: () => void;
  readonly handleBeforeToolCall: () => void;
}

const automaticTimeoutMs = 500;
const defaultThinkingCooldownMs = 10_000;
const defaultWorkingCooldownMs = 3_000;
const defaultSpeechCooldownMs = 20_000;

/**
 * The OpenClaw hook callbacks intentionally accept no arguments. This keeps the
 * observation boundary obvious: event payloads are never even read.
 */
export function createOpenPetsOpenClawRuntime(options: OpenPetsOpenClawRuntimeOptions = {}): OpenPetsOpenClawRuntime {
  const clientFactory = options.clientFactory ?? (() => createOpenPetsClient({
    remote: false,
    connectTimeoutMs: automaticTimeoutMs,
    responseTimeoutMs: automaticTimeoutMs,
  }));
  const schedule = options.schedule ?? defaultSchedule;
  const now = options.now ?? Date.now;
  const debugEnabled = options.debug === true || process.env.OPENPETS_OPENCLAW_DEBUG === "1";
  const debugLog = options.debugLog ?? (() => {});
  const cooldowns: Record<OpenClawActivity, number> = { thinking: Number.NEGATIVE_INFINITY, working: Number.NEGATIVE_INFINITY };
  let speechSentAt = Number.NEGATIVE_INFINITY;
  let pending = false;
  let client: OpenPetsClient | undefined;

  const report = (code: OpenPetsDebugCode): void => {
    if (debugEnabled) debugLog(code);
  };

  const getClient = (): OpenPetsClient => {
    client ??= clientFactory();
    return client;
  };

  const dispatch = (activity: OpenClawActivity): void => {
    const timestamp = now();
    const cooldownMs = activity === "thinking" ? options.thinkingCooldownMs ?? defaultThinkingCooldownMs : options.workingCooldownMs ?? defaultWorkingCooldownMs;
    if (timestamp - cooldowns[activity] < cooldownMs) {
      report("cooldown");
      return;
    }
    if (pending) {
      report("dispatch_pending");
      return;
    }
    cooldowns[activity] = timestamp;
    pending = true;
    try {
      schedule(async () => {
        try {
          const openPets = getClient();
          if (activity === "thinking" && timestamp - speechSentAt >= (options.speechCooldownMs ?? defaultSpeechCooldownMs)) {
            const speech = validateHookSpeech(pickHookSpeech("thinking", options.random));
            speechSentAt = timestamp;
            await openPets.say(speech, { reaction: "thinking" });
          } else {
            await openPets.react(activity);
          }
        } catch {
          report("dispatch_failed");
        } finally {
          pending = false;
        }
      });
    } catch {
      pending = false;
      report("schedule_failed");
    }
  };

  return {
    handleModelCallStarted: () => dispatch("thinking"),
    handleBeforeToolCall: () => dispatch("working"),
  };
}

function defaultSchedule(work: () => Promise<void>): void {
  queueMicrotask(() => { void work(); });
}
