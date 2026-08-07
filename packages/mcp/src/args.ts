export interface McpCliOptions {
  readonly petId?: string;
  readonly help: boolean;
  readonly version: boolean;
}

export function parseMcpArgs(argv: readonly string[]): McpCliOptions {
  let petId: string | undefined;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }
    if (arg === "--pet") {
      const next = argv[index + 1];
      if (!next) throw new Error("--pet requires a pet id.");
      petId = validateRawPetArg(next);
      index += 1;
      continue;
    }
    if (arg.startsWith("--pet=")) {
      petId = validateRawPetArg(arg.slice("--pet=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { petId, help, version };
}

export function validatePetId(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) || value === "builtin") {
    throw new Error(`Invalid pet id: ${value}`);
  }
  return value;
}

export function validateRawPetArg(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1) throw new Error("--pet requires a non-empty pet id.");
  if (Buffer.byteLength(trimmed, "utf8") > 128 || /[\x00-\x1F\x7F/\\]/.test(trimmed)) {
    throw new Error("--pet value is outside OpenPets CLI bounds.");
  }
  return trimmed;
}

export function createHelpText(): string {
  return `OpenPets MCP server\n\nUsage:\n  open-pets-mcp [--pet <petId>]\n\nOptions:\n  --pet <petId>  Request an installed OpenPets pet for local IPC; remote mode rejects --pet and uses only the default pet.\n  --help         Show this help.\n  --version      Show package version.\n`;
}
