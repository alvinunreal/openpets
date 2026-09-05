import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isLatestPetRenderSequence } from "../src/pet-render-lifecycle.js";

describe("pet render sequence lifecycle", () => {
  it("rejects an older in-place update after a newer render is requested", () => {
    assert.equal(isLatestPetRenderSequence(2, 1), false);
    assert.equal(isLatestPetRenderSequence(2, 2), true);
    assert.equal(isLatestPetRenderSequence(undefined, 1), false);
  });
});
