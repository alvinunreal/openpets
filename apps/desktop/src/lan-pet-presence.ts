import type { LanPetRecord } from "./lan-state.js";

export type LanPetPresencePlan = {
  readonly show: readonly LanPetRecord[];
  readonly closeOwnerHosts: readonly string[];
};

export function planLanPetPresence(localHost: string, pets: readonly LanPetRecord[], activeOwnerHosts: readonly string[]): LanPetPresencePlan {
  const show = pets
    .filter((pet) => pet.ownerHost !== localHost && pet.currentHost === localHost)
    .sort((a, b) => a.ownerHost.localeCompare(b.ownerHost));
  const desiredOwners = new Set(show.map((pet) => pet.ownerHost));
  return {
    show,
    closeOwnerHosts: activeOwnerHosts.filter((ownerHost) => !desiredOwners.has(ownerHost)).sort(),
  };
}

export function resolveRenderableLanPetId(
  requestedPetId: string,
  installedPets: readonly { readonly id: string; readonly broken?: boolean; readonly builtIn?: boolean }[],
): string | null {
  const pet = installedPets.find((candidate) => candidate.id === requestedPetId);
  return pet && !pet.broken ? pet.id : null;
}
