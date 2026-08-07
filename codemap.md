# Repository Atlas: OpenPets 2.0 Workspace

## Project Responsibility

OpenPets is a pnpm/TypeScript monorepo for an Electron desktop companion app plus npm packages that let coding agents control animated desktop pets. The workspace provides a local IPC protocol, MCP server, CLI tooling, and editor-specific integrations for Claude Code, OpenCode, Cursor, and Pi.

## System Entry Points

- `package.json`: workspace scripts for building, checking, testing, desktop packaging, and npm release orchestration.
- `pnpm-workspace.yaml`: workspace membership for `apps/*` and `packages/*`.
- `apps/desktop/src/main.ts`: Electron main-process bootstrap for the desktop pet app.
- `packages/cli/src/index.ts`: command-line setup, pet management, MCP launch, and plugin scaffold/validation entry point.
- `packages/mcp/src/index.ts`: MCP server entry point used by agents.
- `packages/client/src/index.ts`: public IPC client API consumed by integrations and tools.
- `packages/cursor/src/index.ts`: Cursor MCP/rules setup API.
- `packages/pi/src/extension.ts`: Pi coding-agent extension runtime entry point.
- `packages/sdk/src/index.ts`: public SDK v3 type contract for plugin authors.
- `plugins/official/`: first-party SDK v3 plugin product source consumed by desktop dev mode and plugin packaging/catalog release workflows.

## Directory Map

| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `apps/` | Deployable application workspace, currently the tray-first Electron desktop app that consumes shared packages, local IPC, pet windows, and desktop plugin support. | [View Map](apps/codemap.md) |
| `apps/desktop/` | User-facing Electron companion app: tray UX, pet windows, pet installation, plugin automation/runtime, agent setup, update checks, and local IPC server. | [View Map](apps/desktop/codemap.md) |
| `apps/desktop/contracts/` | Desktop public-boundary contract tests for catalog fixtures, local IPC protocol behavior, and plugin manifest schema validation. | [View Map](apps/desktop/contracts/codemap.md) |
| `apps/desktop/src/` | Main-process service layer for app lifecycle, state, tray/windows, IPC routing, lease-managed agent pets, catalog installation, SDK v3 plugin subsystem, i18n, and editor integration. | [View Map](apps/desktop/src/codemap.md) |
| `apps/desktop/src/i18n/` | Desktop host i18n catalogs and localized reaction speech pools. | [View Map](apps/desktop/src/i18n/codemap.md) |
| `apps/desktop/src/i18n/locales/` | Host UI locale dictionaries keyed by BCP-47 locale. | [View Map](apps/desktop/src/i18n/locales/codemap.md) |
| `apps/desktop/src/i18n/reactions/` | Localized pet reaction message pools. | [View Map](apps/desktop/src/i18n/reactions/codemap.md) |
| `apps/desktop/src/renderer/` | Vite renderer workspace for the sandboxed React/Tailwind Control Center bundle. | [View Map](apps/desktop/src/renderer/codemap.md) |
| `apps/desktop/src/renderer/src/` | React/Tailwind Control Center UI for Dashboard, Pets, Integrations, Plugins, and Settings via narrow preload APIs. | [View Map](apps/desktop/src/renderer/src/codemap.md) |
| `apps/desktop/scripts/` | Desktop package cleanup and local release automation scripts. | [View Map](apps/desktop/scripts/codemap.md) |
| `packages/` | Publishable npm package workspace for shared protocol, CLI, MCP, and coding-agent integrations. | [View Map](packages/codemap.md) |
| `packages/agent-events/` | Shared agent speech/event message pools and validation utilities. | [View Map](packages/agent-events/codemap.md) |
| `packages/agent-events/src/` | Source implementation for agent event messages. | [View Map](packages/agent-events/src/codemap.md) |
| `packages/claude/` | Claude Code integration package for hooks, MCP setup, and settings/memory management. | [View Map](packages/claude/codemap.md) |
| `packages/claude/src/` | Claude Code hook handlers, hook settings, CLI integration, and exported setup APIs. | [View Map](packages/claude/src/codemap.md) |
| `packages/client/` | IPC client package that discovers and communicates with the desktop app. | [View Map](packages/client/codemap.md) |
| `packages/client/contracts/` | Client protocol contract tests for discovery, endpoint validation, responses, and pet result parsing. | [View Map](packages/client/contracts/codemap.md) |
| `packages/client/src/` | Protocol definitions, discovery logic, public client API, and smoke entry points. | [View Map](packages/client/src/codemap.md) |
| `packages/cli/` | User-facing OpenPets CLI package. | [View Map](packages/cli/codemap.md) |
| `packages/cli/src/` | CLI command parsing and orchestration across client, Claude, OpenCode, and MCP packages. | [View Map](packages/cli/src/codemap.md) |
| `packages/cursor/` | Cursor editor integration package for managed MCP configuration and project-local rules. | [View Map](packages/cursor/codemap.md) |
| `packages/cursor/src/` | Cursor config/rules planning, status classification, safe writes, previews, and validation checks. | [View Map](packages/cursor/src/codemap.md) |
| `packages/install-pet/` | Standalone installer package for gallery/catalog pets. | [View Map](packages/install-pet/codemap.md) |
| `packages/install-pet/src/` | Pet installation command implementation. | [View Map](packages/install-pet/src/codemap.md) |
| `packages/mcp/` | MCP server package exposing OpenPets tools to compatible agents. | [View Map](packages/mcp/codemap.md) |
| `packages/mcp/src/` | MCP server bootstrap, argument parsing, tool registration, and executable validation helpers. | [View Map](packages/mcp/src/codemap.md) |
| `packages/opencode/` | OpenCode editor integration package with plugin runtime and global setup helpers. | [View Map](packages/opencode/codemap.md) |
| `packages/opencode/src/` | OpenCode plugin, config mutation, previews, status, and project/global setup modules. | [View Map](packages/opencode/src/codemap.md) |
| `packages/pi/` | Pi coding-agent integration package with extension runtime and slash command support. | [View Map](packages/pi/codemap.md) |
| `packages/pi/src/` | Pi extension entry point, event classification, OpenPets command parsing, and validation checks. | [View Map](packages/pi/src/codemap.md) |
| `packages/pet-format/` | Minimal package marker/type interface for OpenPets pet package identity. | [View Map](packages/pet-format/codemap.md) |
| `packages/pet-format/src/` | Marker source export for pet-format package consumers. | [View Map](packages/pet-format/src/codemap.md) |
| `packages/sdk/` | Public plugin SDK v3 type package and deterministic test harness. | [View Map](packages/sdk/codemap.md) |
| `packages/sdk/src/` | SDK type contract, mock runtime, fake clock, and plugin test harness implementation. | [View Map](packages/sdk/src/codemap.md) |
| `plugins/` | Root product source for first-party SDK v3 OpenPets plugins before catalog packaging and R2 upload. | [View Map](plugins/codemap.md) |
| `plugins/official/` | Official reviewed SDK v3 plugins with manifests, entries, assets, locales, and harness tests. | [View Map](plugins/official/codemap.md) |

## Architecture Flow

1. The desktop app starts `apps/desktop/src/main.ts`, initializes app state, creates tray/task windows, and starts a local IPC server.
2. Agent integrations (`packages/claude`, `packages/opencode`, `packages/cursor`, `packages/pi`, and `packages/mcp`) configure agents or emit pet commands through `@open-pets/client`.
3. The client discovers Unix sockets, Windows named pipes, or TCP endpoints for WSL cross-platform access.
4. The desktop IPC server routes commands through lease-managed controllers so default and agent pets can coexist safely.
5. The plugin service loads approved catalog or local `openpets.plugin.json` manifests, persists plugin state/config, schedules declarative timers, and bridges SDK v3 calls through permission-checked host modules for UI, audio, events, storage, AI, OAuth, voice, panels, and pet control. Voice input remains one-shot, visibly indicated, cancellable, timeout-bounded, and never ambient.
6. Pet windows render reaction-driven animations, localized speech, host-rendered bubbles/alerts/HUDs, and status reactions using desktop state plus reaction mapping metadata.
7. Pet assets are resolved from built-in assets, locally developed Codex pets, or remotely downloaded catalog ZIPs.
8. Workspace packages share TypeScript/ESM build conventions and are wired together through pnpm `workspace:*` dependencies.

## Working Notes

- For repository-level orientation, start here, then open the specific folder codemap before editing.
- Contract validation files named `check-*.ts` are intentionally excluded from detailed codemap coverage except where they define package contract boundaries.
- Build artifacts, dependencies, tests, documentation, and binary assets are excluded from codemap state.
- `web/` is intentionally excluded from this codemap run; plugin source coverage is under `plugins/` only.
