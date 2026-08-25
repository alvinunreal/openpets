---
description: Build OpenPets SDK v3 plugins with the host-provided context object, voice and delivery APIs, testing harness, and scaffolded plugin packages.
---

# Plugin SDK v3

`@open-pets/plugin-sdk` (`packages/sdk/`) is the **public, author-facing
contract** for OpenPets plugins. It is a *types-first* package: it ships
TypeScript declarations describing the `OpenPetsContext` a plugin receives, plus
a deterministic, no-Electron **test harness**. The real behavior is injected at
runtime by the desktop host - the SDK is the shape both sides agree on.

For the platform that *implements* this contract (sandbox, permissions, install),
see [Plugin platform](/plugins). Source map: `packages/sdk/src/codemap.md`.

Current line: SDK `3.x`, paired with plugin `manifestVersion: 3`. The exact
published package version is owned by `packages/sdk/package.json`.

## How the contract is enforced

There are three copies of "the SDK" and they must stay in lockstep:

1. **The published types** - `packages/sdk/src/index.ts`. What authors program
   against.
2. **The host implementation** - `apps/desktop/src/plugin-sdk-bridge.ts` and its
   `plugin-sdk-*` namespace modules. What actually runs.
3. **The test harness** - `packages/sdk/src/testing.ts`. A mock `ctx` for unit
   tests.

A conformance check (`packages/sdk/src/check-plugin-sdk.ts`) compiles/runs a
representative plugin against the harness to detect drift. **Rule: a change to
the SDK touches `index.ts`, `testing.ts`, the desktop bridge, and the
conformance check together.** Updating one without the others is how the
contract silently breaks.

## The context object

A plugin exports a registration hook; at runtime the host calls it with a
host-backed `ctx` (`OpenPetsContext`). Capabilities are grouped into namespaces,
each gated by a permission ([Plugin platform](/plugins)):

| Namespace | What it does | Rough permission |
|-----------|--------------|------------------|
| `ctx.pet` | Drive the default pet: speak, react | `pet:*` |
| `ctx.pets` | Spawn/target multiple pets, motion | `pets:*` |
| `ctx.ui` | Host-rendered bubbles, alerts, menu items, panels | `ui:*` |
| `ctx.schedule` | Recurring / one-shot timers | `schedule` |
| `ctx.storage` | Quota-bound persistent plugin data + subscriptions | `storage` |
| `ctx.config` | Read config + listen for changes | (config schema) |
| `ctx.events` | Curated host events: clicks, drag/drop, display, power, idle | `events` |
| `ctx.bus` | Inter-plugin publish/subscribe | `bus` |
| `ctx.audio` | Play plugin/user sounds | `audio` |
| `ctx.voice` | TTS + one-shot listen | `voice:*` |
| `ctx.notify` | OS-style notifications/toasts | `notify` |
| `ctx.ai` | Host-mediated AI gateway | `ai` |
| `ctx.secrets` | Encrypted plugin-scoped secrets | `secrets` |
| `ctx.auth` | Host-mediated OAuth/PKCE | `auth` |
| `ctx.net` | Declared∩approved hosts; public HTTPS + optional local HTTP via `network:local`; non-GET via `network:write` | `network`, `network:write`, `network:local` |
| `ctx.files` | Scoped file access | `files` |
| `ctx.system` | System info / clipboard | `system:*`, `clipboard` |
| `ctx.assets` | Resolve declared asset refs (icons/images/sprites/sounds) | (declared assets) |
| `ctx.commands` | Register right-click commands | `commands` |
| `ctx.status` | Publish status text | (status surface) |
| `ctx.assistant` | Explicitly register structured capabilities for host assistant routing | No new permission |
| `ctx.t` | Localized strings via plugin locales | - |
| `ctx.log` | Plugin logging | - |

The exact signatures live in `packages/sdk/src/index.ts` - that file is the
contract, so program against it rather than any list copied into a doc.
`OpenPetsPermission` in the SDK mirrors manifest validation so authors get
autocomplete for exactly the capabilities they can request.

### `ctx.assistant`

`ctx.assistant.registerCapability(...)` is the explicit opt-in for making a
plugin operation callable by the host Pet Assistant. There is deliberately no
`assistant` manifest permission: registration grants no authority and does not
change the plugin's existing permission approvals. Every SDK effect performed
by a handler still goes through the normal bridge permission and quota checks.

A capability has a stable `id`, a plain-language `description`, and an
object-rooted `inputSchema`. The v1 schema subset supports `type`, `properties`,
`required`, boolean `additionalProperties`, `description`, `enum`, `const`,
string `minLength`/`maxLength`, numeric `minimum`/`maximum`, and array `items`,
`minItems`, and `maxItems`. The host rejects unsupported schema keywords and
malformed descriptors. Inputs are validated and cloned before the handler runs;
handlers return object-shaped JSON-safe results subject to host size and depth
limits. `unregisterCapability(id)` removes a registration owned by the current
plugin generation. Current v1 limits are 32 registrations per plugin, 16 KiB
per schema, depth six for schemas, 32 properties per object, 128 total schema
properties, 32 array items, 4,096 characters per string, 64 KiB per input or
result, and a five-second host execution wait.

If validated input is missing a required field, the host may return the
structured failure discriminator `missingInformation: true`. This tells the
assistant surface to request that value from the user; it is distinct from
generic rejected, unavailable, or indeterminate capability outcomes and does
not add provider-specific behavior.

The host owns capability discovery and execution routing. Plugin disable,
reload, and stop revoke registrations, and an in-flight result from an old
plugin generation is rejected rather than returned as current state. Capability
registration does not persist transcripts or conversations. Sensitive-action
confirmation UX and the Pet Assistant model loop are outside this contract;
issue #137 only adds the plugin capability boundary and does not implement
realtime tool calling.

`ctx.net` is the canonical network surface. Executable permissions are
manifest∩approved. Hosts match the intersection of `network.hosts` and approved
hosts; a bare hostname covers only the scheme default port. `network:local` adds
declared loopback/private HTTP endpoints alongside public HTTPS (public hosts
still use public-host checks). `network:write` unlocks non-GET on `ctx.net` only.
Legacy `ctx.http.fetch` stays GET-only public HTTPS and never inherits local or
write access.

### `ctx.voice.listen`

`ctx.voice.listen()` is a single, host-owned push-to-talk capture. It is visibly
indicated only after microphone acquisition succeeds, never listens ambiently,
and rejects concurrent requests. The host bounds acquisition at 15 seconds and
transcription at 30 seconds, trims the returned text, and rejects empty output
with `Voice transcription returned no text.` The host cancellation path is used
when a plugin is stopped or OpenPets shuts down; plugin code does not receive raw
audio, credentials, or a renderer handle for the privacy surface.

Commands time out after five seconds by default. A command that deliberately
waits for user interaction, such as host-mediated OAuth, may declare a bounded
`timeoutMs` between one second and five minutes.

### OAuth installed-app credentials

`ctx.auth.oauth` accepts an optional `clientSecret` alongside the provider,
client ID, and approved scopes. An installed-app credential may require that
secret at its token endpoint even when the host uses PKCE and a loopback
redirect. The host keeps OAuth session data, including a supplied client secret,
in encrypted plugin-scoped secret storage; plugins should not log it.

### `ctx.ui.delivery`

`ctx.ui.delivery` requests a generic, host-owned, display-level delivery and
requires the dedicated `ui:delivery` permission. Authors provide a stable
plugin-scoped key, a courier returned by `ctx.assets.sprite()` for a
manifest-declared sprite, plain-text title/detail, and a near-term expiry. The
host - not plugin code - selects the cursor display, renders the delivery, queues it
with other work, and controls its visual behavior. Coordinates, HTML, URLs,
arbitrary asset paths, and animation controls are intentionally outside this
contract.

The call returns an opaque handle. A plugin may dismiss its delivery or register
one dismissal handler; the reason is `click`, `manual`, `expired`, or
`plugin-stopped`. Re-registering the same key supersedes the prior handle.
Handlers are not invoked after the plugin host has stopped. Use the stable key
to make repeated sync or reminder work idempotent, and treat dismissal as a
host lifecycle signal rather than a durable acknowledgement.

## Design principles authors should know

- **Describe, don't render.** You hand the host descriptors (a bubble, an alert,
  a HUD, a command); the host validates, lays out, and owns lifecycle. You can't
  draw into a pet window directly. This is what keeps plugins safe and
  consistent.
- **Everything is permission-gated and quota-bound.** A namespace call without
  the declared+approved permission is denied; storage and other namespaces have
  quotas (`plugin-sdk-quotas`). Design for graceful denial.
- **Assistant registration is not permission escalation.** Only explicitly
  registered capabilities are discoverable, while their handlers retain the
  plugin's ordinary manifest and user-approved authority.
- **State survives restarts.** `ctx.storage` persists; schedules reconcile after
  restart/sleep. Stateful companions (reminders, virtual pet) rely on this.
- **Localize by reference.** Use `$t:` in the manifest and `ctx.t(key, vars)` in
  code; ship `locales/en.json`. See [Internationalization](/i18n).
- **Declare visual assets explicitly.** A delivery courier must be a declared
  sprite asset, never an installed-pet ID or filesystem path. Sprite-grid config
  is a host-rendered select presentation whose previews must refer to declared
  sprites; the host honors reduced-motion preferences in that picker.

## The test harness - `@open-pets/plugin-sdk/testing`

Plugin tests import `createTestHarness(register, options)`. It builds a
deterministic mock `ctx` with **fake time** and runs the plugin's startup
without Electron, then exposes controls and assertions:

- **Drive**: `clock.advance(...)`, `emit(event)`, `runCommand(...)`,
  `runCapability(...)`, `fireBubbleAction(...)`.
- **Assert on recorded effects** (descriptors, not pixels): helpers like
  `expectSpoke`, `expectBubble`, `expectScheduled`, plus recorded
  storage/config/network/AI/sound/panel/pet actions, recorded deliveries, and
  capability registrations.

`runCapability()` directly invokes a recorded plugin handler so plugin behavior
tests stay deterministic. It assumes the descriptor and input are valid for the
host contract; it intentionally does not reproduce the desktop bridge's
security, schema, input, or result validation. The authoritative production
boundary remains `plugin-sdk-preload.cjs` -> `PluginSdkBridge` ->
`plugin-sdk-assistant.ts`, covered by desktop bridge/runtime tests.

This is why official plugins can have fast, deterministic `test.js` suites:
they assert that a scheduled job *would* fire and the pet *would* speak, by
advancing fake time - no rendering, no flake. See `plugins/official/*/test.js`
for real examples and [Testing and validation](/testing-and-validation) for
how these run in CI.

## Starting a plugin

`openpets plugin new <name> --template <blank|reminder|ambient|ai-chat|tamagotchi|calendar>`
scaffolds a working SDK v3 package wired to this contract and the testing
harness. The templates intentionally exercise current surfaces (`ctx.ui.alert`,
dynamic speech, events, schedules, storage, commands, AI, assets, and a
Tamagotchi-style state loop) so authors have a real starting point rather than an
empty file. See [Plugin platform](/plugins) for the full authoring workflow.
