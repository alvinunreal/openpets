# Plugin SDK v3

`@open-pets/plugin-sdk` (`packages/sdk/`) is the **public, author-facing
contract** for OpenPets plugins. It is a *types-first* package: it ships
TypeScript declarations describing the `OpenPetsContext` a plugin receives, plus
a deterministic, no-Electron **test harness**. The real behavior is injected at
runtime by the desktop host — the SDK is the shape both sides agree on.

For the platform that *implements* this contract (sandbox, permissions, install),
see [plugins.md](plugins.md). Source map: `packages/sdk/src/codemap.md`.

Current version: SDK `3.0.0`, paired with manifest `manifestVersion: 3`.

## How the contract is enforced

There are three copies of "the SDK" and they must stay in lockstep:

1. **The published types** — `packages/sdk/src/index.ts`. What authors program
   against.
2. **The host implementation** — `apps/desktop/src/plugin-sdk-bridge.ts` and its
   `plugin-sdk-*` namespace modules. What actually runs.
3. **The test harness** — `packages/sdk/src/testing.ts`. A mock `ctx` for unit
   tests.

A conformance check (`packages/sdk/src/check-plugin-sdk.ts`) compiles/runs a
representative plugin against the harness to detect drift. **Rule: a change to
the SDK touches `index.ts`, `testing.ts`, the desktop bridge, and the
conformance check together.** Updating one without the others is how the
contract silently breaks.

## The context object

A plugin exports a registration hook; at runtime the host calls it with a
host-backed `ctx` (`OpenPetsContext`). Capabilities are grouped into namespaces,
each gated by a permission ([plugins.md](plugins.md)):

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
| `ctx.net` | Restricted HTTPS fetch / streaming to declared hosts | `network:*` |
| `ctx.files` | Scoped file access | `files` |
| `ctx.system` | System info / clipboard | `system:*`, `clipboard` |
| `ctx.assets` | Resolve declared asset refs (icons/images/sprites/sounds) | (declared assets) |
| `ctx.commands` | Register right-click commands | `commands` |
| `ctx.status` | Publish status text | (status surface) |
| `ctx.t` | Localized strings via plugin locales | — |
| `ctx.log` | Plugin logging | — |

The exact signatures live in `packages/sdk/src/index.ts` — that file is the
contract, so program against it rather than any list copied into a doc.
`OpenPetsPermission` in the SDK mirrors manifest validation so authors get
autocomplete for exactly the capabilities they can request.

`ctx.auth.oauth(...)` supports provider-specific PKCE flows, including Spotify.
Desktop/native providers can set `loopbackPort` when their dashboard requires a
fixed loopback redirect such as `http://127.0.0.1:48373/callback`; omit it to use
the host's dynamic loopback port default.

## Design principles authors should know

- **Describe, don't render.** You hand the host descriptors (a bubble, an alert,
  a HUD, a command); the host validates, lays out, and owns lifecycle. You can't
  draw into a pet window directly. This is what keeps plugins safe and
  consistent.
- **Everything is permission-gated and quota-bound.** A namespace call without
  the declared+approved permission is denied; storage and other namespaces have
  quotas (`plugin-sdk-quotas`). Design for graceful denial.
- **State survives restarts.** `ctx.storage` persists; schedules reconcile after
  restart/sleep. Stateful companions (reminders, virtual pet) rely on this.
- **Localize by reference.** Use `$t:` in the manifest and `ctx.t(key, vars)` in
  code; ship `locales/en.json`. See [i18n.md](i18n.md).

## The test harness — `@open-pets/plugin-sdk/testing`

Plugin tests import `createTestHarness(register, options)`. It builds a
deterministic mock `ctx` with **fake time** and runs the plugin's startup
without Electron, then exposes controls and assertions:

- **Drive**: `clock.advance(...)`, `emit(event)`, `runCommand(...)`,
  `fireBubbleAction(...)`.
- **Assert on recorded effects** (descriptors, not pixels): helpers like
  `expectSpoke`, `expectBubble`, `expectScheduled`, plus recorded
  storage/config/network/AI/sound/panel/pet actions.

This is why official plugins can have fast, deterministic `test.js` suites:
they assert that a scheduled job *would* fire and the pet *would* speak, by
advancing fake time — no rendering, no flake. See `plugins/official/*/test.js`
for real examples and [testing-and-validation.md](testing-and-validation.md) for
how these run in CI.

## Starting a plugin

`openpets plugin new <name> --template <blank|reminder|ambient|ai-chat|tamagotchi|calendar>`
scaffolds a working SDK v3 package wired to this contract and the testing
harness. The templates intentionally exercise current surfaces (`ctx.ui.alert`,
dynamic speech, events, schedules, storage, commands, AI, assets, and a
Tamagotchi-style state loop) so authors have a real starting point rather than an
empty file. See [plugins.md](plugins.md) for the full authoring workflow.
</content>
