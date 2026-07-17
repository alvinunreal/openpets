import type { OpenPetsReaction } from "./local-ipc-protocol.js";

export type CompanionDayPart = "night" | "morning" | "midday" | "afternoon" | "evening";
export type CompanionExpressionHint = "sleepy" | "bright" | "hungry" | "content" | "winding-down";
export type CompanionActivityLevel = "active" | "idle" | "unknown";

export type CompanionTimeState = {
  readonly dayPart: CompanionDayPart;
  readonly expressionHint: CompanionExpressionHint;
  readonly reactionHint: OpenPetsReaction;
  readonly activityLevel: CompanionActivityLevel;
  readonly localDateKey: string;
};

export const companionRecentActivityWindowMs = 5 * 60 * 1_000;

const dayPartHints: Readonly<Record<CompanionDayPart, {
  readonly expressionHint: CompanionExpressionHint;
  readonly reactionHint: OpenPetsReaction;
}>> = {
  night: { expressionHint: "sleepy", reactionHint: "waiting" },
  morning: { expressionHint: "bright", reactionHint: "waving" },
  midday: { expressionHint: "hungry", reactionHint: "waiting" },
  afternoon: { expressionHint: "content", reactionHint: "idle" },
  evening: { expressionHint: "winding-down", reactionHint: "idle" },
};

export function resolveCompanionDayPart(now = new Date()): CompanionDayPart {
  const hour = validDate(now).getHours();
  if (hour >= 22 || hour < 6) return "night";
  if (hour < 11) return "morning";
  if (hour < 14) return "midday";
  if (hour < 18) return "afternoon";
  return "evening";
}

export function resolveCompanionTimeState(now = new Date(), lastActivityAt?: number): CompanionTimeState {
  const resolvedNow = validDate(now);
  const dayPart = resolveCompanionDayPart(resolvedNow);
  const hints = dayPartHints[dayPart];
  const activityLevel = resolveActivityLevel(resolvedNow.getTime(), lastActivityAt);
  return {
    dayPart,
    expressionHint: hints.expressionHint,
    reactionHint: activityLevel === "active" ? "working" : hints.reactionHint,
    activityLevel,
    localDateKey: getCompanionLocalDateKey(resolvedNow),
  };
}

export function getCompanionLocalDateKey(now = new Date()): string {
  const date = validDate(now);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function resolveActivityLevel(now: number, lastActivityAt: number | undefined): CompanionActivityLevel {
  if (typeof lastActivityAt !== "number" || !Number.isFinite(lastActivityAt) || lastActivityAt < 0) return "unknown";
  const elapsed = now - lastActivityAt;
  return elapsed >= 0 && elapsed <= companionRecentActivityWindowMs ? "active" : "idle";
}

function validDate(value: Date): Date {
  return Number.isFinite(value.getTime()) ? value : new Date(0);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
