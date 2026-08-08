---
description: Understand the OpenPets desktop app, companion pets, plugin host, catalogs, SDK packages, and local agent integrations as one system.
---

# Architecture

OpenPets is a pnpm + TypeScript monorepo for an Electron desktop companion app
and a set of npm packages that let coding agents drive animated desktop pets.
This doc is the one-page mental model: what runs where, how a request travels
end to end, and the vocabulary used throughout the rest of the docs.

## The product in one sentence

A small animated pet lives on your desktop and reacts to what your coding agent
is doing - thinking, editing, waiting for permission, succeeding, failing - and
can be extended with companion plugins, while pets themselves are downloadable
from a public catalog.

## Runtime topology

There are three runtime worlds. Keep them distinct in your head.

1. **The desktop app** (`apps/desktop/`) - an Electron process tree. The main
   process owns state, windows, the tray, the pet windows, the plugin runtime,
   and a **local IPC server**, plus a separate opt-in remote-control listener.
   This is the only long-lived process; remote control is disabled by default.
2. **Agent-side integrations** (`packages/*`) - short-lived code that runs
   inside or alongside a coding agent (Claude Code hooks, the MCP server,
   OpenCode plugin, Cursor config, Pi extension, the CLI). They translate agent
   activity into pet commands and send them over local IPC unless an explicit
   remote endpoint/token configuration selects the separate remote protocol.
3. **The public web origin** (`openpets.dev`, source in `web/`) - static
   catalogs and asset hosting. The app fetches pet/plugin catalogs and downloads
   ZIPs from here. Only the *data* side of `web/` (catalogs, ZIP hosting, pet
   metadata) is in scope for these docs; the marketing site/frontend is not.

```
coding agent  ──(hook/MCP/plugin event)──▶  @open-pets/client
                                                  │  local IPC (socket/pipe/TCP)
                                                  ▼
                                         desktop app (main process)
                                          ├─ lease manager → pet windows
                                          ├─ app state (JSON)
                                          ├─ plugin runtime + SDK bridge
                                          └─ catalog/install
                                                  │  HTTPS
                                                  ▼
                                         openpets.dev (catalogs, ZIPs on R2)
```

An explicitly configured remote agent uses a separate path: private IPv4
endpoint plus a paired token → `@open-pets/client` → the remote-control service
→ the default pet only. It never reads local discovery, exposes the local IPC
router, or participates in LAN pet presence or leases. The v1 transport is raw
unencrypted TCP and is intended only for a trusted private network or an
encrypted overlay with its own ACLs; CGNAT addressing alone is not encryption.

## The packages, and what each is for

| Package | Role | Doc |
|---------|------|-----|
| `@open-pets/client` | The IPC client every integration uses to talk to the app | [IPC and remote control](/ipc) |
| `@open-pets/cli` | User-facing CLI: configure agents, manage pets, run MCP, scaffold/validate plugins | [Agent integrations](/agent-integrations), [Development](/development) |
| `@open-pets/mcp` | Stdio MCP server exposing `openpets_status` / `react` / `say` to MCP agents | [Agent integrations](/agent-integrations) |
| `@open-pets/claude` | Claude Code hooks + MCP/settings/memory management | [Agent integrations](/agent-integrations) |
| `@open-pets/opencode` | OpenCode plugin runtime + config management | [Agent integrations](/agent-integrations) |
| `@open-pets/cursor` | Cursor MCP config + project rules management | [Agent integrations](/agent-integrations) |
| `@open-pets/pi` | Pi coding-agent extension + `/openpets` commands | [Agent integrations](/agent-integrations) |
| `@open-pets/agent-events` | Shared, validated speech pools for agent feedback | [Agent integrations](/agent-integrations) |
| `@open-pets/plugin-sdk` | Public SDK v3 type contract + deterministic test harness | [Plugin SDK v3](/sdk) |
| `install-pet` | Standalone pet installer (works with or without the running app) | [Pets](/pets) |
| `pet-format` | Tiny marker/identity type for pet packages | - |

The dependency spine: every integration depends on `@open-pets/client`; the
`cli` composes `claude`, `opencode`, `cursor`, and `mcp`; `claude`/`opencode`/`pi`
depend on `agent-events` for safe speech.

## End-to-end flows

These are the flows worth holding in memory. Each links to the doc that details it.

- **Agent reaction → visible pet.** Agent activity is classified into a reaction
  category, sent via the client over IPC, the lease manager routes it to a pet
  window, and the window plays the mapped animation with localized speech.
  See [IPC and remote control](/ipc) and [Pets](/pets).
- **Remote agent reaction → default pet.** A paired remote client uses the
  separate versioned protocol. Scope checks, bounded payloads, timeouts, and
  address rate limiting happen before the default-pet adapter; no lease or
  arbitrary target is involved. See [IPC and remote control](/ipc).
- **Installing a pet.** The app fetches catalog v3 (paginated, with a v2/fixture
  fallback), downloads the pet ZIP from `zip.openpets.dev`, validates and
  extracts it, and records it in app state. See [Catalogs](/catalog) and
  [Pets](/pets).
- **Running a plugin.** The plugin service loads an approved manifest (catalog
  or local), the runtime starts a sandboxed JS host, and the SDK bridge applies
  permission-checked calls to pet/schedule/storage/UI/etc. See [Plugin platform](/plugins)
  and [Plugin SDK v3](/sdk).
- **Listening through a plugin.** `voice.listen()` performs one bounded capture in
  a host-owned temporary session, shows the privacy indicator only after microphone
  acquisition succeeds, transcribes through the configured provider, and cleans up
  on success, cancellation, timeout, teardown, or shutdown. It is never ambient.
- **Configuring an agent.** The CLI or Control Center detects the agent, writes
  MCP config + hooks/rules atomically, and installs a memory/instructions file.
  See [Agent integrations](/agent-integrations).
- **Publishing content.** Pets and plugins are packaged into versioned catalogs
  and ZIPs, validated, and uploaded to R2 behind `openpets.dev`. See
  [Catalogs](/catalog) and [Testing and validation](/testing-and-validation).

## Cross-cutting invariants

These hold everywhere; the rest of the docs assume them.

- **Forward-only product direction.** Move the current app forward. Do not keep
  legacy compat code in current runtime paths. Old released apps must not break
  catastrophically on versioned data, but the current app carries no legacy
  bloat. (From `AGENTS.md`.)
- **Catalog v3 is the source of truth** for pets; catalog v2 is legacy/fallback
  only. Plugin catalog v2 is active; v1 is an empty compatibility shim.
- **Validate at every boundary.** Catalog entries, ZIP contents, pet metadata,
  IPC params, and plugin manifests are all strictly validated before use.
- **Atomic, safe I/O.** All persisted state uses temp-write + rename; all path
  handling rejects traversal and symlink escapes.
- **Least privilege.** Renderers are sandboxed with narrow preload bridges and a
  strict CSP; plugins run in a permission-gated sandbox; local IPC over TCP is
  restricted to private/loopback addresses; remote control is separate,
  disabled-by-default, explicitly bound, authenticated, and scope-limited.
- **Voice is bounded and visible.** Listening is one-shot, one-at-a-time,
  explicitly cancellable, visibly indicated while a media track is live, and
  bounded by separate microphone-acquisition and transcription timeouts.

## Glossary

- **Default pet** - the always-on pet shown when enabled; persistent, not
  lease-bound.
- **Agent pet** - a pet shown on explicit agent request, routed by a lease and
  closed when the last lease for it is released.
- **Lease** - a short-lived (15s TTL) claim with heartbeat renewal that routes
  agent commands to a specific pet and governs agent-pet visibility. See
  [IPC and remote control](/ipc).
- **Reaction** - a categorical pet state (e.g. thinking, editing, waiting,
  success, error) that maps to a sprite animation and a speech pool. See
  [Pets](/pets).
- **Reaction → animation mapping** - user-configurable table from reaction types
  to sprite animation states.
- **Spritesheet** - the `spritesheet.webp` grid of frames a pet animates from.
- **Codex pet** - a locally-developed pet imported from `~/.codex/pets/`.
- **Control Center** - the React/Tailwind renderer UI (Dashboard, Pets,
  Integrations, Plugins, Settings) opened from the tray.
- **SDK v3 / manifestVersion 3** - the current plugin contract. See [Plugin SDK v3](/sdk)
  and [Plugin platform](/plugins).
- **Official plugins** - the reviewed companion plugin lineup and bundling
  rules. See [Official plugins](/official-plugins).
- **Catalog** - a versioned JSON index of installable pets or plugins served
  from `openpets.dev`. See [Catalogs](/catalog).
