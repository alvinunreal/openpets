import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { catalogPackageFiles, assertCatalogAllowlist } from "./package-catalog.mjs";

const manifest = JSON.parse(readFileSync(new URL("../openpets.plugin.json", import.meta.url), "utf8"));
const files = catalogPackageFiles(manifest);

assert.ok(files.includes("openpets.plugin.json"));
assert.ok(files.includes("index.js"));
assert.ok(files.includes("LICENSE"));
assert.ok(files.includes("locales/en.json"));
assert.ok(files.includes("assets/cpu.svg"));
assert.ok(!files.includes("package.json"));
assert.ok(!files.some((file) => file.startsWith("scripts/") || file.startsWith("sidecar/")));
assertCatalogAllowlist(files);
assert.throws(() => assertCatalogAllowlist(["sidecar/collect.mjs"]), /must not include/);

console.log("package-catalog: all checks passed.");
