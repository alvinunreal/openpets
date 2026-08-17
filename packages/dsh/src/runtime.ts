import { pickHookSpeech, validateHookSpeech, type HookSpeechCategory } from "@open-pets/agent-events";
import { createOpenPetsClient, type OpenPetsClient, type OpenPetsReaction } from "@open-pets/client";
import type { Context } from "@deepseek-ai/cordis";

export type DshEventName = "agent/status" | "agent/error" | "approval/request";
export type DshAgentStatus = "running" | "idle";

export interface DshEventDecision {
  readonly reaction: OpenPetsReaction;
  readonly speechCategory: HookSpeechCategory;
}

export interface OpenPetsDshOptions {
  readonly clientFactory?: () => OpenPetsClient;
  readonly schedule?: (work: () => Promise<void>) => void | Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
}

export interface OpenPetsDshRuntime {
  readonly handleStatus: (event: unknown) => void;
  readonly handleEvent: (eventName: DshEventName, event?: unknown) => void;
  readonly handleApproval: () => void;
}

export type DshCordisApi = Pick<Context, "on">;

const automaticTimeoutMs = 500;
const errorSuccessSuppressionMs = 5_000;

/**
 * Map only the categorical values defined by DSH. Event payloads are
 * deliberately not inspected or forwarded. For agent/status, only the
 * categorical `status` property is read from the event envelope.
 */
export function classifyDshEvent(eventName: DshEventName | string, event?: unknown): DshEventDecision | undefined {
  if (eventName === "agent/status") {
    const status = typeof event === "string" ? event : getStatusCategory(event);
    if (status === "running") return { reaction: "thinking", speechCategory: "thinking" };
    if (status === "idle") return { reaction: "success", speechCategory: "success" };
    return undefined;
  }
  if (eventName === "agent/error") return { reaction: "error", speechCategory: "error" };
  if (eventName === "approval/request") return { reaction: "waiting", speechCategory: "permission" };
  return undefined;
}

export function createOpenPetsDshRuntime(options: OpenPetsDshOptions = {}): OpenPetsDshRuntime {
  const clientFactory = options.clientFactory ?? createOpenPetsDshClient;
  const schedule = options.schedule ?? defaultSchedule;
  let client: OpenPetsClient | undefined;
  let recentErrorAt = Number.NEGATIVE_INFINITY;

  const getClient = (): OpenPetsClient => {
    client ??= clientFactory();
    return client;
  };

  const dispatch = (decision: DshEventDecision | undefined): void => {
    if (!decision) return;

    const now = options.now?.() ?? Date.now();
    if (decision.reaction === "error") {
      recentErrorAt = now;
    } else if (decision.reaction === "success" && now - recentErrorAt < errorSuccessSuppressionMs) {
      return;
    }

    const work = async (): Promise<void> => {
      try {
        const speech = validateHookSpeech(pickHookSpeech(decision.speechCategory, options.random));
        await getClient().say(speech, { reaction: decision.reaction });
      } catch {
        // Automatic agent listeners must never affect the DSH operation.
      }
    };

    try {
      const scheduled = schedule(work);
      if (isPromiseLike(scheduled)) void scheduled.catch(() => undefined);
    } catch {
      // A scheduler supplied by the host is optional infrastructure.
    }
  };

  return {
    handleStatus(event) {
      dispatch(classifyDshEvent("agent/status", event));
    },
    handleEvent(eventName, event) {
      dispatch(classifyDshEvent(eventName, event));
    },
    handleApproval() {
      dispatch(classifyDshEvent("approval/request"));
    },
  };
}

export function createOpenPetsDshClient(): OpenPetsClient {
  return createOpenPetsClient({
    remote: false,
    connectTimeoutMs: automaticTimeoutMs,
    responseTimeoutMs: automaticTimeoutMs,
  });
}

/** Register the three DSH listeners without taking ownership of their flow. */
export function registerDshListeners(cordis: DshCordisApi, options: OpenPetsDshOptions = {}): OpenPetsDshRuntime {
  const runtime = createOpenPetsDshRuntime(options);
  const on = cordis.on as unknown as (eventName: DshEventName, listener: (...args: readonly unknown[]) => unknown) => unknown;
  on("agent/status", (event: unknown) => runtime.handleStatus(event));
  on("agent/error", () => runtime.handleEvent("agent/error"));
  on("approval/request", (_request: unknown, next: unknown) => {
    runtime.handleApproval();
    return typeof next === "function" ? next() : undefined;
  });
  return runtime;
}

function defaultSchedule(work: () => Promise<void>): void {
  void Promise.resolve().then(work).catch(() => undefined);
}

function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
  return typeof value === "object" && value !== null && typeof value.then === "function";
}

function getStatusCategory(event: unknown): unknown {
  if (typeof event !== "object" || event === null) return undefined;
  return (event as { readonly status?: unknown }).status;
}
