export type LanEdge = "left" | "right" | "up" | "down";
export type LanMode = "off" | "server" | "client";

export type LanTopology = Readonly<Record<string, Readonly<Partial<Record<LanEdge, string>>>>>;

export type LanTopologyIssue = {
  readonly code: "self_reference" | "missing_reverse";
  readonly host: string;
  readonly edge: LanEdge;
  readonly neighbor: string;
};

export type LanPoint = {
  readonly x: number;
  readonly y: number;
};

export type LanClientRecord = {
  readonly host: string;
  readonly lastSeen: number;
  readonly position?: LanPoint;
  readonly petId?: string;
};

export type LanPetRecord = {
  readonly ownerHost: string;
  readonly petId: string;
  readonly currentHost: string;
  readonly position?: LanPoint;
  readonly activity?: LanPetActivity;
};

export type LanPetActivity = {
  readonly kind: "work";
  readonly sequence: number;
  readonly createdAt: number;
};

export type LanState = {
  readonly enabled: true;
  readonly currentHost: string | null;
  readonly clients: readonly LanClientRecord[];
  readonly pets?: readonly LanPetRecord[];
  readonly updatedAt: number;
};

/**
 * LAN ownership is fail-closed for external pet actions until a current state
 * proves that this host owns the pet locally.
 */
export function isLanPetAwayForLocalHost(mode: LanMode, state: LanState | null, localHost: string | null, multiPetEnabled: boolean): boolean {
  if (mode === "off") return false;
  if (!state || !localHost) return true;
  if (multiPetEnabled) {
    return !(state.pets ?? []).some((pet) => pet.ownerHost === localHost && pet.currentHost === localHost);
  }
  return state.currentHost !== localHost;
}

export interface LanCoordinatorOptions {
  readonly staleClientMs: number;
  readonly initialCurrentHost?: string | null;
  readonly topology?: LanTopology;
}

export class LanCoordinator {
  readonly #staleClientMs: number;
  readonly #clients = new Map<string, LanClientRecord>();
  readonly #pets = new Map<string, LanPetRecord>();
  readonly #activitySequences = new Map<string, number>();
  readonly #petEdgeArmed = new Set<string>();
  readonly #topology: LanTopology;
  #currentHost: string | null = null;
  #preferredHost: string | null = null;
  #edgeArmed = false;

  constructor(options: LanCoordinatorOptions) {
    this.#staleClientMs = options.staleClientMs;
    this.#preferredHost = options.initialCurrentHost ?? null;
    this.#topology = options.topology ?? {};
  }

  setPreferredHost(host: string | null): void {
    this.#preferredHost = host;
    if (host && this.#clients.has(host)) {
      this.#currentHost = host;
      this.#edgeArmed = false;
    }
  }

  register(host: string, position: LanPoint | undefined, now: number, petId?: string): LanState {
    const normalizedPetId = normalizeLanPetId(petId) ?? undefined;
    this.#clients.set(host, { host, lastSeen: now, position, petId: normalizedPetId });
    if (normalizedPetId) {
      const existingPet = this.#pets.get(host);
      this.#pets.set(host, {
        ownerHost: host,
        petId: normalizedPetId,
        currentHost: existingPet?.currentHost && this.#clients.has(existingPet.currentHost) ? existingPet.currentHost : host,
        position: existingPet?.position ?? position,
        activity: existingPet?.activity,
      });
    } else {
      this.#pets.delete(host);
      this.#petEdgeArmed.delete(host);
    }
    if (host === this.#preferredHost && this.#currentHost !== host) {
      this.#currentHost = host;
      this.#edgeArmed = false;
    } else if (!this.#currentHost || !this.#clients.has(this.#currentHost)) {
      this.#currentHost = host;
      this.#edgeArmed = false;
    }
    return this.snapshot(now);
  }

  claim(host: string, now: number): LanState | null {
    this.prune(now);
    if (!this.#clients.has(host)) return null;
    this.#currentHost = host;
    this.#preferredHost = host;
    this.#edgeArmed = false;
    return this.snapshot(now);
  }

  updatePosition(host: string, position: LanPoint | undefined, edge: LanEdge | null, now: number, ownerHost?: string): LanState {
    const existingClient = this.#clients.get(host);
    this.#clients.set(host, { host, lastSeen: now, position, petId: existingClient?.petId });
    if (ownerHost) this.#updatePetPosition(host, ownerHost, position, edge);
    if (host === this.#preferredHost && this.#currentHost !== host) {
      this.#currentHost = host;
      this.#edgeArmed = false;
    } else if (!this.#currentHost || !this.#clients.has(this.#currentHost)) {
      this.#currentHost = host;
      this.#edgeArmed = false;
    }

    if (host === this.#currentHost && position) {
      if (!edge) this.#edgeArmed = true;
      else if (this.#edgeArmed) this.#migrate(edge);
    }

    return this.snapshot(now);
  }

  currentHost(): string | null {
    return this.#currentHost;
  }

  hasClient(host: string, now: number): boolean {
    this.prune(now);
    return this.#clients.has(host);
  }

  publishActivity(ownerHost: string, now: number): LanState | null {
    const pet = this.#pets.get(ownerHost);
    const meetingSize = pet
      ? [...this.#pets.values()].filter((candidate) => candidate.currentHost === pet.currentHost).length
      : 0;
    if (!pet || pet.currentHost === ownerHost || meetingSize < 2) return null;
    const sequence = Math.max((this.#activitySequences.get(ownerHost) ?? 0) + 1, now);
    this.#activitySequences.set(ownerHost, sequence);
    this.#pets.set(ownerHost, {
      ...pet,
      activity: {
        kind: "work",
        sequence,
        createdAt: now,
      },
    });
    return this.snapshot(now);
  }

  returnPet(host: string, ownerHost: string, now: number): LanState | null {
    const pet = this.#pets.get(ownerHost);
    if (!pet || pet.currentHost !== host || pet.ownerHost === host || !this.#clients.has(pet.ownerHost)) return null;
    const { activity: _activity, ...rest } = pet;
    this.#pets.set(ownerHost, {
      ...rest,
      currentHost: pet.ownerHost,
      position: this.#clients.get(pet.ownerHost)?.position,
    });
    this.#petEdgeArmed.delete(ownerHost);
    return this.snapshot(now);
  }

  snapshot(now: number): LanState {
    this.prune(now);
    return {
      enabled: true,
      currentHost: this.#currentHost,
      clients: [...this.#clients.values()].sort((a, b) => a.host.localeCompare(b.host)),
      pets: [...this.#pets.values()].filter((pet) => this.#clients.has(pet.ownerHost) && this.#clients.has(pet.currentHost)).sort((a, b) => a.ownerHost.localeCompare(b.ownerHost)),
      updatedAt: now,
    };
  }

  prune(now: number): void {
    for (const [host, record] of this.#clients) {
      if (now - record.lastSeen > this.#staleClientMs) this.#clients.delete(host);
    }
    for (const [ownerHost, pet] of this.#pets) {
      if (!this.#clients.has(ownerHost)) {
        this.#pets.delete(ownerHost);
        this.#petEdgeArmed.delete(ownerHost);
      } else if (!this.#clients.has(pet.currentHost)) {
        this.#pets.set(ownerHost, { ...pet, currentHost: ownerHost });
        this.#petEdgeArmed.delete(ownerHost);
      }
    }
    if (this.#currentHost && !this.#clients.has(this.#currentHost)) {
      this.#currentHost = this.#clients.keys().next().value ?? null;
      this.#edgeArmed = false;
    }
  }

  #updatePetPosition(host: string, ownerHost: string, position: LanPoint | undefined, edge: LanEdge | null): void {
    const pet = this.#pets.get(ownerHost);
    if (!pet || pet.currentHost !== host) return;
    let currentHost = pet.currentHost;
    if (!edge) this.#petEdgeArmed.add(ownerHost);
    else if (this.#petEdgeArmed.has(ownerHost)) {
      this.#petEdgeArmed.delete(ownerHost);
      if (position) currentHost = this.#getPetNeighbor(currentHost, edge) ?? currentHost;
    }
    this.#pets.set(ownerHost, { ...pet, currentHost, position });
  }

  #getPetNeighbor(currentHost: string, edge: LanEdge): string | null {
    const configured = this.#topology[currentHost]?.[edge];
    if (configured && this.#clients.has(configured)) return configured;
    const hosts = [...this.#clients.keys()].sort();
    if (hosts.length < 2) return null;
    const index = hosts.indexOf(currentHost);
    if (index < 0) return null;
    return edge === "right" || edge === "down" ? hosts[(index + 1) % hosts.length] : hosts[(index - 1 + hosts.length) % hosts.length];
  }

  #migrate(edge: LanEdge): void {
    const nextHost = this.#getNeighbor(edge) ?? this.#getFallbackNeighbor(edge);
    if (!nextHost) return;
    this.#currentHost = nextHost;
    this.#preferredHost = this.#currentHost;
    this.#edgeArmed = false;
  }

  #getNeighbor(edge: LanEdge): string | null {
    if (!this.#currentHost) return null;
    const neighbor = this.#topology[this.#currentHost]?.[edge];
    return neighbor && this.#clients.has(neighbor) ? neighbor : null;
  }

  #getFallbackNeighbor(edge: LanEdge): string | null {
    const hosts = [...this.#clients.keys()].sort();
    if (!this.#currentHost || hosts.length < 2) return null;
    const index = hosts.indexOf(this.#currentHost);
    if (index < 0) return null;
    if (edge === "right" || edge === "down") return hosts[(index + 1) % hosts.length];
    return hosts[(index - 1 + hosts.length) % hosts.length];
  }
}

export function normalizeLanHost(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 80) : null;
}

export function normalizeLanPoint(value: unknown): LanPoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x: Math.round(x), y: Math.round(y) };
}

export function normalizeLanEdge(value: unknown): LanEdge | null {
  return value === "left" || value === "right" || value === "up" || value === "down" ? value : null;
}

export function normalizeLanPetId(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) ? value : null;
}

export function normalizeLanTopology(value: unknown): LanTopology {
  if (!value || typeof value !== "object") return {};
  const topology: Record<string, Partial<Record<LanEdge, string>>> = {};
  for (const [hostValue, neighborsValue] of Object.entries(value as Record<string, unknown>)) {
    const host = normalizeLanHost(hostValue);
    if (!host || !neighborsValue || typeof neighborsValue !== "object") continue;
    const neighbors: Partial<Record<LanEdge, string>> = {};
    for (const edge of ["left", "right", "up", "down"] as const) {
      const neighbor = normalizeLanHost((neighborsValue as Record<string, unknown>)[edge]);
      if (neighbor) neighbors[edge] = neighbor;
    }
    if (Object.keys(neighbors).length > 0) topology[host] = neighbors;
  }
  return topology;
}


const oppositeLanEdge: Record<LanEdge, LanEdge> = {
  left: "right",
  right: "left",
  up: "down",
  down: "up",
};

export function countLanTopologyLinks(topology: LanTopology): number {
  return Object.values(topology).reduce((count, neighbors) => count + Object.keys(neighbors).length, 0);
}

export function validateLanTopology(topology: LanTopology): readonly LanTopologyIssue[] {
  const issues: LanTopologyIssue[] = [];
  for (const [host, neighbors] of Object.entries(topology)) {
    for (const edge of ["left", "right", "up", "down"] as const) {
      const neighbor = neighbors[edge];
      if (!neighbor) continue;
      if (neighbor === host) {
        issues.push({ code: "self_reference", host, edge, neighbor });
        continue;
      }
      const reverseEdge = oppositeLanEdge[edge];
      if (topology[neighbor]?.[reverseEdge] !== host) {
        issues.push({ code: "missing_reverse", host, edge, neighbor });
      }
    }
  }
  return issues;
}
