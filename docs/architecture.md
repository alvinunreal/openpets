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
   OpenCode plugin, Cursor config, Pi extension, the DSH Cordis bundle, the
   CLI). They translate agent activity into pet commands and send them over
   local IPC unless an explicit remote endpoint/token configuration selects the
   separate remote protocol.
   `@open-pets/dsh` is the strict local-only v1 exception: it always uses local
   IPC and the default pet and ignores all remote configuration.
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

The host provider service owns exactly three independent selections: one text
profile, one STT profile, and one TTS profile. Secret credential values are
resolved only from `PluginSecretsStore`; optional static provider header values
are persisted in the local provider-profile settings, while Control Center
snapshots expose header names only. Generic
OpenAI-compatible text covers cloud gateways and Ollama/LM Studio/vLLM, while
native Anthropic, MiniMax speech, ElevenLabs speech, system TTS, and explicit
Whisper-compatible transcription retain their distinct wire contracts.

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
| `@open-pets/dsh` | Strict local-only v1 Cordis bundle for DSH lifecycle reactions | [Agent integrations](/agent-integrations) |
| `@open-pets/plugin-sdk` | Public SDK v3 type contract + deterministic test harness | [Plugin SDK v3](/sdk) |
| `install-pet` | Standalone pet installer (works with or without the running app) | [Pets](/pets) |
| `pet-format` | Tiny marker/identity type for pet packages | - |

The dependency spine: every integration, including `@open-pets/dsh`, depends on
`@open-pets/client`; the `cli` composes `claude`, `opencode`, `cursor`, and
`mcp`; `claude`/`opencode`/`pi`/`dsh` use curated speech for safe automatic
feedback.
`@open-pets/dsh` is strict local-only v1: it always uses local IPC and the
default pet and ignores remote configuration.

## End-to-end flows

### Host Pet Assistant loop (#138)

After `PluginService.start()` resolves, the desktop constructs one canonical
in-memory Pet Assistant service. Each turn reads the current host text-provider
provider operation and the current host-owned personality profile, discovers enabled
generation-pinned capabilities, and routes validated tool calls back through
`PluginService`. Provider codecs and the lifecycle enforce bounded context,
payloads, results, timeouts, cancellation, and final output. Assistant requests
do not use the plugin `ctx.ai` gateway.

The host composes each request in a fixed order: immutable host rules, optional
curated context, a serialized owner-authored personality data block, recent
bounded conversation messages, and the current provider-neutral capability
definitions/results. Personality values are communication preferences only and
cannot change host rules, permissions, available capabilities, or authoritative
capability outcomes. The profile is persisted with app state and captured at
turn start, so a Settings edit applies to the next turn without changing an
already-running turn. If any structured capability outcome is rejected,
unavailable, or indeterminate, the terminal user-visible response is a
deterministic host-generated status summary instead of untrusted model prose;
turns whose outcomes all complete retain the model response. Chat/voice UI and
transcript/history persistence remain separate v4 work; provider-profile
management is implemented through the host-owned Control Center bridge.

### Generic host voice session (#147)

The desktop owns a host controller/factory for one bounded generic session at a
time. Activation creates a fresh `VoiceAssistantSession`; ending it releases its
microphone reservation, and a later activation creates a new session rather than
reusing the terminal object. The session composes final-only bounded STT input,
the canonical Pet Assistant capability loop, and authoritative response TTS.
The text, STT, and TTS profiles are snapshotted independently; the STT snapshot is
captured before microphone acquisition and remains fixed through transcription.
There is no Talk control, shortcut, chat surface, retained transcript/history, or
Realtime protocol integration in #147; those remain deferred to #150, #148, #149,
and #139 respectively.

Pet-window TTS is request-scoped. Audio and system speech retain a request id and
kind in the renderer, settle replacement/stop/error/close/renderer-loss/navigation
paths exactly once, and the main process rejects a lost or non-completing playback
request at a bounded, duration-aware deadline. System speech is split into bounded
utterance chunks while preserving the authoritative assistant text and emits one
completion after the final chunk. Voice activity is rendered through a dedicated
composable slot, leaving unrelated plugin display and status slots intact when
voice activity clears.

Provider profile management for issue #145 is a host-owned Control Center flow:
the renderer consumes redacted snapshots and explicit actions over preload while
the main process owns validation, persistence, and credentials. These are the
flows worth holding in memory. Each links to the doc that details it.

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
- **Realtime voice foundation.** The host contains a private, one-conversation
  WebRTC lifecycle with a shared microphone lease, generation-safe cleanup, and
  OpenAI-only SDP negotiation. It has no UI, tray surface, plugin SDK method,
  permission, tools, transcripts, memory, or generic TTS integration yet.
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
- **Voice resource ownership is centralized.** Assistant, plugin one-shot, and
  private Realtime lanes release their own leases/tracks; only the shared voice
  resource owner destroys the privacy indicator after every lane has stopped.
- **Pet Assistant lifecycle is bounded.** The host loop is stopped and active
  turns are cancelled before plugin teardown; capability handles remain pinned
  to the plugin generation that registered them.

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
