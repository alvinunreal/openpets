/**
 * Released reference manifests:
 * V1: https://raw.githubusercontent.com/chenxin-dlut/codex-anime-pets/main/pets/aiko/pet.json
 * V2: https://raw.githubusercontent.com/mySebbe/malou-codex-pet/v2.0.0/dist/malou/pet.json
 */
export const codexV1Fixture = {
  id: "aiko",
  displayName: "Aiko",
  description: "A tiny original Codex digital pet: an auburn-haired chibi scientist girl in a red turtleneck and white lab coat.",
  spritesheetPath: "spritesheet.webp",
} as const;

export const codexV2Fixture = {
  id: "malou",
  displayName: "Malou",
  description: "Malou is a clean photo-based brown-and-white dog companion for Codex Desktop, ChatGPT Web, and mobile Codex Pet bubbles, with readable status poses and 16 clockwise look directions.",
  spritesheetPath: "spritesheet.webp",
  spriteVersionNumber: 2,
} as const;
