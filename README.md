<p align="center">
  <img src="assets/openpets.png" alt="OpenPets - pixel art desktop pets for coding agents" width="100%" />
</p>

<p align="center">
  <strong>A tiny desktop pet for coding agents.</strong>
</p>

<p align="center">
  See agent progress, tool use, test runs, and coding state as a playful desktop companion.
</p>

---

## Star OpenPets

Here is an extra GIF of me starring my own repo to encourage you to do the same. If OpenPets makes your coding setup a little more fun, please give the repo a star.

<p align="center">
  <img src="assets/star-repo.gif" alt="Starring the OpenPets repository" width="100%" />
</p>

## What is OpenPets?

OpenPets is a tray-first desktop companion app for AI coding agents.

- **Desktop companion** - a small pet that reacts while agents think, edit, test, wait for approval, finish, or hit an error.
- **Agent integrations** - first-class setup for Claude Code and OpenCode, including MCP tools, instructions, and automatic hooks/plugins.
- **MCP ready** - any MCP-capable agent can send short safe speech bubbles and reactions through the OpenPets MCP server.
- **Pet-pack friendly** - loads installed animated pet packs and can route a selected agent/project to its own pet window.
- **Privacy-conscious by design** - automatic hook speech is static and local; prompts, code, logs, command output, URLs, paths, and secrets are not shown in bubbles.

## Manage your pets

Browse installed pets, preview their animations, and choose which companion should follow each coding agent from the OpenPets desktop app.

<p align="center">
  <img src="assets/manage-pets.png" alt="Managing pets in the OpenPets desktop app" width="100%" />
</p>

## Quick start

Install the desktop app, then connect your coding agent.

### 1. Install OpenPets Desktop

Download the latest app from [OpenPets Releases](https://github.com/alvinunreal/openpets/releases/latest):

- **macOS Apple Silicon**: `OpenPets-*-mac-arm64.dmg`
- **macOS Intel**: `OpenPets-*-mac-x64.dmg`
- **Windows**: `OpenPets-*-win-x64-setup.exe`
- **Linux**: `OpenPets-*-linux-x86_64.AppImage`

Launch OpenPets. You should see the desktop pet and the OpenPets tray/menu-bar icon.

> Current builds may be unsigned. macOS or Windows may show a security warning the first time you open the app.

If macOS says the app is damaged or should be moved to Trash, remove the quarantine flag and open it again:

```bash
xattr -dr com.apple.quarantine /Applications/OpenPets.app
open /Applications/OpenPets.app
```

### 2. Connect your agent

Use the desktop **Integrations** screen for global setup when available:

- **Claude Code** - installs OpenPets MCP, Claude memory instructions, and optional Claude hooks.
- **OpenCode** - installs OpenPets MCP, an OpenCode instruction file, and the `@open-pets/opencode` plugin.

<p align="center">
  <img src="assets/integrations.png" alt="OpenPets desktop integrations screen" width="100%" />
</p>

For project-local setup, run the CLI from the project you want to configure:

```bash
npx -y @open-pets/cli configure --agent claude --pet <petId>
npx -y @open-pets/cli configure --agent opencode --pet <petId>
npx -y @open-pets/cli configure --agent codex --pet <petId>
```

Project-local setup can create project files such as `.claude/settings.local.json` or `.opencode/opencode.jsonc`. Review them before committing because they may include the selected pet id.

## Agent integrations

OpenPets integrations have three layers:

1. **MCP tools** for explicit agent actions.
2. **Agent instructions** so agents know when to use those tools.
3. **Hooks/plugins** for automatic decorative reactions during normal agent work.

### Claude Code

Claude Code integration supports:

- `openpets` MCP setup via Claude Code.
- Managed Claude memory instructions in `~/.claude/CLAUDE.md` and `~/.claude/openpets.md`.
- Managed Claude hooks in `~/.claude/settings.json`.
- Project-local setup through `openpets configure --agent claude --pet <petId>`.

Typical global MCP command shape:

```bash
claude mcp add --scope user openpets -- npx -y @open-pets/mcp
```

With a selected pet:

```bash
claude mcp add --scope user openpets -- npx -y @open-pets/mcp --pet <petId>
```

<p align="center">
  <img src="assets/claude.png" alt="OpenPets reacting to Claude Code" width="100%" />
</p>

See [`docs/claude-integration.md`](docs/claude-integration.md) for the full file layout, hook mapping, project-local behavior, and safety rules.

### OpenCode

OpenCode integration supports:

- An MCP entry using `@open-pets/cli mcp`.
- A managed `openpets.md` instruction file.
- The `@open-pets/opencode` plugin for automatic reactions.
- Global desktop setup and project-local `.opencode` setup.

Project-local setup:

```bash
npx -y @open-pets/cli configure --agent opencode --pet <petId>
```

See [`docs/opencode.md`](docs/opencode.md) for global config selection, plugin behavior, project-local setup, and safety rules.


### Codex

Codex integration supports:

- Project-local MCP setup through `openpets configure --agent codex --pet <petId>`.
- Automatic creation/update of `.codex/config.toml` with an `openpets` MCP server entry.

Project-local setup:

```bash
npx -y @open-pets/cli configure --agent codex --pet <petId>
```

This writes a project-scoped Codex MCP launcher:

```toml
[mcp_servers.openpets]
command = "npx"
args = ["-y", "@open-pets/cli@<version>", "mcp", "--pet", "<petId>"]
```

Restart Codex in the project after setup so the MCP tools load.

### Generic MCP clients

Any MCP-capable editor or coding agent can talk to OpenPets through the MCP server while the desktop app is running.

```json
{
  "mcpServers": {
    "openpets": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@open-pets/mcp"]
    }
  }
}
```

To target a specific installed non-default pet:

```json
{
  "mcpServers": {
    "openpets": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@open-pets/mcp", "--pet", "<petId>"]
    }
  }
}
```

Available MCP tools:

- `openpets_status` - check whether OpenPets is reachable and which pet is targeted.
- `openpets_react` - set a short reaction on the target pet.
- `openpets_say` - show a short safe speech bubble, optionally with a reaction.

`openpets_say` messages must be short, single-line, and must not look like code, logs, secrets, URLs, or file paths.

## How it works

```text
Claude Code / OpenCode / MCP client
  -> @open-pets/mcp, @open-pets/cli mcp, @open-pets/claude hook, or @open-pets/opencode plugin
  -> @open-pets/client
  -> OpenPets desktop local IPC discovery file
  -> OpenPets desktop IPC socket/pipe
  -> default pet or selected agent pet window
```

The desktop app writes a local discovery file containing an IPC endpoint and a per-run token. Clients must send that token with every request.

When an integration is configured with `--pet <petId>`, OpenPets asks the desktop app for a short-lived lease. Valid installed non-default pets open as explicit agent pet windows. Missing, invalid, broken, built-in, or default pet requests fall back to the desktop default pet.

## Reactions and speech

Automatic hooks are decorative and best-effort. They do not approve, deny, block, or change agent behavior.

Common reaction mapping:

| Agent activity | Reaction |
| --- | --- |
| Prompt/chat starts | `thinking` |
| File edit/write/patch | `editing` |
| Test-like shell command | `testing` |
| Permission request | `waiting` |
| Successful idle/stop | `success` |
| Session/error stop | `error` |

Generic shell activity is intentionally quiet by default. Hook/plugin speech is throttled and selected from local static message pools such as `Approval needed` or `Something failed`.

## Development

### Requirements

- Node.js 20+
- pnpm 11+
- TypeScript

No Bun runtime is required for development.

### Install

```bash
pnpm install
```

### Run the desktop app

```bash
pnpm dev:desktop
```

Equivalent package command:

```bash
pnpm --filter @open-pets/desktop dev
```

### Checks

```bash
pnpm check
pnpm typecheck
pnpm build
pnpm test
```

OpenPets currently uses lightweight Node contract checks instead of a full test framework. See [`docs/testing.md`](docs/testing.md).

### Package desktop builds

```bash
pnpm package:desktop:dir
pnpm package:desktop
```

Release process details live in [`docs/release.md`](docs/release.md).

## Workspace layout

```text
apps/desktop              Electron desktop app
packages/client           @open-pets/client, local IPC client
packages/mcp              @open-pets/mcp, MCP stdio server
packages/claude           @open-pets/claude, Claude command and hook helpers
packages/opencode         @open-pets/opencode, OpenCode config and plugin integration
packages/agent-events     Shared safe agent event speech helpers
packages/cli              @open-pets/cli, user-run CLI and MCP/hook entrypoints
packages/pet-format       @open-pets/pet-format, pet/catalog format types
docs/                     Documentation
```

## Documentation

- [`docs/claude-integration.md`](docs/claude-integration.md) - Claude Code setup, MCP, memory, hooks, and safety.
- [`docs/opencode.md`](docs/opencode.md) - OpenCode global/project setup, plugin behavior, and safety.
- [`docs/codex-integration.md`](docs/codex-integration.md) - Codex project setup and validation checklist.
- [`docs/testing.md`](docs/testing.md) - test/check strategy.
- [`docs/release.md`](docs/release.md) - desktop release process.
- [`docs/workflow.md`](docs/workflow.md) - project workflow notes.

## Safety and privacy notes

- OpenPets local IPC is local-only and protected by a per-run token.
- Hook/plugin errors are swallowed unless debug logging is enabled.
- Automatic speech is static and local; it does not include model-generated prompt text.
- Tool inputs and command text are used only for coarse reaction classification.
- Managed setup preserves unrelated user config and removes only OpenPets-managed entries.
- Speech validation rejects code-like, secret-like, URL-like, path-like, or multiline messages.
