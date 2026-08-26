# Package: @open-pets/cli

## Responsibility

Main developer CLI tool for OpenPets agent configuration and plugin/pet asset management. Provides commands to configure local projects for integrations (Claude, OpenCode, Cursor), ensure the global OpenClaw native plugin is installed and enabled, manage/install pets, execute Claude hooks, spawn the local MCP server wrapper, and validate or scaffold custom plugins.

## Design/Patterns

**Command Route Processor** (`src/index.ts`):
- Handles command dispatching from CLI inputs:
  - `install <pet-id>`: Downloads/installs a pet via client.
  - `configure`: Configures code editors (Claude, OpenCode, Cursor) or ensures global OpenClaw setup.
  - `status`: Connects to app IPC and prints JSON status.
  - `pets`: Lists installed pets.
  - `react <reaction>`: Sends reaction message to active pet.
  - `say <message>`: Displays speech on active pet.
  - `mcp`: Launches standard Model Context Protocol (MCP) server daemon.
  - `hook`: Runs Claude Code lifecycle hooks.
  - `plugin validate <dir>`: Validates a local plugin's manifest, permissions, config, assets, panels, and referenced files before install/release.
  - `plugin new <name> --template <name>`: Scaffolds a new SDK v3 plugin package using predefined templates.

**Project Scaffolding** (`src/plugin-templates.ts`):
- Ships standard SDK v3 plugin starter templates (`blank`, `reminder`, `ambient`, `ai-chat`, `tamagotchi`, `calendar`) containing manifestVersion 3 definitions, code entries, test harness files, README content, and optional `locales/en.json` dictionaries.
- Templates exercise current SuperPlugins surfaces such as `ctx.ui.alert`, dynamic speech, events, schedules, storage, commands, AI, assets, and Tamagotchi-style state loops.

**Plugin Validator** (`src/plugin-validate.ts`):
- Checks plugin directories against manifest requirements, v2/v3 permission lists, SDK version compatibility, config field types (`date`, `secret`, `sound` for v3), network hosts, asset formats/size caps, entry files, and HTML panels.

**Editor Configuration Actions**:
- **Claude**: Appends OpenPets hooks command hooks to global/project setting files and configures Claude's MCP configuration.
- **OpenCode**: Modifies local instruction entries and links client plugins via `@open-pets/opencode`.
- **Cursor**: Generates MCP definitions in `.cursor/mcp.json` and updates MDC rule files (`.cursor/rules/openpets.mdc`).
- **OpenClaw**: Runs the global native plugin ensure flow through `@open-pets/openclaw/management`; it has no project, pet, force, or local-dev mode.

**Safety Constraints**:
- Enforces strict path checks preventing path traversals or symlink escapes on project folders.
- Writes configurations atomically using a temporary-write-and-rename pattern, making backups before committing changes.

## Data & Control Flow

```text
CLI command input (e.g. openpets configure --agent claude)
    ↓
resolveProjectDir() → Enforce safe paths
    ↓
Check editor tool presence (e.g., claude CLI or Cursor settings)
    ↓
Acquire active pet selection/lease via IPC
    ↓
Perform atomic update of config files & local hooks
```

Project setup uses the flow above. OpenClaw setup is global and bypasses project
directory resolution and pet selection; its separate flow is shown below.

```text
openpets configure --agent openclaw
    ↓
Discover OpenClaw version + cold plugin list/inspect inventory
    ↓
@open-pets/openclaw/management plans install/update + enable
    ↓
Run each `openclaw plugins ...` command and refresh status
    ↓
Report success only when the owned package/version is enabled
```

```text
CLI command plugin validate <dir>
    ↓
Checks existence of openpets.plugin.json
    ↓
Validates manifest fields (id, version, sdkVersion, entry)
    ↓
Validates permissions, hosts list, config schema, assets, and panels
```

```text
CLI command plugin new <name> [--template template] [--dir output]
    ↓
Normalizes plugin id/name and selects template
    ↓
Writes manifest, index.js, test.js, README, and optional locales/en.json
    ↓
Generated code targets @open-pets/plugin-sdk/testing for local verification
```

## Integration Points

- **Dependencies**: Depends on `@open-pets/client` for IPC communications, `@open-pets/claude` for Claude hooks/MCP configuration, `@open-pets/mcp` for spawning the MCP transport server, `@open-pets/opencode` for OpenCode extensions, `@open-pets/cursor` for Cursor Rules/MCP config settings, and `@open-pets/openclaw` for OpenClaw command/status planning.
- **Plugin SDK**: Scaffolds plugin code that references `@open-pets/plugin-sdk` and tests with `@open-pets/plugin-sdk/testing`.
- **External Dependencies**: Invokes editor/OpenClaw command lines: `claude` (Claude Code settings integration), `openclaw` (native plugin lifecycle), and `npx` (optional package runtime launcher).
- **Detailed source map**: [src/codemap.md](src/codemap.md)
