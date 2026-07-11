import assert from "node:assert/strict";

import { shouldShowDefaultPetForExternalEvent } from "../src/app-state-core.js";

assert.equal(
  shouldShowDefaultPetForExternalEvent(false, false, false),
  true,
  "external pet.say should show the default pet even when launch display is disabled",
);
assert.equal(
  shouldShowDefaultPetForExternalEvent(false, false, true),
  false,
  "paused state should suppress external default pet display",
);

console.log("default-pet-external-show tests passed.");
