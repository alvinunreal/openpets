export function getLinuxX11RelaunchArgs(
  platform: NodeJS.Platform,
  allowWayland: boolean,
  argv: readonly string[],
): string[] | null {
  if (platform !== "linux" || allowWayland || hasX11OzoneArg(argv)) return null;
  return [...removeOzonePlatformArgs(argv.slice(1)), "--ozone-platform=x11"];
}

function hasX11OzoneArg(argv: readonly string[]): boolean {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--ozone-platform") return argv[index + 1] === "x11";
    if (arg.startsWith("--ozone-platform=")) return arg.slice("--ozone-platform=".length) === "x11";
  }
  return false;
}

function removeOzonePlatformArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--ozone-platform") {
      if (index + 1 < args.length && !args[index + 1].startsWith("--")) index += 1;
      continue;
    }
    if (arg.startsWith("--ozone-platform=")) continue;
    result.push(arg);
  }
  return result;
}
