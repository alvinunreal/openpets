import { existsSync } from "node:fs";
import { join } from "node:path";

export interface OpenCodeCommandCandidatesOptions {
  readonly configuredCommand?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly platform?: NodeJS.Platform | string;
}

export function getDefaultOpenCodeCommand(): string {
  return "opencode";
}

export function getOpenCodeCommandCandidates(options: OpenCodeCommandCandidatesOptions): readonly string[] {
  if (options.configuredCommand) return [options.configuredCommand];
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return [getDefaultOpenCodeCommand()];

  const env = options.env ?? process.env;
  const scoopRoots = [
    env.SCOOP,
    join(options.homeDir, "scoop"),
    env.SCOOP_GLOBAL,
    env.ProgramData ? join(env.ProgramData, "scoop") : undefined,
  ].filter((path): path is string => Boolean(path));
  const scoopCommands = [...new Set(scoopRoots)]
    .map((root) => join(root, "shims", "opencode.exe"))
    .filter((command) => existsSync(command));

  return [...scoopCommands, getDefaultOpenCodeCommand(), "opencode.cmd"];
}
