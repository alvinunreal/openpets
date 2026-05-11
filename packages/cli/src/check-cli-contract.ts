import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { assertSafeProjectHookPath, cliPackageName, configureProject, createClaudeMcpAddJsonArgs, createLocalDevCliCommand, createVersionPinnedCliCommand, installProjectLocalHooks, parseConfigureArgs, parseInstallArgs, resolveConfiguredPet, runClaudeMcpAddJson } from "./index.js";

const parsed = parseConfigureArgs(["--agent", "claude", "--pet", "fixer", "--cwd", "/tmp/project", "--yes"]);
assert.equal(parsed.agent, "claude");
assert.equal(parsed.petId, "fixer");
assert.equal(parsed.cwd, "/tmp/project");
assert.equal(parsed.yes, true);
assert.equal(parseConfigureArgs(["--pet", "fixer", "--force"]).force, true);
assert.equal(parseConfigureArgs(["--pet", "fixer", "--replace"]).force, true);
assert.equal(parseConfigureArgs(["--pet", "fixer", "--local-dev"]).localDev, true);
assert.equal(parseConfigureArgs(["--pet=fixer"]).petId, "fixer");
assert.equal(parseConfigureArgs(["--agent", "opencode", "--pet", "fixer"]).agent, "opencode");
assert.equal(parseConfigureArgs(["--agent", "codex", "--pet", "fixer"]).agent, "codex");
assert.throws(() => parseConfigureArgs(["--agent", "cursor"]));
assert.throws(() => parseConfigureArgs(["--pet", "bad/pet"]));
assert.deepEqual(parseInstallArgs(["review-owl"]), { petId: "review-owl" });
assert.throws(() => parseInstallArgs([]));
assert.throws(() => parseInstallArgs(["bad/pet"]));

const pinned = createVersionPinnedCliCommand("1.2.3", ["mcp", "--pet", "fixer"]);
assert.deepEqual(pinned, { command: "npx", args: ["-y", `${cliPackageName}@1.2.3`, "mcp", "--pet", "fixer"] });
const localDev = createLocalDevCliCommand(["mcp", "--pet", "fixer"]);
assert.equal(localDev.command, process.execPath);
assert.deepEqual(localDev.args.slice(-3), ["mcp", "--pet", "fixer"]);

let listPetsCalled = false;
const offlineExplicitPet = await resolveConfiguredPet({
  listPets: async () => {
    listPetsCalled = true;
    throw new Error("desktop unavailable");
  },
}, "fixer");
assert.deepEqual(offlineExplicitPet, { id: "fixer", displayName: "fixer" });
assert.equal(listPetsCalled, false);

const mcpArgs = createClaudeMcpAddJsonArgs({ type: "stdio", command: pinned.command, args: pinned.args, env: {} });
assert.deepEqual(mcpArgs.slice(0, 3), ["mcp", "add-json", "openpets"]);
assert.equal(mcpArgs.at(-2), "--scope");
assert.equal(mcpArgs.at(-1), "local");
const mcpJson = JSON.parse(mcpArgs[3] ?? "{}") as { readonly command?: string; readonly args?: readonly string[] };
assert.equal(mcpJson.command, "npx");
assert.deepEqual(mcpJson.args, ["-y", `${cliPackageName}@1.2.3`, "mcp", "--pet", "fixer"]);

const dir = mkdtempSync(join(tmpdir(), "openpets-cli-"));
try {
  const project = join(dir, "project");
  const settingsDir = join(project, ".claude");
  mkdirSync(project);
  writeFileSync(join(dir, "placeholder"), "x", "utf8");
  assert.throws(() => assertSafeProjectHookPath(join(dir, "missing")));
  installProjectLocalHooks(project, "npx -y @open-pets/cli@1.2.3 hook --openpets-managed --project-local --pet fixer");
  const settingsPath = join(settingsDir, "settings.local.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { readonly hooks?: Record<string, Array<{ readonly hooks: Array<{ readonly command: string }> }>> };
  assert.ok(settings.hooks?.UserPromptSubmit?.[0]?.hooks[0]?.command.includes("--project-local --pet fixer"));

  writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep" }] }, { hooks: [{ type: "command", command: "npx -y @open-pets/cli@old hook --openpets-managed" }] }] } }), "utf8");
  installProjectLocalHooks(project, "npx -y @open-pets/cli@1.2.3 hook --openpets-managed --project-local --pet fixer");
  const updated = JSON.parse(readFileSync(settingsPath, "utf8")) as { readonly hooks?: Record<string, Array<{ readonly hooks: Array<{ readonly command: string; readonly timeout?: number }> }>> };
  const stopCommands = updated.hooks?.Stop?.flatMap((entry) => entry.hooks.map((hook) => hook.command)) ?? [];
  assert.ok(stopCommands.includes("echo keep"));
  assert.equal(stopCommands.some((command) => command.includes("@old")), false);
  assert.ok(stopCommands.some((command) => command.includes("--project-local --pet fixer")));
  assert.equal(updated.hooks?.UserPromptSubmit?.[0]?.hooks[0]?.timeout, 10);

  const badSettingsProject = join(dir, "bad-settings-project");
  mkdirSync(join(badSettingsProject, ".claude"), { recursive: true });
  mkdirSync(join(badSettingsProject, ".claude", "settings.local.json"));
  assert.throws(() => assertSafeProjectHookPath(badSettingsProject));

  const malformedHooksProject = join(dir, "malformed-hooks-project");
  mkdirSync(join(malformedHooksProject, ".claude"), { recursive: true });
  writeFileSync(join(malformedHooksProject, ".claude", "settings.local.json"), JSON.stringify({ hooks: { Stop: { bad: true } } }), "utf8");
  assert.throws(() => installProjectLocalHooks(malformedHooksProject, "npx -y @open-pets/cli@1.2.3 hook --openpets-managed --project-local --pet fixer"));

  const symlinkProject = join(dir, "symlink-project");
  const outside = join(dir, "outside-claude");
  mkdirSync(symlinkProject);
  mkdirSync(outside);
  symlinkSync(outside, join(symlinkProject, ".claude"));
  assert.throws(() => assertSafeProjectHookPath(symlinkProject));

  const binDir = join(dir, "bin");
  const logPath = join(dir, "claude-log.json");
  mkdirSync(binDir);
  const fakeClaude = join(binDir, "claude");
  writeFileSync(fakeClaude, `#!/usr/bin/env node\nconst fs = require('fs'); let log = []; try { log = JSON.parse(fs.readFileSync(${JSON.stringify(logPath)}, 'utf8')); } catch {} log.push({ cwd: process.cwd(), argv: process.argv.slice(2) }); fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(log)); process.exit(0);\n`, "utf8");
  chmodSync(fakeClaude, 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath ?? ""}`;
  try {
    runClaudeMcpAddJson(project, { type: "stdio", command: "npx", args: ["-y", "@open-pets/cli@1.2.3", "mcp", "--pet", "fixer"], env: {} }, true);
  } finally {
    process.env.PATH = oldPath;
  }
  const claudeLog = JSON.parse(readFileSync(logPath, "utf8")) as Array<{ readonly cwd: string; readonly argv: readonly string[] }>;
  assert.equal(claudeLog.at(-1)?.cwd, realpathSync(project));
  assert.deepEqual(claudeLog.at(-2)?.argv, ["mcp", "remove", "openpets", "--scope", "local"]);
  assert.deepEqual(claudeLog.at(-1)?.argv.slice(0, 3), ["mcp", "add-json", "openpets"]);
  const loggedMcpJson = JSON.parse(claudeLog.at(-1)?.argv[3] ?? "{}") as { readonly command?: string; readonly args?: readonly string[]; readonly env?: Record<string, unknown> };
  assert.equal(loggedMcpJson.command, "npx");
  assert.deepEqual(loggedMcpJson.args, ["-y", "@open-pets/cli@1.2.3", "mcp", "--pet", "fixer"]);
  assert.deepEqual(loggedMcpJson.env, {});
  assert.equal(claudeLog.at(-1)?.argv.at(-2), "--scope");
  assert.equal(claudeLog.at(-1)?.argv.at(-1), "local");

  const cliBinLink = join(binDir, "openpets");
  symlinkSync(new URL("./index.js", import.meta.url).pathname, cliBinLink);
  const symlinkedHelp = spawnSync(process.execPath, [cliBinLink, "--help"], { encoding: "utf8" });
  assert.equal(symlinkedHelp.status, 0);
  assert.match(symlinkedHelp.stdout, /Usage:/);

  const opencodeProject = join(dir, "opencode-project");
  mkdirSync(opencodeProject);
  await configureProject({ agent: "opencode", petId: "fixer", cwd: opencodeProject, yes: true, force: false, localDev: false });
  const opencodeConfigPath = join(opencodeProject, ".opencode", "opencode.jsonc");
  const opencodeInstructionPath = join(opencodeProject, ".opencode", "openpets.md");
  const opencodeConfig = JSON.parse(readFileSync(opencodeConfigPath, "utf8")) as { readonly mcp?: Record<string, { readonly command?: readonly string[] }>; readonly instructions?: readonly string[]; readonly plugin?: readonly unknown[] };
  assert.deepEqual(opencodeConfig.mcp?.openpets?.command, ["npx", "-y", "@open-pets/cli@2.0.3", "mcp", "--pet", "fixer"]);
  assert.deepEqual(opencodeConfig.instructions, [".opencode/openpets.md"]);
  assert.deepEqual(opencodeConfig.plugin, [["@open-pets/opencode@2.0.3", { pet: "fixer" }]]);
  assert.match(readFileSync(opencodeInstructionPath, "utf8"), /OPENPETS:START/);
  await configureProject({ agent: "opencode", petId: "fixer", cwd: opencodeProject, yes: true, force: false, localDev: false });
  const opencodeConfigAgain = readFileSync(opencodeConfigPath, "utf8");
  assert.equal((opencodeConfigAgain.match(/@open-pets\/opencode/g) ?? []).length, 1);

  const existingTopLevel = join(dir, "opencode-existing-top");
  mkdirSync(existingTopLevel);
  writeFileSync(join(existingTopLevel, "opencode.json"), JSON.stringify({ theme: "x", mcp: { other: { type: "local", command: ["other"] } }, plugin: ["other-plugin"], instructions: ["README.md"] }, null, 2), "utf8");
  await configureProject({ agent: "opencode", petId: "fixer", cwd: existingTopLevel, yes: true, force: false, localDev: true });
  const existingConfig = JSON.parse(readFileSync(join(existingTopLevel, "opencode.json"), "utf8")) as { readonly theme?: string; readonly mcp?: Record<string, { readonly command?: readonly string[] }>; readonly plugin?: readonly unknown[]; readonly instructions?: readonly string[] };
  assert.equal(existingConfig.theme, "x");
  assert.deepEqual(existingConfig.mcp?.other?.command, ["other"]);
  assert.equal(existingConfig.mcp?.openpets?.command?.[0], "node");
  assert.ok(existingConfig.instructions?.includes("README.md"));
  assert.ok(existingConfig.instructions?.includes(".opencode/openpets.md"));
  assert.ok(existingConfig.plugin?.includes("other-plugin"));

  const lowerOwnerProject = join(dir, "opencode-lower-owner");
  mkdirSync(join(lowerOwnerProject, ".opencode"), { recursive: true });
  writeFileSync(join(lowerOwnerProject, "opencode.json"), JSON.stringify({ theme: "top" }, null, 2), "utf8");
  writeFileSync(join(lowerOwnerProject, ".opencode", "opencode.jsonc"), JSON.stringify({ mcp: { openpets: { type: "local", command: ["npx", "-y", "@open-pets/cli@0.0.1", "mcp", "--pet", "helper"], enabled: true } } }, null, 2), "utf8");
  await configureProject({ agent: "opencode", petId: "fixer", cwd: lowerOwnerProject, yes: true, force: false, localDev: false });
  const lowerTop = readFileSync(join(lowerOwnerProject, "opencode.json"), "utf8");
  const lowerOwned = JSON.parse(readFileSync(join(lowerOwnerProject, ".opencode", "opencode.jsonc"), "utf8")) as { readonly mcp?: Record<string, { readonly command?: readonly string[] }> };
  assert.equal(lowerTop.includes("@open-pets/cli"), false);
  assert.deepEqual(lowerOwned.mcp?.openpets?.command, ["npx", "-y", "@open-pets/cli@2.0.3", "mcp", "--pet", "fixer"]);

  const customProject = join(dir, "opencode-custom");
  mkdirSync(customProject);
  writeFileSync(join(customProject, "opencode.json"), JSON.stringify({ mcp: { openpets: { type: "local", command: ["my-openpets-wrapper"] } } }), "utf8");
  await assert.rejects(() => configureProject({ agent: "opencode", petId: "fixer", cwd: customProject, yes: true, force: false, localDev: false }));
  assert.equal(readFileSync(join(customProject, "opencode.json"), "utf8").includes("@open-pets/cli"), false);

  const instructionProject = join(dir, "opencode-instruction");
  mkdirSync(join(instructionProject, ".opencode"), { recursive: true });
  writeFileSync(join(instructionProject, ".opencode", "openpets.md"), "User text\n", "utf8");
  await configureProject({ agent: "opencode", petId: "fixer", cwd: instructionProject, yes: true, force: false, localDev: false });
  const instructionText = readFileSync(join(instructionProject, ".opencode", "openpets.md"), "utf8");
  assert.match(instructionText, /User text/);
  assert.match(instructionText, /OPENPETS:START/);



  const codexProject = join(dir, "codex-project");
  mkdirSync(codexProject);
  await configureProject({ agent: "codex", petId: "fixer", cwd: codexProject, yes: true, force: false, localDev: false });
  const codexConfigPath = join(codexProject, ".codex", "config.toml");
  const codexConfig = readFileSync(codexConfigPath, "utf8");
  assert.match(codexConfig, /\[mcp_servers\.openpets\]/);
  assert.match(codexConfig, /@open-pets\/cli@2.0.3/);
  await assert.rejects(() => configureProject({ agent: "codex", petId: "fixer", cwd: codexProject, yes: true, force: false, localDev: false }));
  await configureProject({ agent: "codex", petId: "fixer", cwd: codexProject, yes: true, force: true, localDev: true });
  const codexConfigForced = readFileSync(codexConfigPath, "utf8");
  assert.match(codexConfigForced, /command = "node"/);

  const symlinkOpenCodeProject = join(dir, "opencode-symlink");
  const outsideOpenCode = join(dir, "outside-opencode");
  mkdirSync(symlinkOpenCodeProject);
  mkdirSync(outsideOpenCode);
  writeFileSync(join(outsideOpenCode, "opencode.jsonc"), "{}\n", "utf8");
  writeFileSync(join(outsideOpenCode, "openpets.md"), "outside\n", "utf8");
  symlinkSync(outsideOpenCode, join(symlinkOpenCodeProject, ".opencode"));
  await assert.rejects(() => configureProject({ agent: "opencode", petId: "fixer", cwd: symlinkOpenCodeProject, yes: true, force: false, localDev: false }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const invalidHook = spawnSync(process.execPath, [new URL("./index.js", import.meta.url).pathname, "hook", "--openpets-managed", "--pet", "bad/pet"], { input: JSON.stringify({ hook_event_name: "Notification" }), encoding: "utf8" });
assert.equal(invalidHook.status, 1);
const missingPetHook = spawnSync(process.execPath, [new URL("./index.js", import.meta.url).pathname, "hook", "--openpets-managed", "--pet"], { input: JSON.stringify({ hook_event_name: "Notification" }), encoding: "utf8" });
assert.equal(missingPetHook.status, 1);

for (const args of [["--help"], ["-h"], ["install", "--help"], ["configure", "--help"], ["configure", "-h"], ["mcp", "--help"], ["hook", "--help"]]) {
  const help = spawnSync(process.execPath, [new URL("./index.js", import.meta.url).pathname, ...args], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
}

console.error("CLI contract validation passed.");
