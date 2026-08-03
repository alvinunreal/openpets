import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { hookSpeechPools, validateHookSpeech } from "@open-pets/agent-events";

import { createOpenCodeExecutableDetection, executePlannedWrite, getGlobalOpenCodeConfigDir, getGlobalOpenCodeConfigPaths, getProjectOpenCodeConfigPaths, parseOpenCodeConfig, planOpenCodeConfigWrite, selectProjectOpenCodeConfigPath, updateOpenCodeConfigText } from "./opencode-config.js";
import { buildOpenCodeInstructionPath, buildOpenCodeMcpEntry, buildOpenCodePluginPreview, formatOpenCodeMcpConfig } from "./opencode-previews.js";
import { doctorOpenCodeGlobalSetup, prepareOpenCodeGlobalRemove, prepareOpenCodeGlobalSetup, writePreparedOpenCodeGlobalRemove, writePreparedOpenCodeGlobalSetup } from "./opencode-global-setup.js";
import { classifyOpenCodeInstructionsStatus, classifyOpenCodeMcpStatus, classifyOpenCodePluginStatus } from "./opencode-status.js";

const root = mkdtempSync(join(tmpdir(), "openpets-opencode-"));
try {
  const project = join(root, "project");
  mkdirSync(project);
  const paths = getProjectOpenCodeConfigPaths(project);
  assert.deepEqual(paths.candidates.map((path) => path.slice(project.length + 1)), ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"]);
  assert.equal(selectProjectOpenCodeConfigPath(project), join(project, ".opencode", "opencode.jsonc"));
  mkdirSync(join(project, ".opencode"));
  writeFileSync(join(project, ".opencode", "opencode.jsonc"), "{}\n");
  assert.equal(selectProjectOpenCodeConfigPath(project), join(project, ".opencode", "opencode.jsonc"));
  writeFileSync(join(project, "opencode.json"), "{}\n");
  assert.equal(selectProjectOpenCodeConfigPath(project), join(project, "opencode.json"));

  assert.equal(getGlobalOpenCodeConfigDir({ OPENCODE_CONFIG_DIR: join(root, "custom") }, root, "linux"), join(root, "custom"));
  assert.equal(getGlobalOpenCodeConfigDir({ XDG_CONFIG_HOME: join(root, "xdg") }, root, "linux"), join(root, "xdg", "opencode"));
  assert.equal(getGlobalOpenCodeConfigDir({ APPDATA: join(root, "appdata") }, root, "win32"), join(root, ".config", "opencode"), "Windows OpenCode config is XDG-based, not stored under APPDATA.");
  assert.equal(getGlobalOpenCodeConfigDir({ XDG_CONFIG_HOME: join(root, "xdg") }, root, "win32"), join(root, "xdg", "opencode"));
  assert.deepEqual(getGlobalOpenCodeConfigPaths({ OPENCODE_CONFIG_DIR: join(root, "global") }, root, "linux").candidates.map((path) => path.slice(join(root, "global").length + 1)), ["config.json", "opencode.json", "opencode.jsonc"]);
  assert.deepEqual(createOpenCodeExecutableDetection({ platform: "win32" }).command, "opencode");
  assert.deepEqual(createOpenCodeExecutableDetection({ platform: "darwin" }).command, "opencode");

  assert.deepEqual(formatOpenCodeMcpConfig({ cliVersion: "0.0.0", petId: "fixer" }), { mcp: { openpets: { type: "local", command: ["npx", "-y", "@open-pets/cli@0.0.0", "mcp", "--pet", "fixer"], enabled: true } } });
  assert.deepEqual(buildOpenCodeMcpEntry({ cliVersion: "0.0.0" }), { type: "local", command: ["npx", "-y", "@open-pets/cli@0.0.0", "mcp"], enabled: true });
  assert.deepEqual(buildOpenCodeMcpEntry({ cliVersion: "0.0.0", environment: { OPENPETS_DISCOVERY_FILE: "/mnt/c/Users/alvin/AppData/Roaming/OpenPets/runtime/ipc.json" } }), { type: "local", command: ["npx", "-y", "@open-pets/cli@0.0.0", "mcp"], enabled: true, environment: { OPENPETS_DISCOVERY_FILE: "/mnt/c/Users/alvin/AppData/Roaming/OpenPets/runtime/ipc.json" } });
  assert.deepEqual(buildOpenCodeMcpEntry({ cliVersion: "0.0.0", commandMode: "local", cliEntryPath: join(root, "cli.js"), petId: "fixer" }), { type: "local", command: ["node", join(root, "cli.js"), "mcp", "--pet", "fixer"], enabled: true });
  assert.throws(() => buildOpenCodeMcpEntry({ cliVersion: "0.0.0", commandMode: "local", cliEntryPath: "relative.js" }));
  assert.throws(() => buildOpenCodeMcpEntry({ cliVersion: "0.0.0", petId: "bad/pet" }));
  assert.equal(buildOpenCodeInstructionPath("project"), ".opencode/openpets.md");
  assert.equal(buildOpenCodeInstructionPath("global", join(root, "global")), join(root, "global", "openpets.md"));
  assert.deepEqual(buildOpenCodePluginPreview({ petId: "fixer" }), ["@open-pets/opencode", { pet: "fixer" }]);
  assert.deepEqual(buildOpenCodePluginPreview({ petId: "fixer", packageVersion: "0.0.0" }), ["@open-pets/opencode@0.0.0", { pet: "fixer" }]);
  assert.deepEqual(buildOpenCodePluginPreview({}), "@open-pets/opencode");
  assert.deepEqual(buildOpenCodePluginPreview({ excludeReactions: ["success", "thinking", "not-a-reaction"] }), ["@open-pets/opencode", { excludeReactions: ["success", "thinking"] }], "config previews must not persist unrecognized exclusions");
  assert.deepEqual(buildOpenCodePluginPreview({ petId: "fixer", excludeReactions: ["success"] }), ["@open-pets/opencode", { pet: "fixer", excludeReactions: ["success"] }]);

  const jsonc = `{
    // keep this comment
    "theme": "dark",
    "mcp": { "other": { "type": "local", "command": ["x"] } },
  }`;
  const parsed = parseOpenCodeConfig(jsonc);
  assert.equal(parsed.ok, true);
  const updated = updateOpenCodeConfigText(jsonc, [{ path: ["mcp", "openpets"], value: buildOpenCodeMcpEntry({ cliVersion: "0.0.0", petId: "fixer" }) }]);
  assert.equal(typeof updated, "string");
  assert.match(String(updated), /keep this comment/);
  assert.match(String(updated), /"openpets"/);
  assert.match(String(updated), /"other"/);
  assert.equal(parseOpenCodeConfig("{").ok, false);
  assert.equal(parseOpenCodeConfig("[]").ok, false);
  assert.equal(parseOpenCodeConfig(JSON.stringify({ mcp: [] })).ok, false);
  assert.equal(parseOpenCodeConfig(JSON.stringify({ instructions: "x" })).ok, false);
  assert.equal(parseOpenCodeConfig(JSON.stringify({ plugin: {} })).ok, false);
  assert.equal(parseOpenCodeConfig(JSON.stringify({ instructions: [1] })).ok, false);
  assert.equal(parseOpenCodeConfig(`{"x":"${"a".repeat(1024 * 1024)}"}`).ok, false);

  const expected = { cliVersion: "0.0.0", petId: "fixer" };
  assert.equal(classifyOpenCodeMcpStatus([], expected).status, "not_installed");
  assert.equal(classifyOpenCodeMcpStatus([{ mcp: { openpets: buildOpenCodeMcpEntry(expected) } }], expected).status, "installed");
  assert.equal(classifyOpenCodeMcpStatus([{ mcp: { openpets: { ...buildOpenCodeMcpEntry(expected), environment: { OPENPETS_DISCOVERY_FILE: "/mnt/c/Users/alvin/AppData/Roaming/OpenPets/runtime/ipc.json" } } } }], expected).status, "installed");
  assert.equal(classifyOpenCodeMcpStatus([{ mcp: { openpets: { command: ["npx", "-y", "@open-pets/cli@0.0.0", "mcp", "--pet", "fixer"], enabled: true, type: "local" } } }], expected).status, "installed");
  assert.equal(classifyOpenCodeMcpStatus([{ mcp: { openpets: buildOpenCodeMcpEntry({ cliVersion: "0.0.0", petId: "helper" }) } }], expected).status, "needs_update");
  assert.equal(classifyOpenCodeMcpStatus([{ mcp: { openpets: buildOpenCodeMcpEntry({ cliVersion: "0.0.0", commandMode: "local", cliEntryPath: join(root, "cli.js"), petId: "helper" }) } }], { cliVersion: "0.0.0", commandMode: "local", cliEntryPath: join(root, "cli.js"), petId: "fixer" }).status, "needs_update");
  assert.equal(classifyOpenCodeMcpStatus([{ mcp: { openpets: { type: "local", command: ["npx", "-y", "@open-pets/cli@0.0.0", "mcp", "--pet", "fixer"], enabled: false } } }], expected).status, "custom");
  assert.equal(classifyOpenCodeMcpStatus([{ mcp: { openpets: { type: "remote", command: ["npx", "-y", "@open-pets/cli@0.0.0", "mcp", "--pet", "fixer"], enabled: true } } }], expected).status, "custom");
  assert.equal(classifyOpenCodeMcpStatus([{ mcp: { openpets: { type: "local", command: ["npx", "-y", "@open-pets/cli@file:../cli", "mcp", "--pet", "fixer"], enabled: true } } }], expected).status, "custom");
  assert.equal(classifyOpenCodeMcpStatus([{ mcp: { openpets: { type: "local", command: ["npx", "-y", "@open-pets/cli@workspace:*", "mcp", "--pet", "fixer"], enabled: true } } }], expected).status, "custom");
  assert.equal(classifyOpenCodeMcpStatus([{ mcp: { openpets: { type: "local", command: ["npx", "-y", "@open-pets/cli@0.0.0", "mcp", "--pet", "fixer"], enabled: true, timeout: 10 } } }], expected).status, "custom");
  assert.equal(classifyOpenCodeMcpStatus([{ mcp: { openpets: { type: "local", command: ["my-openpets-wrapper"] } } }], expected).status, "custom");
  assert.equal(classifyOpenCodeMcpStatus([{ mcp: { openpets: buildOpenCodeMcpEntry(expected) } }, { mcp: { openpets: buildOpenCodeMcpEntry({ cliVersion: "0.0.0", petId: "helper" }) } }], expected).status, "conflict");
  assert.equal(classifyOpenCodeInstructionsStatus([{ instructions: [".opencode/openpets.md"] }], "project", undefined, { ".opencode/openpets.md": "<!-- OPENPETS:START -->\nHi\n<!-- OPENPETS:END -->\n" }).status, "installed");
  assert.equal(classifyOpenCodeInstructionsStatus([{ instructions: [".opencode/openpets.md"] }], "project").status, "needs_update");
  assert.equal(classifyOpenCodeInstructionsStatus([{ instructions: [".opencode/openpets.md"] }, { instructions: ["old-openpets.md"] }], "project", undefined, { ".opencode/openpets.md": "<!-- OPENPETS:START -->\nHi\n<!-- OPENPETS:END -->\n" }).status, "conflict");
  assert.equal(classifyOpenCodeInstructionsStatus([{ instructions: ["old-openpets.md"] }], "project").status, "custom");
  assert.equal(classifyOpenCodePluginStatus([{ plugin: [["@open-pets/opencode", { pet: "fixer" }]] }], "fixer").status, "installed");
  assert.equal(classifyOpenCodePluginStatus([{ plugin: [["@open-pets/opencode@0.0.0", { pet: "fixer" }]] }], "fixer", "0.0.0").status, "installed");
  assert.equal(classifyOpenCodePluginStatus([{ plugin: ["@open-pets/opencode"] }], "fixer").status, "needs_update");
  assert.equal(classifyOpenCodePluginStatus([{ plugin: [["@open-pets/opencode@old", { pet: "helper" }], "./openpets-custom-plugin.js"] }], "fixer", "0.0.0").status, "conflict");
  assert.equal(classifyOpenCodePluginStatus([{ plugin: [["@open-pets/opencode@0.0.0"]] }], "fixer", "0.0.0").status, "custom");
  assert.equal(classifyOpenCodePluginStatus([{ plugin: [["@open-pets/opencode@0.0.0", {}]] }], "fixer", "0.0.0").status, "custom");
  assert.equal(classifyOpenCodePluginStatus([{ plugin: [["@open-pets/opencode@0.0.0", { pet: "fixer" }, "extra"]] }], "fixer", "0.0.0").status, "custom");
  assert.equal(classifyOpenCodePluginStatus([{ plugin: [["@open-pets/opencode@0.0.0", { pet: "fixer", extra: true }]] }], "fixer", "0.0.0").status, "custom");
  assert.equal(classifyOpenCodePluginStatus([{ plugin: [["@open-pets/opencode@0.0.0", { pet: "fixer", excludeReactions: ["success"] }]] }], "fixer", "0.0.0").status, "needs_update", "plugin with excludeReactions but no matching expected spec should need update");
  assert.equal(classifyOpenCodePluginStatus([{ plugin: [["@open-pets/opencode@0.0.0", { pet: "helper", excludeReactions: ["success"] }]] }], "fixer", "0.0.0").status, "needs_update", "plugin with excludeReactions but wrong pet is managed-but-outdated");
  assert.equal(classifyOpenCodePluginStatus([{ plugin: [["@open-pets/opencode@0.0.0", { excludeReactions: ["success", "thinking"] }]] }], undefined, "0.0.0", ["thinking", "success"]).status, "installed", "exclusions-only plugin options round-trip without a pet regardless of ordering");
  assert.equal(classifyOpenCodePluginStatus([{ plugin: [["@open-pets/opencode@0.0.0", { excludeReactions: ["success", 1] }]] }], undefined, "0.0.0", ["success"]).status, "custom", "invalid exclusions remain custom rather than managed");
  assert.equal(classifyOpenCodePluginStatus([{ plugin: ["./openpets-custom-plugin.js"] }], "fixer").status, "custom");
  assert.equal(classifyOpenCodePluginStatus([{ plugin: [["@open-pets/opencode", { pet: "fixer" }], "./openpets-custom-plugin.js"] }], "fixer").status, "conflict");

  const writeTarget = join(root, "write", "opencode.jsonc");
  const writePlan = planOpenCodeConfigWrite(root, writeTarget, "{\"mcp\":{}}\n");
  if ("targetPath" in writePlan) {
    executePlannedWrite(writePlan);
    assert.equal(existsSync(writeTarget), true);
    const second = planOpenCodeConfigWrite(root, writeTarget, "{\"mcp\":{}}\n");
    assert.equal("backupPath" in second && Boolean(second.backupPath), true);
    if ("targetPath" in second && second.backupPath) {
      writeFileSync(second.backupPath, "already exists");
      assert.throws(() => executePlannedWrite(second));
    }
    assert.throws(() => executePlannedWrite({ ...writePlan, rootPath: join(root, "missing-root") }));
    assert.throws(() => executePlannedWrite({ ...writePlan, tempPath: join(tmpdir(), "openpets-unsafe.tmp") }));
    assert.throws(() => executePlannedWrite({ ...writePlan, backupPath: join(tmpdir(), "openpets-unsafe.backup") }));
  }
  const outsidePlan = planOpenCodeConfigWrite(root, join(tmpdir(), "outside-opencode.jsonc"), "{}\n");
  assert.equal("ok" in outsidePlan ? outsidePlan.ok : true, false);
  const linkTarget = join(root, "link-target");
  mkdirSync(linkTarget);
  symlinkSync(linkTarget, join(root, "link-parent"));
  const linkParentPlan = planOpenCodeConfigWrite(root, join(root, "link-parent", "opencode.jsonc"), "{}\n");
  assert.equal("ok" in linkParentPlan ? linkParentPlan.ok : true, false);
  const linkedFile = join(root, "linked-file.jsonc");
  writeFileSync(join(root, "real-file.jsonc"), "{}\n");
  symlinkSync(join(root, "real-file.jsonc"), linkedFile);
  const linkedFilePlan = planOpenCodeConfigWrite(root, linkedFile, "{}\n");
  assert.equal("ok" in linkedFilePlan ? linkedFilePlan.ok : true, false);
  symlinkSync(project, join(root, "project-link"));
  assert.throws(() => getProjectOpenCodeConfigPaths(join(root, "project-link")));

  const globalDir = join(root, "global-missing");
  const globalPrepared = prepareOpenCodeGlobalSetup({ configDir: globalDir, petId: "fixer", cliVersion: "0.0.0" });
  writePreparedOpenCodeGlobalSetup(globalPrepared);
  assert.equal(existsSync(join(globalDir, "opencode.jsonc")), true);
  assert.equal(doctorOpenCodeGlobalSetup(globalDir).status, "installed");
  const globalConfig = readFileSync(join(globalDir, "opencode.jsonc"), "utf8");
  assert.match(globalConfig, /@open-pets\/opencode@0\.0\.0/);
  assert.match(readFileSync(join(globalDir, "openpets.md"), "utf8"), /OPENPETS:START/);
  const globalRemove = prepareOpenCodeGlobalRemove(globalDir);
  writePreparedOpenCodeGlobalRemove(globalRemove);
  assert.equal(doctorOpenCodeGlobalSetup(globalDir).status, "not_installed");

  const globalExclusionsOnly = join(root, "global-exclusions-only");
  writePreparedOpenCodeGlobalSetup(prepareOpenCodeGlobalSetup({ configDir: globalExclusionsOnly, cliVersion: "0.0.0", excludeReactions: ["success", "thinking", "not-a-reaction"] }));
  assert.doesNotMatch(readFileSync(join(globalExclusionsOnly, "opencode.jsonc"), "utf8"), /not-a-reaction/, "setup must not persist unrecognized exclusions");
  assert.doesNotThrow(() => prepareOpenCodeGlobalSetup({ configDir: globalExclusionsOnly, cliVersion: "0.0.0", excludeReactions: ["thinking", "success", "not-a-reaction"] }), "exclusions-only setup should recognize its existing plugin entry");

  const globalLower = join(root, "global-lower");
  mkdirSync(globalLower);
  writeFileSync(join(globalLower, "config.json"), JSON.stringify({ theme: "keep" }), "utf8");
  writeFileSync(join(globalLower, "opencode.jsonc"), JSON.stringify({ plugin: [["@open-pets/opencode@old", { pet: "helper" }]] }), "utf8");
  writePreparedOpenCodeGlobalSetup(prepareOpenCodeGlobalSetup({ configDir: globalLower, petId: "fixer", cliVersion: "0.0.0" }));
  assert.equal(readFileSync(join(globalLower, "config.json"), "utf8").includes("@open-pets/opencode"), false);
  assert.match(readFileSync(join(globalLower, "opencode.jsonc"), "utf8"), /@open-pets\/opencode@0\.0\.0/);

  const globalExistingJson = join(root, "global-existing-json");
  mkdirSync(globalExistingJson);
  writeFileSync(join(globalExistingJson, "opencode.json"), JSON.stringify({ plugin: ["user-plugin"], instructions: ["USER.md"] }, null, 2), "utf8");
  const existingJsonPrepared = prepareOpenCodeGlobalSetup({ configDir: globalExistingJson, petId: "fixer", cliVersion: "0.0.0" });
  assert.equal(existingJsonPrepared.configPath, join(globalExistingJson, "opencode.json"));
  writePreparedOpenCodeGlobalSetup(existingJsonPrepared);
  assert.equal(existsSync(join(globalExistingJson, "opencode.jsonc")), false, "desktop global setup must not create a higher-precedence opencode.jsonc over an existing opencode.json");
  const existingJsonConfig = JSON.parse(readFileSync(join(globalExistingJson, "opencode.json"), "utf8")) as { readonly plugin?: readonly unknown[]; readonly instructions?: readonly string[] };
  assert.deepEqual(existingJsonConfig.plugin?.[0], "user-plugin");
  assert.ok(existingJsonConfig.instructions?.includes("USER.md"));

  const globalExistingMultiple = join(root, "global-existing-multiple");
  mkdirSync(globalExistingMultiple);
  writeFileSync(join(globalExistingMultiple, "config.json"), JSON.stringify({ theme: "base" }, null, 2), "utf8");
  writeFileSync(join(globalExistingMultiple, "opencode.json"), JSON.stringify({ plugin: ["user-plugin"] }, null, 2), "utf8");
  const existingMultiplePrepared = prepareOpenCodeGlobalSetup({ configDir: globalExistingMultiple, petId: "fixer", cliVersion: "0.0.0" });
  assert.equal(existingMultiplePrepared.configPath, join(globalExistingMultiple, "opencode.json"));
  assert.equal(readFileSync(join(globalExistingMultiple, "config.json"), "utf8").includes("openpets"), false);

  const globalLowerPluginOwner = join(root, "global-lower-plugin-owner");
  mkdirSync(globalLowerPluginOwner);
  writeFileSync(join(globalLowerPluginOwner, "config.json"), JSON.stringify({ plugin: ["user-plugin"] }, null, 2), "utf8");
  writeFileSync(join(globalLowerPluginOwner, "opencode.json"), JSON.stringify({ theme: "dark" }, null, 2), "utf8");
  const lowerPluginPrepared = prepareOpenCodeGlobalSetup({ configDir: globalLowerPluginOwner, petId: "fixer", cliVersion: "0.0.0" });
  assert.equal(lowerPluginPrepared.configPath, join(globalLowerPluginOwner, "config.json"));
  writePreparedOpenCodeGlobalSetup(lowerPluginPrepared);
  const lowerPluginConfig = JSON.parse(readFileSync(join(globalLowerPluginOwner, "config.json"), "utf8")) as { readonly plugin?: readonly unknown[] };
  assert.deepEqual(lowerPluginConfig.plugin?.[0], "user-plugin");
  assert.equal(readFileSync(join(globalLowerPluginOwner, "opencode.json"), "utf8").includes("openpets"), false);

  const globalSplitArrayOwners = join(root, "global-split-array-owners");
  mkdirSync(globalSplitArrayOwners);
  writeFileSync(join(globalSplitArrayOwners, "config.json"), JSON.stringify({ plugin: ["user-plugin"] }, null, 2), "utf8");
  writeFileSync(join(globalSplitArrayOwners, "opencode.json"), JSON.stringify({ instructions: ["USER.md"] }, null, 2), "utf8");
  assert.throws(() => prepareOpenCodeGlobalSetup({ configDir: globalSplitArrayOwners, petId: "fixer", cliVersion: "0.0.0" }), /different config files/);

  const globalEmptyPluginShadow = join(root, "global-empty-plugin-shadow");
  mkdirSync(globalEmptyPluginShadow);
  writeFileSync(join(globalEmptyPluginShadow, "config.json"), JSON.stringify({ plugin: ["user-plugin"] }, null, 2), "utf8");
  writeFileSync(join(globalEmptyPluginShadow, "opencode.json"), JSON.stringify({ plugin: [] }, null, 2), "utf8");
  assert.throws(() => prepareOpenCodeGlobalSetup({ configDir: globalEmptyPluginShadow, petId: "fixer", cliVersion: "0.0.0" }), /higher-precedence config shadows user plugin/);

  const globalEmptyInstructionShadow = join(root, "global-empty-instruction-shadow");
  mkdirSync(globalEmptyInstructionShadow);
  writeFileSync(join(globalEmptyInstructionShadow, "config.json"), JSON.stringify({ instructions: ["USER.md"] }, null, 2), "utf8");
  writeFileSync(join(globalEmptyInstructionShadow, "opencode.json"), JSON.stringify({ instructions: [] }, null, 2), "utf8");
  assert.throws(() => prepareOpenCodeGlobalSetup({ configDir: globalEmptyInstructionShadow, petId: "fixer", cliVersion: "0.0.0" }), /higher-precedence config shadows user instructions/);

  const globalEmptyArrayOwner = join(root, "global-empty-array-owner");
  mkdirSync(globalEmptyArrayOwner);
  writeFileSync(join(globalEmptyArrayOwner, "opencode.json"), JSON.stringify({ plugin: [] }, null, 2), "utf8");
  const emptyArrayOwnerPrepared = prepareOpenCodeGlobalSetup({ configDir: globalEmptyArrayOwner, petId: "fixer", cliVersion: "0.0.0" });
  assert.equal(emptyArrayOwnerPrepared.configPath, join(globalEmptyArrayOwner, "opencode.json"));

  const globalStaleOverlay = join(root, "global-stale-overlay");
  mkdirSync(globalStaleOverlay);
  writeFileSync(join(globalStaleOverlay, "opencode.json"), JSON.stringify({ plugin: ["user-plugin"], instructions: ["USER.md"] }, null, 2), "utf8");
  writeFileSync(join(globalStaleOverlay, "opencode.jsonc"), JSON.stringify({ plugin: [["@open-pets/opencode@0.0.0", { pet: "helper" }]], instructions: [buildOpenCodeInstructionPath("global", globalStaleOverlay)] }, null, 2), "utf8");
  const stalePrepared = prepareOpenCodeGlobalSetup({ configDir: globalStaleOverlay, petId: "fixer", cliVersion: "0.0.1" });
  assert.equal(stalePrepared.configPath, join(globalStaleOverlay, "opencode.json"));
  assert.equal(stalePrepared.cleanupConfigWrites.length, 1);
  writePreparedOpenCodeGlobalSetup(stalePrepared);
  const staleOwnerConfig = JSON.parse(readFileSync(join(globalStaleOverlay, "opencode.json"), "utf8")) as { readonly plugin?: readonly unknown[]; readonly instructions?: readonly string[] };
  assert.deepEqual(staleOwnerConfig.plugin?.[0], "user-plugin");
  assert.ok(staleOwnerConfig.instructions?.includes("USER.md"));
  const staleOverlayText = readFileSync(join(globalStaleOverlay, "opencode.jsonc"), "utf8");
  assert.doesNotMatch(staleOverlayText, /plugin/);
  assert.doesNotMatch(staleOverlayText, /instructions/);

  const globalStaleRemove = join(root, "global-stale-remove");
  mkdirSync(globalStaleRemove);
  writeFileSync(join(globalStaleRemove, "opencode.json"), JSON.stringify({ plugin: ["user-plugin"] }, null, 2), "utf8");
  writeFileSync(join(globalStaleRemove, "opencode.jsonc"), JSON.stringify({ plugin: [["@open-pets/opencode@0.0.0", { pet: "fixer" }]] }, null, 2), "utf8");
  writePreparedOpenCodeGlobalRemove(prepareOpenCodeGlobalRemove(globalStaleRemove));
  assert.doesNotMatch(readFileSync(join(globalStaleRemove, "opencode.jsonc"), "utf8"), /plugin/);
  assert.match(readFileSync(join(globalStaleRemove, "opencode.json"), "utf8"), /user-plugin/);

  const globalPublishedToBundled = join(root, "global-published-to-bundled");
  mkdirSync(globalPublishedToBundled);
  writeFileSync(join(globalPublishedToBundled, "opencode.jsonc"), JSON.stringify({ mcp: { openpets: buildOpenCodeMcpEntry({ cliVersion: "0.0.0", petId: "helper" }) } }), "utf8");
  const bundledCli = join(root, "app.asar.unpacked", "node_modules", "@open-pets", "cli", "dist", "index.js");
  const migrated = prepareOpenCodeGlobalSetup({ configDir: globalPublishedToBundled, petId: "fixer", cliVersion: "0.0.1", pluginVersion: "0.0.2", commandMode: "bundled", cliEntryPath: bundledCli });
  assert.equal(migrated.configPath, join(globalPublishedToBundled, "opencode.jsonc"));
  assert.match(migrated.configWrite.content, /app\.asar\.unpacked/);
  assert.doesNotMatch(migrated.configWrite.content, /app\.asar(?!\.unpacked)/);
  assert.match(migrated.configWrite.content, /@open-pets\/opencode@0\.0\.2/);

  const globalNoInstructionMarkers = join(root, "global-no-instruction-markers");
  mkdirSync(globalNoInstructionMarkers);
  writeFileSync(join(globalNoInstructionMarkers, "opencode.jsonc"), JSON.stringify({ instructions: [buildOpenCodeInstructionPath("global", globalNoInstructionMarkers)] }), "utf8");
  writeFileSync(join(globalNoInstructionMarkers, "openpets.md"), "user owned\n", "utf8");
  const noMarkerRemove = prepareOpenCodeGlobalRemove(globalNoInstructionMarkers);
  assert.equal(noMarkerRemove.instructionWrite, undefined);

  const globalCustomPluginOptions = join(root, "global-custom-plugin-options");
  mkdirSync(globalCustomPluginOptions);
  writeFileSync(join(globalCustomPluginOptions, "opencode.jsonc"), JSON.stringify({ plugin: [["@open-pets/opencode@0.0.0", { pet: "fixer", extra: true }]] }), "utf8");
  assert.throws(() => prepareOpenCodeGlobalSetup({ configDir: globalCustomPluginOptions, petId: "fixer", cliVersion: "0.0.0" }));

  const globalCustom = join(root, "global-custom");
  mkdirSync(globalCustom);
  writeFileSync(join(globalCustom, "opencode.jsonc"), JSON.stringify({ mcp: { openpets: { type: "local", command: ["custom", "mcp"] } } }), "utf8");
  assert.throws(() => prepareOpenCodeGlobalSetup({ configDir: globalCustom, petId: "fixer", cliVersion: "0.0.0" }));
  assert.throws(() => prepareOpenCodeGlobalRemove(globalCustom));

  const globalManagedMcpEnvironment = join(root, "global-managed-mcp-environment");
  mkdirSync(globalManagedMcpEnvironment);
  writeFileSync(join(globalManagedMcpEnvironment, "opencode.jsonc"), JSON.stringify({ mcp: { openpets: { type: "local", command: ["npx", "-y", "@open-pets/cli@0.0.0", "mcp", "--pet", "fixer"], enabled: true, environment: { OPENPETS_DEBUG: "1" } } } }), "utf8");
  assert.doesNotThrow(() => prepareOpenCodeGlobalSetup({ configDir: globalManagedMcpEnvironment, petId: "fixer", cliVersion: "0.0.0" }));

  const globalSymlink = join(root, "global-symlink");
  const globalOutside = join(root, "global-outside");
  mkdirSync(globalOutside);
  writeFileSync(join(globalOutside, "opencode.jsonc"), "{}\n", "utf8");
  symlinkSync(globalOutside, globalSymlink);
  assert.equal(doctorOpenCodeGlobalSetup(globalSymlink).status, "error");

  for (const [category, messages] of Object.entries(hookSpeechPools) as Array<[string, readonly string[]]>) {
    for (const message of messages) {
      assert.match(message, /^[A-Z]/, `${category} hook speech must start uppercase`);
      validateHookSpeech(message);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.error("OpenCode foundation validation passed.");
