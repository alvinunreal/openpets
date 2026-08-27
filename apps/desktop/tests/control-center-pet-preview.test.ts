import assert from "node:assert/strict";

import { buildPetSpritePreviewModel, defaultPetSpriteLayout } from "../src/renderer/src/pet-preview-state.js";

assert.deepEqual(
  buildPetSpritePreviewModel(defaultPetSpriteLayout, { row: 0, frames: 6 }, true),
  {
    atlasColumns: 8,
    atlasRows: 9,
    row: 0,
    frameColumns: [0, 1, 2, 3, 4, 5],
    animated: true,
  },
  "V1 previews retain the existing six-frame idle animation on the 8x9 atlas",
);

const v2Layout = {
  version: 2,
  frameWidth: 192,
  frameHeight: 208,
  columns: 8,
  rows: 11,
  neutralPose: { row: 0, column: 6 },
} as const;

assert.deepEqual(
  buildPetSpritePreviewModel(v2Layout, { row: 0, frames: 6 }, true),
  {
    atlasColumns: 8,
    atlasRows: 11,
    row: 0,
    frameColumns: [6],
    animated: false,
  },
  "V2 idle previews show the static neutral frame at row 0, column 6",
);

assert.deepEqual(
  buildPetSpritePreviewModel(v2Layout, { row: 8, frames: 6 }, false),
  {
    atlasColumns: 8,
    atlasRows: 11,
    row: 8,
    frameColumns: [0, 1, 2, 3, 4, 5],
    animated: true,
  },
  "V2 reaction previews retain their normal animated frame range on the 8x11 atlas",
);

console.log("Control Center Codex V1/V2 preview behavior passed.");
