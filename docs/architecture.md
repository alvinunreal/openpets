# Architecture

OpenPets is a pnpm + TypeScript monorepo for an Electron desktop companion app
and a set of npm packages that let coding agents drive animated desktop pets.
This doc is the one-page mental model: what runs where, how a request travels
end to end, and the vocabulary used throughout the rest of the docs.

## The product in one sentence

A small animated pet lives on your desktop and reacts to what your coding agent
is doing — thinking, editing, waiting for permission, succeeding, failing — and
can be extended with companion plugins, while pets themselves are downloadable
from a public catalog.

## Runtime topology

There are three runtime worlds. Keep them distinct in your head.

1. **The desktop app** (`apps/desktop/`) — an Electron process tree. The main
   process owns state, windows, the tray, the pet windows, the plugin runtime,
   and a **local IPC server**. This is the only long-lived process.
2. **Agent-side integrations** (`packages/*`) — short-lived code that runs
   inside or alongside a coding agent (Claude Code hooks, the MCP server,
   OpenCode plugin, Cursor config, Pi extension, the CLI). They translate agent
   activity into pet commands and send them over local IPC.
3. **The public web origin** (`openpets.dev`, source in `web/`) — static
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

## The packages, and what each is for

| Package | Role | Doc |
|---------|------|-----|
| `@open-pets/client` | The IPC client every integration uses to talk to the app | [ipc.md](ipc.md) |
| `@open-pets/cli` | User-facing CLI: configure agents, manage pets, run MCP, scaffold/validate plugins | [agent-integrations.md](agent-integrations.md), [development.md](development.md) |
| `@open-pets/mcp` | Stdio MCP server exposing `openpets_status` / `react` / `say` to MCP agents | [agent-integrations.md](agent-integrations.md) |
| `@open-pets/claude` | Claude Code hooks + MCP/settings/memory management | [agent-integrations.md](agent-integrations.md) |
| `@open-pets/opencode` | OpenCode plugin runtime + config management | [agent-integrations.md](agent-integrations.md) |
| `@open-pets/cursor` | Cursor MCP config + project rules management | [agent-integrations.md](agent-integrations.md) |
| `@open-pets/pi` | Pi coding-agent extension + `/openpets` commands | [agent-integrations.md](agent-integrations.md) |
| `@open-pets/agent-events` | Shared, validated speech pools for agent feedback | [agent-integrations.md](agent-integrations.md) |
| `@open-pets/plugin-sdk` | Public SDK v3 type contract + deterministic test harness | [sdk.md](sdk.md) |
| `install-pet` | Standalone pet installer (works with or without the running app) | [pets.md](pets.md) |
| `pet-format` | Tiny marker/identity type for pet packages | — |

The dependency spine: every integration depends on `@open-pets/client`; the
`cli` composes `claude`, `opencode`, `cursor`, and `mcp`; `claude`/`opencode`/`pi`
depend on `agent-events` for safe speech.

## End-to-end flows

These are the flows worth holding in memory. Each links to the doc that details it.

- **Agent reaction → visible pet.** Agent activity is classified into a reaction
  category, sent via the client over IPC, the lease manager routes it to a pet
  window, and the window plays the mapped animation with localized speech.
  See [ipc.md](ipc.md) and [pets.md](pets.md).
- **Speech bubble → optional voice output.** After a plain-text transient bubble
  is actually presented, the pet-window layer may route that text through the
  host-owned voice platform when the user has enabled **Read speech bubbles
  aloud**. The platform resolves global/per-pet provider and voice settings,
  applies voice/provider fallbacks, and uses a voice-only playback channel.
  Refreshes are deduplicated, quiet hours mute narration, and TTS failures never
  affect the visual bubble.
- **Companion turn → pet response.** A typed message and a final push-to-talk
  transcript both enter the main-process `CompanionOrchestrator`. It builds the
  same bounded context from the selected pet's personality, the explicit user
  profile, local time/activity hints, recent pet-scoped memory, and consented
  plugin facts. The selected target is either a cancellable Codex CLI session or
  the configured host-AI provider. Only a response actually displayed in the
  pet bubble is recorded; optional speech uses the same voice-output service.
  Changing targets does not change the pet's personality or OpenPets memory.
- **Proactive opportunity → restrained check-in.** A host-owned scheduler
  evaluates time-of-day, user goals, and consented plugin opportunities for the
  visible, unpaused default pet. Quiet hours, active listening/thinking/speech,
  dedupe, daily caps, and the Rarely/Sometimes/Often spacing policy can suppress
  any candidate. Plugins contribute expiring facts or opportunities only; the
  host decides whether to act and the selected provider writes original pet
  wording. The same time state can produce a once-per-day-part reaction hint
  without creating a spoken check-in. Wake-word activation remains disabled
  until an approved local runtime/model passes the packaging gate.
- **Installing a pet.** The app fetches catalog v3 (paginated, with a v2/fixture
  fallback), downloads the pet ZIP from `zip.openpets.dev`, validates and
  extracts it, and records it in app state. See [catalog.md](catalog.md) and
  [pets.md](pets.md).
- **Running a plugin.** The plugin service loads an approved manifest (catalog
  or local), the runtime starts a sandboxed JS host, and the SDK bridge applies
  permission-checked calls to pet/schedule/storage/UI/etc. See [plugins.md](plugins.md)
  and [sdk.md](sdk.md).
- **Configuring an agent.** The CLI or Control Center detects the agent, writes
  MCP config + hooks/rules atomically, and installs a memory/instructions file.
  See [agent-integrations.md](agent-integrations.md).
- **Publishing content.** Pets and plugins are packaged into versioned catalogs
  and ZIPs, validated, and uploaded to R2 behind `openpets.dev`. See
  [catalog.md](catalog.md) and [testing-and-validation.md](testing-and-validation.md).

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
  strict CSP; plugins run in a permission-gated sandbox; IPC over TCP is
  restricted to private/loopback addresses.
- **Companion data is consented and layered.** Core settings, pet personality,
  explicit profile fields, and roughly 24 hours of recent conversation are
  OpenPets-owned. Plugin context, sensitive plugin context, screen awareness,
  and wake listening are separate gates. Screen context is reserved and
  collects nothing in the current build; wake remains packaging-gated.
- **Providers do not own identity.** Codex CLI and host AI receive the same
  bounded host-built context. They do not own the pet personality, user profile,
  recent-memory retention, plugin consent, or proactive-delivery policy.

## Glossary

- **Default pet** — the always-on pet shown when enabled; persistent, not
  lease-bound.
- **Agent pet** — a pet shown on explicit agent request, routed by a lease and
  closed when the last lease for it is released.
- **Lease** — a short-lived (15s TTL) claim with heartbeat renewal that routes
  agent commands to a specific pet and governs agent-pet visibility. See
  [ipc.md](ipc.md).
- **Reaction** — a categorical pet state (e.g. thinking, editing, waiting,
  success, error) that maps to a sprite animation and a speech pool. See
  [pets.md](pets.md).
- **Reaction → animation mapping** — user-configurable table from reaction types
  to sprite animation states.
- **Spritesheet** — the `spritesheet.webp` grid of frames a pet animates from.
- **Codex pet** — a locally-developed pet imported from `~/.codex/pets/`.
- **Control Center** — the React/Tailwind renderer UI (Dashboard, Pets,
  Integrations, Plugins, Settings) opened from the tray.
- **SDK v3 / manifestVersion 3** — the current plugin contract. See [sdk.md](sdk.md)
  and [plugins.md](plugins.md).
- **SuperPlugins** — the companion-first plugin product direction. See
  [superplugins.md](superplugins.md).
- **Companion Conversations** — the opt-in host feature that gives each
  installed pet a personality, ordinary typed/PTT conversation, bounded recent
  memory, and restrained check-ins. It is distinct from coding-agent reactions.
- **Host AI** — the app-owned Anthropic/OpenAI/Ollama-compatible gateway shared
  by Companion, transcription-compatible voice paths, and the plugin AI
  compatibility surface. Settings and credentials remain host-owned.
- **Companion contribution** — an expiring plugin-supplied fact or proactive
  opportunity. It is untrusted context, never final pet wording, provider
  selection, speech authority, or core memory.
- **Catalog** — a versioned JSON index of installable pets or plugins served
  from `openpets.dev`. See [catalog.md](catalog.md).
</content>
</invoke>
