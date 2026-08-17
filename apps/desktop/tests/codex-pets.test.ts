import assert from "node:assert/strict";

import sharp from "sharp";

import { codexV2SpriteLayout, getCodexPetSpriteLayout, getCodexPetSpritePosition, maxCodexPets, maxCodexSpritesheetBytes, maxCodexThumbnailSourceBytes, validateCodexPetMetadata, validateCodexPetSpritesheet } from "../src/codex-pets-core.js";
import { getConfiguredSpriteStates } from "../src/reaction-animation-mapping.js";
import { codexV1Fixture, codexV2Fixture } from "./codex-pet-fixtures.js";

const valid = validateCodexPetMetadata(codexV1Fixture, "aiko");

assert.deepEqual(valid, {
  ...codexV1Fixture,
  spritesheetPath: "spritesheet.webp",
});

assert.throws(() => validateCodexPetMetadata({ id: "other", displayName: "Other", description: "Nope", spritesheetPath: "spritesheet.webp" }, "fixer"));
assert.throws(() => validateCodexPetMetadata({ id: "builtin", displayName: "Built-in", description: "Reserved", spritesheetPath: "spritesheet.webp" }, "builtin"));
assert.throws(() => validateCodexPetMetadata({ id: "bad/id", displayName: "Bad", description: "Bad", spritesheetPath: "spritesheet.webp" }, "bad/id"));
assert.throws(() => validateCodexPetMetadata({ id: "fixer", displayName: "Fixer", description: "Nope", spritesheetPath: "../spritesheet.webp" }, "fixer"));
assert.throws(() => validateCodexPetMetadata({ id: "fixer", displayName: "", description: "Nope", spritesheetPath: "spritesheet.webp" }, "fixer"));

assert.equal(maxCodexSpritesheetBytes, 100 * 1024 * 1024);
assert.equal(maxCodexThumbnailSourceBytes, 24 * 1024 * 1024);
assert.equal(maxCodexPets, 100);

const v2 = validateCodexPetMetadata(codexV2Fixture, "malou");

assert.deepEqual(v2, {
  ...codexV2Fixture,
});
assert.equal(getCodexPetSpriteLayout(valid).rows, 9);
assert.deepEqual(getCodexPetSpriteLayout(v2), codexV2SpriteLayout);
assert.equal(codexV2SpriteLayout.rows, 11);
assert.deepEqual(codexV2SpriteLayout.neutralPose, { row: 0, column: 6 });
const configuredStates = getConfiguredSpriteStates();
assert.deepEqual(getCodexPetSpritePosition(codexV2SpriteLayout, configuredStates.idle, true), { row: 0, startColumn: 6, endColumn: 6, animated: false });
assert.deepEqual(getCodexPetSpritePosition(codexV2SpriteLayout, configuredStates["running-right"]), { row: 1, startColumn: 0, endColumn: 8, animated: true });
assert.deepEqual(getCodexPetSpritePosition(getCodexPetSpriteLayout(valid), configuredStates.idle), { row: 0, startColumn: 0, endColumn: 6, animated: true });

for (const marker of [1, 3, "2", null, undefined]) {
  const malformed = { ...codexV2Fixture, spriteVersionNumber: marker };
  assert.throws(() => validateCodexPetMetadata(malformed, "malou"), `marker ${String(marker)} must be rejected`);
}

const createAtlas = (width: number, height: number, format: "webp" | "png"): Promise<Buffer> => {
  const image = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
  return format === "webp" ? image.webp().toBuffer() : image.png().toBuffer();
};

async function runImageContracts(): Promise<void> {
  const validV2Atlas = await createAtlas(1536, 2288, "webp");
  await validateCodexPetSpritesheet(validV2Atlas, v2);
  await assert.rejects(() => createAtlas(1536, 2080, "webp").then((atlas) => validateCodexPetSpritesheet(atlas, v2)), /exactly 1536x2288/);
  await assert.rejects(() => createAtlas(1536, 2288, "png").then((atlas) => validateCodexPetSpritesheet(atlas, v2)), /must be WebP/);
  const opaqueWebp = await sharp({ create: { width: 1536, height: 2288, channels: 3, background: { r: 0, g: 0, b: 0 } } }).webp().toBuffer();
  await assert.rejects(() => validateCodexPetSpritesheet(opaqueWebp, v2), /must include transparency/);
  const secondV2Frame = await sharp({ create: { width: 1536, height: 2288, channels: 4, background: { r: 1, g: 0, b: 0, alpha: 0.5 } } }).webp().toBuffer();
  const animatedWebp = await sharp([validV2Atlas, secondV2Frame], { join: { animated: true } }).webp({ delay: [100, 100], loop: 0 }).toBuffer();
  await assert.rejects(() => validateCodexPetSpritesheet(animatedWebp, v2), /exactly one image/);
  await assert.rejects(() => validateCodexPetSpritesheet(Buffer.from("not an image"), v2), /metadata is invalid/);
  await validateCodexPetSpritesheet(Buffer.from("not an image"), valid);
  console.log("Codex pet validation and V2 layout contracts passed.");
}

runImageContracts().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
