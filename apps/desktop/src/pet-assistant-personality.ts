/** Persisted, owner-authored communication preferences for the Pet Assistant. */

export const petAssistantResponseLengthOptions = [
  { value: "concise", label: "Concise" },
  { value: "balanced", label: "Balanced" },
  { value: "detailed", label: "Detailed" },
] as const;

export type PetAssistantResponseLength = typeof petAssistantResponseLengthOptions[number]["value"];

export type PetAssistantPersonality = {
  readonly petName: string;
  readonly tone: string;
  readonly style: string;
  readonly ownerAddress: string;
  readonly responseLength: PetAssistantResponseLength;
};

export type PetAssistantPersonalityPatch = {
  readonly petName?: string;
  readonly tone?: string;
  readonly style?: string;
  readonly ownerAddress?: string;
  readonly responseLength?: PetAssistantResponseLength;
};

export const defaultPetAssistantPersonality: PetAssistantPersonality = Object.freeze({
  petName: "OpenPets",
  tone: "Warm and clear",
  style: "Friendly, grounded, and helpful.",
  ownerAddress: "there",
  responseLength: "balanced",
});

export const petAssistantPersonalityLimits = Object.freeze({
  petNameBytes: 64,
  toneBytes: 96,
  styleBytes: 1024,
  ownerAddressBytes: 96,
});

const responseLengths = new Set<PetAssistantResponseLength>(petAssistantResponseLengthOptions.map((option) => option.value));

/** Normalize persisted state, falling back field-by-field for malformed data. */
export function normalizePetAssistantPersonality(value: unknown): PetAssistantPersonality {
  const record = isRecord(value) ? value : {};
  return Object.freeze({
    petName: normalizeText(record.petName, defaultPetAssistantPersonality.petName, petAssistantPersonalityLimits.petNameBytes),
    tone: normalizeText(record.tone, defaultPetAssistantPersonality.tone, petAssistantPersonalityLimits.toneBytes),
    style: normalizeText(record.style, defaultPetAssistantPersonality.style, petAssistantPersonalityLimits.styleBytes),
    ownerAddress: normalizeText(record.ownerAddress, defaultPetAssistantPersonality.ownerAddress, petAssistantPersonalityLimits.ownerAddressBytes),
    responseLength: responseLengths.has(record.responseLength as PetAssistantResponseLength)
      ? record.responseLength as PetAssistantResponseLength
      : defaultPetAssistantPersonality.responseLength,
  });
}

/** Validate untrusted renderer input while preserving partial-patch semantics. */
export function validatePetAssistantPersonalityPatch(value: unknown): PetAssistantPersonalityPatch {
  if (!isRecord(value)) throw new Error("Invalid personality preferences.");

  const patch: { petName?: string; tone?: string; style?: string; ownerAddress?: string; responseLength?: PetAssistantResponseLength } = {};
  if ("petName" in value) patch.petName = validateText(value.petName, "pet name", petAssistantPersonalityLimits.petNameBytes);
  if ("tone" in value) patch.tone = validateText(value.tone, "tone", petAssistantPersonalityLimits.toneBytes);
  if ("style" in value) patch.style = validateText(value.style, "style", petAssistantPersonalityLimits.styleBytes);
  if ("ownerAddress" in value) patch.ownerAddress = validateText(value.ownerAddress, "owner address", petAssistantPersonalityLimits.ownerAddressBytes);
  if ("responseLength" in value) {
    if (!responseLengths.has(value.responseLength as PetAssistantResponseLength)) throw new Error("Invalid response-length preference.");
    patch.responseLength = value.responseLength as PetAssistantResponseLength;
  }
  return patch;
}

export function mergePetAssistantPersonality(base: PetAssistantPersonality, patch: PetAssistantPersonalityPatch): PetAssistantPersonality {
  return normalizePetAssistantPersonality({ ...base, ...patch });
}

/**
 * Serialize in a fixed field order. Brackets inside values are unicode-escaped
 * so owner text cannot forge the surrounding prompt markers.
 */
export function serializePetAssistantPersonality(personality: PetAssistantPersonality): string {
  return JSON.stringify({
    petName: personality.petName,
    tone: personality.tone,
    style: personality.style,
    ownerAddress: personality.ownerAddress,
    responseLength: personality.responseLength,
  }).replaceAll("[", "\\u005b").replaceAll("]", "\\u005d");
}

function normalizeText(value: unknown, fallback: string, maxBytes: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed && byteLength(trimmed) <= maxBytes ? trimmed : fallback;
}

function validateText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Invalid ${label}.`);
  const trimmed = value.trim();
  if (byteLength(trimmed) > maxBytes) throw new Error(`${label[0]!.toUpperCase()}${label.slice(1)} is too large.`);
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
