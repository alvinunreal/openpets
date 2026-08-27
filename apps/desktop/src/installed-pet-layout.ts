import { join } from "node:path";

import { getCodexPetSpriteLayout, maxCodexPetJsonBytes, validateCodexPetMetadata, type CodexPetSpriteLayout } from "./codex-pets-core.js";
import { readBoundedRegularFile } from "./pet-file-safety.js";
import { getInstalledPetDir } from "./pet-paths.js";

export async function readInstalledPetSpriteLayout(petId: string): Promise<CodexPetSpriteLayout> {
  const metadataPath = join(getInstalledPetDir(petId), "pet.json");
  const metadata = validateCodexPetMetadata(
    JSON.parse((await readBoundedRegularFile(metadataPath, maxCodexPetJsonBytes, "Installed pet metadata")).toString("utf8")) as unknown,
    petId,
  );
  return getCodexPetSpriteLayout(metadata);
}
