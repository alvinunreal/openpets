import { getCompanionLocalDateKey } from "./companion-time.js";
import type { CompanionMemoryEntry } from "./companion-memory.js";
import type { CompanionFrequency } from "./companion-types.js";

export type CompanionProactivityPolicy = {
  readonly maxPerLocalDay: number;
  readonly minimumSpacingMs: number;
  readonly maxPerPluginPerLocalDay: number;
  readonly defaultDedupeWindowMs: number;
};

export type CompanionProactiveCandidate = {
  readonly id: string;
  readonly dedupeKey: string;
  readonly source: "time" | "goal" | "plugin";
  readonly earliestAt?: number;
  readonly expiresAt: number;
  readonly pluginId?: string;
  readonly cooldownMs?: number;
};

/** Only displayed check-ins belong in policy history. */
export type CompanionProactiveDelivery = {
  readonly candidateId: string;
  readonly dedupeKey: string;
  readonly source: CompanionProactiveCandidate["source"];
  readonly pluginId?: string;
  readonly displayedAt: number;
};

export type CompanionProactivityReason =
  | "eligible"
  | "companion-disabled"
  | "proactivity-disabled"
  | "candidate-invalid"
  | "candidate-not-ready"
  | "candidate-expired"
  | "quiet-hours"
  | "interaction-active"
  | "target-not-ready"
  | "duplicate"
  | "daily-limit"
  | "plugin-daily-limit"
  | "minimum-spacing";

export type CompanionProactivityDecision = {
  readonly eligible: boolean;
  readonly reason: CompanionProactivityReason;
  readonly policy: CompanionProactivityPolicy;
  readonly retryAt?: number;
};

const hour = 60 * 60 * 1_000;
const day = 24 * hour;

export const companionProactivityPolicies: Readonly<Record<CompanionFrequency, CompanionProactivityPolicy>> = {
  rarely: {
    maxPerLocalDay: 1,
    minimumSpacingMs: 6 * hour,
    maxPerPluginPerLocalDay: 1,
    defaultDedupeWindowMs: day,
  },
  sometimes: {
    maxPerLocalDay: 3,
    minimumSpacingMs: 3 * hour,
    maxPerPluginPerLocalDay: 2,
    defaultDedupeWindowMs: day,
  },
  often: {
    maxPerLocalDay: 5,
    minimumSpacingMs: 90 * 60 * 1_000,
    maxPerPluginPerLocalDay: 2,
    defaultDedupeWindowMs: day,
  },
};

export function getCompanionProactivityPolicy(frequency: CompanionFrequency): CompanionProactivityPolicy {
  return companionProactivityPolicies[frequency];
}

/** Rebuild policy history after restart, while retaining legacy memory entries. */
export function companionProactiveDeliveryFromMemoryEntry(entry: CompanionMemoryEntry): CompanionProactiveDelivery | undefined {
  if (entry.role !== "proactive") return undefined;
  if (!entry.proactive) {
    return {
      candidateId: `memory:${entry.id}`,
      dedupeKey: `memory:${entry.id}`,
      source: "time",
      displayedAt: entry.createdAt,
    };
  }
  return {
    candidateId: entry.proactive.candidateId,
    dedupeKey: entry.proactive.dedupeKey,
    source: entry.proactive.source,
    ...(entry.proactive.pluginId ? { pluginId: entry.proactive.pluginId } : {}),
    displayedAt: entry.createdAt,
  };
}

export function evaluateCompanionProactivity(input: {
  readonly now: number;
  readonly frequency: CompanionFrequency;
  readonly companionEnabled: boolean;
  readonly proactivityEnabled: boolean;
  readonly inQuietHours: boolean;
  readonly targetReady: boolean;
  readonly activity: {
    readonly listening: boolean;
    readonly thinking: boolean;
    readonly speaking: boolean;
  };
  readonly candidate: CompanionProactiveCandidate;
  readonly history: readonly CompanionProactiveDelivery[];
}): CompanionProactivityDecision {
  const policy = getCompanionProactivityPolicy(input.frequency);
  const deny = (reason: Exclude<CompanionProactivityReason, "eligible">, retryAt?: number): CompanionProactivityDecision => ({
    eligible: false,
    reason,
    policy,
    ...(retryAt === undefined ? {} : { retryAt }),
  });

  if (!input.companionEnabled) return deny("companion-disabled");
  if (!input.proactivityEnabled) return deny("proactivity-disabled");
  const { candidate } = input;
  if (!Number.isFinite(input.now)
    || !candidate.id
    || !candidate.dedupeKey
    || !Number.isFinite(candidate.expiresAt)
    || (candidate.earliestAt !== undefined && !Number.isFinite(candidate.earliestAt))
    || (candidate.source === "plugin" && !candidate.pluginId)) return deny("candidate-invalid");
  if (candidate.earliestAt !== undefined && input.now < candidate.earliestAt) return deny("candidate-not-ready", candidate.earliestAt);
  if (input.now >= candidate.expiresAt) return deny("candidate-expired");
  if (input.inQuietHours) return deny("quiet-hours");
  if (input.activity.listening || input.activity.thinking || input.activity.speaking) return deny("interaction-active");
  if (!input.targetReady) return deny("target-not-ready");

  const validHistory = input.history.filter((delivery) => Number.isFinite(delivery.displayedAt) && delivery.displayedAt <= input.now);
  const dedupeWindowMs = Number.isFinite(candidate.cooldownMs) && (candidate.cooldownMs ?? 0) > 0
    ? Math.floor(candidate.cooldownMs ?? 0)
    : policy.defaultDedupeWindowMs;
  const duplicate = validHistory
    .filter((delivery) => delivery.dedupeKey === candidate.dedupeKey
      && delivery.source === candidate.source
      && (candidate.source !== "plugin" || delivery.pluginId === candidate.pluginId))
    .sort((left, right) => right.displayedAt - left.displayedAt)[0];
  if (duplicate && input.now - duplicate.displayedAt < dedupeWindowMs) {
    return deny("duplicate", duplicate.displayedAt + dedupeWindowMs);
  }

  const today = getCompanionLocalDateKey(new Date(input.now));
  const todaysHistory = validHistory.filter((delivery) => getCompanionLocalDateKey(new Date(delivery.displayedAt)) === today);
  if (todaysHistory.length >= policy.maxPerLocalDay) return deny("daily-limit");

  if (candidate.source === "plugin") {
    const pluginCount = todaysHistory.filter((delivery) => delivery.source === "plugin" && delivery.pluginId === candidate.pluginId).length;
    if (pluginCount >= policy.maxPerPluginPerLocalDay) return deny("plugin-daily-limit");
  }

  const lastDisplayedAt = validHistory.reduce((latest, delivery) => Math.max(latest, delivery.displayedAt), Number.NEGATIVE_INFINITY);
  if (Number.isFinite(lastDisplayedAt) && input.now - lastDisplayedAt < policy.minimumSpacingMs) {
    return deny("minimum-spacing", lastDisplayedAt + policy.minimumSpacingMs);
  }

  return { eligible: true, reason: "eligible", policy };
}
