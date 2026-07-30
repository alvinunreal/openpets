import type { LanPetRecord, LanState } from "./lan-state.js";

export type LanWorkDeparture = {
  readonly ownerHost: string;
  readonly sequence: number;
};

export type LanWorkActivityPlan = {
  readonly observed: readonly LanWorkDeparture[];
  readonly departures: readonly LanWorkDeparture[];
};

const workReactions = new Set(["working", "editing", "running", "testing"]);

export function shouldPublishLanWorkSignal(localHost: string, state: LanState | null, reaction: string): boolean {
  if (!workReactions.has(reaction)) return false;
  const localPet = state?.pets?.find((pet) => pet.ownerHost === localHost);
  if (!localPet || localPet.currentHost === localHost) return false;
  return (state?.pets?.filter((pet) => pet.currentHost === localPet.currentHost).length ?? 0) >= 2;
}

export function planLanWorkActivities(
  localHost: string,
  pets: readonly LanPetRecord[],
  seenSequences: ReadonlyMap<string, number>,
  coordinatorNow: number,
  maxAgeMs: number,
): LanWorkActivityPlan {
  const meetingOwners = new Set(
    pets.filter((pet) => pet.currentHost === localHost).map((pet) => pet.ownerHost),
  );
  const isMeeting = meetingOwners.size >= 2;
  const observed: LanWorkDeparture[] = [];
  const departures: LanWorkDeparture[] = [];

  for (const pet of pets) {
    const activity = pet.activity;
    if (!activity || activity.kind !== "work" || activity.sequence <= (seenSequences.get(pet.ownerHost) ?? 0)) continue;
    const item = { ownerHost: pet.ownerHost, sequence: activity.sequence };
    observed.push(item);
    const ageMs = coordinatorNow - activity.createdAt;
    if (
      isMeeting
      && pet.ownerHost !== localHost
      && pet.currentHost === localHost
      && ageMs >= 0
      && ageMs <= maxAgeMs
    ) {
      departures.push(item);
    }
  }

  return { observed, departures };
}

export function shouldRetryLanWorkReturn(
  localHost: string,
  ownerHost: string,
  sequence: number,
  state: LanState | null,
): boolean {
  const pet = state?.pets?.find((candidate) => candidate.ownerHost === ownerHost);
  return pet?.currentHost === localHost && pet.activity?.kind === "work" && pet.activity.sequence === sequence;
}
