# Repository Analysis (OpenPets)

Date: 2026-05-11

## Product Context (from README)

OpenPets is a tray-first desktop companion for coding agents. It shows a reactive animated pet that reflects agent state (thinking, editing, testing, waiting, success, error), supports safe short speech bubbles, and integrates with Claude Code, OpenCode, and generic MCP clients. Privacy is core: automatic hook/plugin speech is static/local and intentionally excludes prompts, code, logs, paths, URLs, and secrets.

## What the Repository Is Optimized For

This monorepo is optimized for **agent-to-desktop signaling** rather than autonomous workflows:

- Agent tools and hooks emit coarse-grained events.
- Events are translated into reactions/speech over a local IPC contract.
- The Electron runtime renders default or selected pet windows.
- Setup flows focus on global and project-local integration ergonomics.

## Top-Level Architecture

- **Desktop runtime (`apps/desktop`)**
  - Electron main process, tray/menu UX, pet windows, onboarding/settings, pet management, and local IPC server.
- **Core client/protocol (`packages/client`)**
  - Shared contracts plus discovery/transport client used by all integrations.
- **Integration surfaces**
  - `packages/mcp`: MCP stdio server exposing OpenPets tools.
  - `packages/cli`: configure/setup flows plus MCP entrypoint for user workflows.
  - `packages/claude`: Claude Code MCP + memory + hook management.
  - `packages/opencode`: OpenCode instruction/config/plugin integration.
- **Shared domain packages**
  - `packages/agent-events`: static safe speech/event utilities.
  - `packages/install-pet`: pet install command implementation.
  - `packages/pet-format`: pet package format marker/types.

## Runtime Control/Data Flow

1. Desktop app starts and writes local IPC discovery metadata (endpoint + run token).
2. External integrations (MCP server, CLI, Claude hooks, OpenCode plugin) call `@open-pets/client`.
3. Client discovers endpoint and sends token-authenticated local IPC requests.
4. Desktop controllers resolve target pet (default or selected non-default via lease).
5. Pet window applies reaction/speech updates with safety validation and fallback behavior.

## Integration Model (Important for Contributors)

OpenPets integrations are intentionally layered:

1. **MCP tools** for explicit calls (`openpets_status`, `openpets_react`, `openpets_say`).
2. **Instruction files** that teach agents when/how to use tools safely.
3. **Hooks/plugins** that provide decorative automatic reactions during normal coding.

This layering means behavior changes often span multiple packages and should be validated end-to-end (desktop + integration + client contract).

## Workspace & Build Conventions

- Monorepo managed with pnpm workspaces (`apps/*`, `packages/*`).
- TypeScript + ESM across packages, Node 20+ expectation.
- Root scripts orchestrate recursive checks/build/test (`pnpm check`, `pnpm typecheck`, `pnpm build`, `pnpm test`).
- Repo uses lightweight contract checks (`check-*.ts`) in place of a full centralized test framework.

## Strengths

- Strong package boundaries between runtime, protocol, and integrations.
- Good onboarding aids via codemap files and explicit docs per integration.
- Privacy/safety constraints are first-class in product behavior, not afterthoughts.
- Local IPC token model provides practical protection for desktop command routing.

## Risks / Attention Areas

- **Single-runtime dependency**: all integrations depend on desktop availability and healthy discovery metadata.
- **Cross-package compatibility drift**: MCP/CLI/hooks/plugins can diverge if contract evolution is not tightly versioned.
- **Test surface growth**: each new integration feature multiplies end-to-end scenarios.
- **Lease edge cases**: selected-pet fallback behavior needs robust regression coverage.

## Recommended Next Deep Dives

1. **IPC contract/version policy**: document strict compatibility guarantees and rollout strategy.
2. **Lease lifecycle validation**: disconnect/reconnect, stale lease, and fallback paths.
3. **Integration regression matrix**: explicit smoke suite across Claude/OpenCode/generic MCP.
4. **Release hardening**: verify packaging + npm release dry-runs and rollback playbooks.
