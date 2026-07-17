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
| `ctx.companion` | Offer expiring facts/opportunities to the host Companion | `companion:context` |
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

`ctx.pet.speak()` always means "show an ordinary pet speech bubble." Users can
optionally ask the host to read those bubbles aloud with its selected voice
provider; that preference is outside the plugin contract, requires no plugin changes, respects
quiet hours, and is never guaranteed audio. Use `ctx.voice.speak()` only when
audible TTS is an explicit part of the plugin's own behavior and declare its
permission normally. Plain-text `ctx.ui.bubble()` content may also be narrated
when it is the visible transient bubble; pinned, markdown-only, and interactive
bubbles are excluded.

`ctx.voice.speak()` accepts an optional `petHandleId`. A plugin may omit it to
use the default pet or pass a handle returned by its own `ctx.pets.spawn()` call;
the desktop bridge injects the calling plugin ID and rejects cross-plugin or dead
handles before selecting that pet's configured voice. `ctx.voice.listen()` is
still a bounded one-shot operation—wake-word listening is a separate host
feature and never broadens the plugin permission.

Commands time out after five seconds by default. A command that deliberately
waits for user interaction, such as host-mediated OAuth, may declare a bounded
`timeoutMs` between one second and five minutes.

### `ctx.companion`

`ctx.companion` is a context-contribution API, not a conversation or speech API.
It requires the manifest's `companion:context` permission and separate user
consent in Companion settings. Normal contributions require **Plugin context**;
`sensitivity: "sensitive"` additionally requires **Sensitive plugin context**.
The host may ignore every call when consent, plugin enablement, expiry, quota,
the active companion target, cooldown, or proactive policy does not allow it.

- `contributeFact({ key, text, expiresAt, sensitivity? })` offers
  a short factual statement for bounded prompt context.
- `offerOpportunity({ key, context, urgency, earliestAt, expiresAt, dedupeKey,
  cooldownMs?, sensitivity? })` offers a time window in which the
  host may generate its own proactive check-in.
- `remove(key)` withdraws either kind by its plugin-scoped key.

Keys are stable plugin-scoped identifiers. Fact text and opportunity context are
plain text of 1–500 characters; expiry must be within 24 hours, and opportunity
cooldown is bounded to seven days. Contributions belong to the active default
companion; plugins cannot retarget them to spawned or agent pets. The desktop
also enforces 20 calls per minute, 32 retained contributions
per plugin, and 256 overall. Contributions are process-local and never become
core recent memory. They are untrusted quoted context: do not put commands or
final pet copy in them.

The bundled Focus Buddy demonstrates the intended pattern. It offers a low-
urgency mid-session context window and removes it on pause/end. It does not call
speech, choose the Companion provider, or assume the host will interrupt.

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
host—not plugin code—selects the cursor display, renders the delivery, queues it
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
- **Contributions are advisory.** `ctx.companion` data is expiring, untrusted,
  separately consented, and optional. Keep durable plugin facts in
  `ctx.storage`, then re-contribute only the current bounded context.
- **State survives restarts.** `ctx.storage` persists; schedules reconcile after
  restart/sleep. Stateful companions (reminders, virtual pet) rely on this.
- **Localize by reference.** Use `$t:` in the manifest and `ctx.t(key, vars)` in
  code; ship `locales/en.json`. See [i18n.md](i18n.md).
- **Declare visual assets explicitly.** A delivery courier must be a declared
  sprite asset, never an installed-pet ID or filesystem path. Sprite-grid config
  is a host-rendered select presentation whose previews must refer to declared
  sprites; the host honors reduced-motion preferences in that picker.

## The test harness — `@open-pets/plugin-sdk/testing`

Plugin tests import `createTestHarness(register, options)`. It builds a
deterministic mock `ctx` with **fake time** and runs the plugin's startup
without Electron, then exposes controls and assertions:

- **Drive**: `clock.advance(...)`, `emit(event)`, `runCommand(...)`,
  `fireBubbleAction(...)`.
- **Assert on recorded effects** (descriptors, not pixels): helpers like
  `expectSpoke`, `expectBubble`, `expectScheduled`, plus recorded
  storage/config/network/AI/sound/panel/pet actions, deliveries, and
  `calls.companionContributions` / `removedCompanionContributions`.

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
