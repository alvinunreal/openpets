export type CompanionContributionSensitivity = "normal" | "sensitive";
export type CompanionOpportunityUrgency = "low" | "normal";

export type CompanionFactInput = {
  key: string;
  text: string;
  expiresAt: number;
  sensitivity?: CompanionContributionSensitivity;
};

export type CompanionOpportunityInput = {
  key: string;
  /** Factual background for the host, never final pet wording. */
  context: string;
  urgency: CompanionOpportunityUrgency;
  earliestAt: number;
  expiresAt: number;
  dedupeKey: string;
  cooldownMs?: number;
  sensitivity?: CompanionContributionSensitivity;
};

type CompanionContributionBase = {
  id: string;
  pluginId: string;
  key: string;
  sensitivity: CompanionContributionSensitivity;
  createdAt: number;
  expiresAt: number;
};

export type CompanionFactContribution = CompanionContributionBase & {
  kind: "fact";
  text: string;
};

export type CompanionOpportunityContribution = CompanionContributionBase & {
  kind: "opportunity";
  context: string;
  urgency: CompanionOpportunityUrgency;
  earliestAt: number;
  dedupeKey: string;
  cooldownMs: number;
};

export type CompanionContribution = CompanionFactContribution | CompanionOpportunityContribution;

export type CompanionContributionSnapshot = {
  facts: readonly CompanionFactContribution[];
  opportunities: readonly CompanionOpportunityContribution[];
};

export type CompanionContributionConsentRequest = {
  pluginId: string;
  sensitivity: CompanionContributionSensitivity;
};

export type CompanionContributionStoreOptions = {
  /** Called for every submission and again while reading retained context. */
  canContribute(request: CompanionContributionConsentRequest): boolean;
  /** Contributions are accepted and retained only while the plugin is enabled. */
  isPluginEnabled(pluginId: string): boolean;
  now?: () => number;
  maxTotal?: number;
  maxPerPlugin?: number;
};

const idPattern = /^[A-Za-z0-9._:-]{1,96}$/;
const pluginIdPattern = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;
const maxTextChars = 500;
const maxLifetimeMs = 24 * 60 * 60_000;
const maxCooldownMs = 7 * 24 * 60 * 60_000;
const defaultCooldownMs = 60 * 60_000;

/**
 * Bounded, process-local plugin context. The store deliberately has no disk,
 * speech, provider, or companion-memory dependency. Plugins that need restart
 * continuity must persist their own domain state and contribute it again.
 */
export class CompanionContributionStore {
  readonly #canContribute: CompanionContributionStoreOptions["canContribute"];
  readonly #isPluginEnabled: CompanionContributionStoreOptions["isPluginEnabled"];
  readonly #now: () => number;
  readonly #maxTotal: number;
  readonly #maxPerPlugin: number;
  readonly #contributions = new Map<string, CompanionContribution>();
  readonly #idsByPluginKey = new Map<string, string>();
  readonly #cooldowns = new Map<string, number>();
  #nextId = 0;

  constructor(options: CompanionContributionStoreOptions) {
    this.#canContribute = options.canContribute;
    this.#isPluginEnabled = options.isPluginEnabled;
    this.#now = options.now ?? Date.now;
    this.#maxTotal = positiveInteger(options.maxTotal ?? 256, "maxTotal");
    this.#maxPerPlugin = positiveInteger(options.maxPerPlugin ?? 32, "maxPerPlugin");
  }

  get size(): number {
    this.#prune(this.#now());
    return this.#contributions.size;
  }

  /** Returns false when host consent/plugin enablement declines the contribution. */
  submitFact(pluginId: string, input: CompanionFactInput): boolean {
    const now = this.#now();
    const base = this.#validateBase(pluginId, input, now, ["key", "text", "expiresAt", "sensitivity"]);
    const text = plainText(input.text, "Companion fact text");
    if (!this.#allowed(pluginId, base.sensitivity)) return false;
    return this.#upsert({ ...base, kind: "fact", text }, now);
  }

  /** Returns false when consent, enablement, or an active cooldown makes the host ignore it. */
  submitOpportunity(pluginId: string, input: CompanionOpportunityInput): boolean {
    const now = this.#now();
    const base = this.#validateBase(pluginId, input, now, ["key", "context", "urgency", "earliestAt", "expiresAt", "dedupeKey", "cooldownMs", "sensitivity"]);
    const context = plainText(input.context, "Companion opportunity context");
    if (input.urgency !== "low" && input.urgency !== "normal") throw new Error("Companion opportunity urgency must be low or normal.");
    const requestedEarliestAt = finiteEpoch(input.earliestAt, "Companion opportunity earliestAt");
    if (requestedEarliestAt >= base.expiresAt) throw new Error("Companion opportunity earliestAt must be before expiresAt.");
    const earliestAt = Math.max(now, requestedEarliestAt);
    const dedupeKey = scopedId(input.dedupeKey, "Companion opportunity dedupeKey");
    const cooldownMs = input.cooldownMs === undefined ? defaultCooldownMs : finiteNumber(input.cooldownMs, "Companion opportunity cooldownMs");
    if (cooldownMs < 0 || cooldownMs > maxCooldownMs) throw new Error("Companion opportunity cooldownMs is out of range.");
    if (!this.#allowed(pluginId, base.sensitivity)) return false;
    this.#prune(now);
    if ((this.#cooldowns.get(cooldownIdentity(pluginId, dedupeKey)) ?? 0) > now) return false;

    for (const contribution of [...this.#contributions.values()]) {
      if (contribution.kind === "opportunity" && contribution.pluginId === pluginId && contribution.dedupeKey === dedupeKey && contribution.key !== base.key) {
        this.#deleteById(contribution.id);
      }
    }
    return this.#upsert({ ...base, kind: "opportunity", context, urgency: input.urgency, earliestAt, dedupeKey, cooldownMs }, now);
  }

  remove(pluginId: string, key: string): boolean {
    validatePluginId(pluginId);
    const id = this.#idsByPluginKey.get(pluginKey(pluginId, scopedId(key, "Companion contribution key")));
    return id === undefined ? false : this.#deleteById(id);
  }

  clearPlugin(pluginId: string): void {
    validatePluginId(pluginId);
    for (const contribution of [...this.#contributions.values()]) {
      if (contribution.pluginId === pluginId) this.#deleteById(contribution.id);
    }
    for (const identity of [...this.#cooldowns.keys()]) {
      if (identity.startsWith(`${pluginId}\0`)) this.#cooldowns.delete(identity);
    }
  }

  clear(): void {
    this.#contributions.clear();
    this.#idsByPluginKey.clear();
    this.#cooldowns.clear();
  }

  snapshot(options: { includeFutureOpportunities?: boolean; now?: number } = {}): CompanionContributionSnapshot {
    const now = options.now === undefined ? this.#now() : finiteEpoch(options.now, "Companion snapshot time");
    this.#prune(now);
    const facts: CompanionFactContribution[] = [];
    const opportunities: CompanionOpportunityContribution[] = [];
    for (const contribution of this.#contributions.values()) {
      if (contribution.kind === "fact") facts.push({ ...contribution });
      else if (options.includeFutureOpportunities === true || contribution.earliestAt <= now) opportunities.push({ ...contribution });
    }
    return { facts, opportunities };
  }

  /** Claims an eligible opportunity and starts its plugin-scoped dedupe cooldown. */
  consumeOpportunity(id: string, now = this.#now()): CompanionOpportunityContribution | undefined {
    const timestamp = finiteEpoch(now, "Companion opportunity consumption time");
    this.#prune(timestamp);
    const contribution = this.#contributions.get(String(id));
    if (!contribution || contribution.kind !== "opportunity" || contribution.earliestAt > timestamp) return undefined;
    this.#deleteById(contribution.id);
    if (contribution.cooldownMs > 0) this.#cooldowns.set(cooldownIdentity(contribution.pluginId, contribution.dedupeKey), timestamp + contribution.cooldownMs);
    return { ...contribution };
  }

  #validateBase(pluginId: string, input: object, now: number, allowedFields: readonly string[]): CompanionContributionBase {
    validatePluginId(pluginId);
    if (!isRecord(input)) throw new Error("Companion contribution must be an object.");
    for (const field of Object.keys(input)) if (!allowedFields.includes(field)) throw new Error(`Invalid companion contribution field: ${field}.`);
    const key = scopedId(input.key, "Companion contribution key");
    const expiresAt = finiteEpoch(input.expiresAt, "Companion contribution expiresAt");
    if (expiresAt <= now || expiresAt > now + maxLifetimeMs) throw new Error("Companion contribution expiresAt must be within the next 24 hours.");
    const sensitivity = input.sensitivity === undefined ? "normal" : input.sensitivity;
    if (sensitivity !== "normal" && sensitivity !== "sensitive") throw new Error("Companion contribution sensitivity is invalid.");
    return { id: "", pluginId, key, sensitivity, createdAt: now, expiresAt };
  }

  #allowed(pluginId: string, sensitivity: CompanionContributionSensitivity): boolean {
    try {
      return this.#isPluginEnabled(pluginId) && this.#canContribute({ pluginId, sensitivity });
    } catch {
      return false;
    }
  }

  #upsert(input: CompanionContribution, now: number): boolean {
    this.#prune(now);
    const identity = pluginKey(input.pluginId, input.key);
    const existingId = this.#idsByPluginKey.get(identity);
    if (existingId !== undefined) {
      const existing = this.#contributions.get(existingId);
      this.#contributions.set(existingId, { ...input, id: existingId, createdAt: existing?.createdAt ?? now });
      return true;
    }
    let pluginCount = 0;
    for (const contribution of this.#contributions.values()) if (contribution.pluginId === input.pluginId) pluginCount += 1;
    if (pluginCount >= this.#maxPerPlugin) throw new Error("Plugin companion contribution quota exceeded.");
    if (this.#contributions.size >= this.#maxTotal) throw new Error("Host companion contribution quota exceeded.");
    const id = `companion-${++this.#nextId}`;
    this.#contributions.set(id, { ...input, id });
    this.#idsByPluginKey.set(identity, id);
    return true;
  }

  #deleteById(id: string): boolean {
    const contribution = this.#contributions.get(id);
    if (!contribution) return false;
    this.#contributions.delete(id);
    this.#idsByPluginKey.delete(pluginKey(contribution.pluginId, contribution.key));
    return true;
  }

  #prune(now: number): void {
    for (const contribution of [...this.#contributions.values()]) {
      if (contribution.expiresAt <= now || !this.#allowed(contribution.pluginId, contribution.sensitivity)) this.#deleteById(contribution.id);
    }
    for (const [identity, expiresAt] of this.#cooldowns) if (expiresAt <= now) this.#cooldowns.delete(identity);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePluginId(pluginId: string): void {
  if (!pluginIdPattern.test(pluginId)) throw new Error("Invalid plugin id for companion contribution.");
}

function scopedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !idPattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function plainText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be plain text.`);
  const text = value.trim();
  if (text.length < 1 || text.length > maxTextChars || /[\0-\x08\x0B\x0C\x0E-\x1F]/.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function finiteEpoch(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be finite epoch milliseconds.`);
  return number;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function pluginKey(pluginId: string, key: string): string {
  return `${pluginId}\0${key}`;
}

function cooldownIdentity(pluginId: string, dedupeKey: string): string {
  return `${pluginId}\0${dedupeKey}`;
}
