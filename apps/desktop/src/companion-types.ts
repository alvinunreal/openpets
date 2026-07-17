export const companionFrequencies = ["rarely", "sometimes", "often"] as const;
export type CompanionFrequency = typeof companionFrequencies[number];

export const companionTargetIds = ["codex", "host-ai"] as const;
export type CompanionTargetId = typeof companionTargetIds[number];
