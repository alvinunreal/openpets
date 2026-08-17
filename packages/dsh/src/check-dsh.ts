import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { apply, name } from "./index.js";

assert.equal(name, "@open-pets/dsh");
assert.equal(typeof apply, "function");

{
  const packageDirectory = join(import.meta.dirname, "..");
  const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as Record<string, unknown>;
  assert.equal(manifest.name, "@open-pets/dsh");
  assert.equal(manifest.version, "3.3.0");
  assert.deepEqual(manifest.files, [
    "dist/index.d.ts",
    "dist/index.js",
    "dist/runtime.d.ts",
    "dist/runtime.js",
    "cordis.patch.yml",
  ]);
  assert.deepEqual(manifest.exports, {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json",
  });
  assert.deepEqual(manifest.dsh, { bundle: { patch: "./cordis.patch.yml" } });
  assert.equal((manifest.peerDependencies as Record<string, string>)["@deepseek-ai/cordis"], "^4.0.1");
  for (const output of ["dist/index.js", "dist/index.d.ts", "dist/runtime.js", "dist/runtime.d.ts"]) {
    assert.equal(existsSync(join(packageDirectory, output)), true);
  }
  const patchLines = readFileSync(join(packageDirectory, "cordis.patch.yml"), "utf8").trim().split(/\r?\n/);
  assert.deepEqual(patchLines.map((line) => line.trim()), [
    "- insert:",
    "- id: openpets-dsh",
    "name: '@open-pets/dsh'",
  ]);
  assert.equal(patchLines[0]?.trimStart().startsWith("- "), true, "patch must be a top-level YAML array");
  assert.equal(patchLines[1]?.trimStart().startsWith("- "), true, "insert value must be a YAML array");
  assert.equal(createRequire(import.meta.url)("@open-pets/dsh/package.json").name, "@open-pets/dsh");
}

console.log("DSH package artifact checks passed.");
