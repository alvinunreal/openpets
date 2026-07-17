# Pets: Model, Installation & Rendering

A "pet" is an animated character that lives in a transparent desktop window and
reacts to agent activity. This doc covers the whole pet lifecycle: what a pet is
made of, how it gets onto disk, how reactions become animations, and how the
windows behave. For the catalog that ships pets see [catalog.md](catalog.md);
for the command path that triggers reactions see [ipc.md](ipc.md).

Source maps: `apps/desktop/src/codemap.md` (pet windows, controllers,
installation), `packages/install-pet/codemap.md` (standalone installer).

## What a pet is

A pet package is small and asset-driven:

- **`pet.json`** — metadata: `id`, `displayName`, `description`,
  `spritesheetPath`, and optional `category` / `subcategory` / `sourceUrl` /
  `xHandle`. (Catalog entries carry the same identity plus hosting URLs — see
  [catalog.md](catalog.md).)
- **`spritesheet.webp`** — a grid of animation frames. Frames are at least
  `192x208`; thumbnails are derived from the spritesheet.

There are three sources a pet can come from at runtime:

1. **Built-in pet** (`built-in-pet.ts`) — a bundled spritesheet that always
   works as a fallback, even offline with nothing installed.
2. **Catalog pets** — downloaded from the public catalog and extracted into
   `userData/pets/{id}/`.
3. **Codex pets** — locally-developed pets imported from `~/.codex/pets/`
   (`codex-pets.ts`), the dev workflow for authoring a new pet before
   publishing it.

## Default pet vs agent pets

Two distinct window roles, two controllers:

- **Default pet** (`default-pet-controller.ts`) — the always-on companion shown
  when enabled. Persistent. Remembers its position per connected monitor and
  clamps it back into the visible work area after display changes. Shows
  transient reactions and status badges. Not lease-bound.
- **Agent pets** (`agent-pet-controller.ts`) — shown on explicit agent request,
  routed by a **lease**. The first lease opens the window; the last lease
  released closes it. This lets several agents each get their own pet without
  colliding with the default pet. Agent pets roam with the same physics as
  the default pet (gravity + bounce, driven by `pet-roaming-controller.ts`).
  Session lifetime is tracked via PID liveness: when a client process
  terminates, the lease is released within ~5 s and the pet window closes.
  See the lease model in [ipc.md](ipc.md).

Both are created by `pet-window.ts` as transparent, frameless, always-on-top
windows, driven through `pet-preload.cjs` for drag and click-through behavior.

While a pet is click-through it only learns that the cursor is over it through
*forwarded* mouse events (`setIgnoreMouseEvents(true, { forward: true })`), which
Electron delivers on macOS and Windows but not on Linux (Linux pet windows are
kept interactive instead). Both compositors can silently stop forwarding — macOS
across Space switches, display sleep, and fullscreen transitions; Windows after
rapid pet reloads and fullscreen sweeps — which would leave the pet stuck
click-through and impossible to grab. A cursor-probe watchdog in `pet-window.ts`
re-arms forwarding from the main process (`screen.getCursorScreenPoint()`), which
keeps working even when forwarding is dead. The platform predicates live in
`mouse-forwarding.ts`.

## Reactions → animations → speech

A **reaction** is a categorical pet state (thinking, editing, testing, waiting
for permission, success, error, idle, …). The rendering pipeline turns a
reaction into something visible:

1. `reaction-animation-mapping.ts` resolves a reaction to a **sprite animation
   state** (`resolveReactionSpriteState`). This mapping is **user-configurable** —
   users can override which animation a reaction plays, and overrides persist in
   app state. The selectable animation states include idle, review, running,
   waiting, waving, jumping, and failed; `waving` covers attention/notification
   style reactions.
2. `reaction-messages.ts` picks a **speech message** from the pool for that
   reaction; `i18n/reactions/` provides the localized pools so speech matches the
   active locale (see [i18n.md](i18n.md)).
3. `pet-window.ts` renders the chosen animation via CSS sprite animation, and
   shows speech bubbles, alert indicators, pinned HUDs, and status badges as
   requested.

Users may enable **Read speech bubbles aloud** in Control Center → Settings →
General. The host then narrates newly presented plain-text transient bubbles through
the provider selected in Settings → Voice, with optional per-pet overrides and
provider/voice fallbacks. System Voice uses the pet renderer's
`speechSynthesis`; remote and local providers use a separate voice-audio channel.
Text is trimmed and bounded before synthesis. Queued speech keeps the provider,
voice, and model selection it had when accepted; selecting another provider
without an explicit voice or model uses that provider's defaults. Interrupting
or stopping speech settles each renderer playback request exactly once.
This covers the default pet,
leased agent pets, local IPC `pet.say`, and plugin `ctx.pet.speak()` because they
share the pet-window presentation path. Plain-text plugin bubbles may also be
narrated; pinned HUDs, markdown-only bubbles, and interactive controls are not. Quiet hours mute the
automatic voice, and repeated render refreshes of the same visible text are
deduplicated. Speech is best-effort and never blocks or replaces the visual
bubble.

This separation — mapping vs message vs render — is deliberate: agents and
plugins speak in *reactions*, and the host owns *how* those look and sound.

## Companion conversations

Companion Conversations is the host-owned, opt-in identity layer for installed
pets. It is not an OpenAI/Codex agent profile and it is not the coding-agent
reaction stream. Each installed pet can have a separate short personality
(bounded to 800 input characters); the user profile is intentionally small and
shared: name, preferred form of address, and up to five current goals. Goals are
conversation context, not scheduled reminders. Removing a pet also removes that
pet's personality, recent memory, and any live provider turn.

The first **Enable Companion** action is the disclosure boundary. It atomically
enables roughly 24-hour recent memory and gentle proactive check-ins at
**Sometimes**. Plugin context, sensitive plugin context, screen context, and
wake listening remain off. All are independently reversible afterward. The
screen switch is reserved for an explicit future screen-awareness integration;
no screen content is captured or added to prompts in this build.

The user can type in the selected pet detail or use push-to-talk after enabling
the global PTT preference. Both routes enter `CompanionOrchestrator`, which
builds one bounded prompt from the current pet identity, explicit profile, local
time/activity state, recent memory, and consented plugin facts. It then calls
either:

- **Codex CLI** — validates the installed `codex exec --json`/resume contract,
  maintains a cancellable session per pet, and retries a stale session once
  statelessly; or
- **OpenPets AI provider** — uses the host's Anthropic, OpenAI, or Ollama-
  compatible provider configuration and explicit health probe.

Provider selection changes generation transport only. Personality, profile,
memory retention, plugin consent, check-in policy, bubble rendering, and voice
selection stay owned by OpenPets. A provider response is committed as recent
memory only after the pet bubble is successfully displayed. User turns are
committed when accepted; failed persistence is logged without losing the live
turn. Memory rolls for 24 hours and is additionally capped at 200 total entries,
60 entries per pet, 2,000 characters per entry, 512 KiB on disk, and a smaller
recent subset in each prompt. The user can clear one pet's memory at any time.

Check-ins apply to the visible, unpaused default pet. Host candidates come from
morning/midday/evening timing and the user's explicit goals; enabled plugins may
add expiring opportunities. Quiet hours and any active listening, thinking, or
speaking suppress them. Rarely/Sometimes/Often are maximum frequencies (1/3/5
per local day, with 6-hour/3-hour/90-minute spacing), not notification schedules.
The pet can also change its reaction once per local day part—bright in the
morning, hungry around midday, content in the afternoon, winding down in the
evening, sleepy at night—without starting a conversation.

Wake-word health intentionally remains a packaging gate. The disabled UI is a
truthful capability boundary, not a partially functional listener: no local
runtime/model is shipped and no ambient audio is collected for wake detection.

## Motion

The motion engine (`pet-motion-engine.ts`) drives all pet windows through a
single shared ticker (≈60 fps). Each registered pet gets its own `MotionState`
entry in a `Map<petHandleId, MotionState>`, but all pets share one `setInterval`
so positions advance in lock-step with one `getAllDisplaysCached()` read per
tick.

`pet-roaming-controller.ts` is the host-side orchestrator: it registers every
live pet (default and agent) with the engine and applies the active roaming
configuration (gravity + bounce). When a pet is despawned the controller
unregisters it before the window is destroyed, so the shared ticker never
touches a closed window.

Plugin-driven movement (`plugin-sdk-routes.ts` → `plugin-pet-registry.ts`) feeds
target vectors and physics overrides through the engine's public API
(`motionMoveTo`, `motionSetPhysics`, `motionSetFollowCursor`). The engine is the
**sole continuous position writer**; all per-pet step loops were eliminated to
prevent jitter from competing writers. An accepted target move remains shared-
ticker work until it finishes or is superseded, even if the follow or physics
mode that delegated it is disabled in the meantime. Sub-pixel fractional accumulators
(`fracX` / `fracY` in `MotionState`) ensure smooth movement at any tick rate.
See [plugins.md](plugins.md) and [sdk.md](sdk.md) for the plugin side.

### Display containment and cross-display roaming

`display.ts` owns all screen-geometry decisions. Per-tick clamping in
`clampPosition()` follows a strict priority order:

1. **Confinement** — if a pet has a terminal-bounds assignment (see below), it
   is always snapped into those bounds regardless of any other flag.
2. **Cross-display roaming** (default **off**) — if the
   `petCrossDisplayEnabled` preference is on, `clampToNearestDisplayIfOffscreen`
   is used: the pet is left alone while its bottom-center anchor overlaps any
   display's work area, and is only snapped to the nearest display edge when
   fully off-screen. This lets pets cross seams between adjacent displays
   freely.
3. **Legacy single-display mode** — if `petCrossDisplayEnabled` is off, the
   original `clampToVisibleWorkArea` behavior is used (pet is clamped to the
   display nearest its geometric center).

**Wide gaps between non-adjacent displays:** a pet moving toward an empty
region will stick at the edge of its current display and cannot teleport across
a gap wider than the pet. This is expected behavior and is by design.

**Topology changes** (monitor plugged/unplugged, resolution changed): the
display-event handlers in `default-pet-controller.ts` call
`reclampAllLivePetWindows()`, which re-runs the permissive clamp for the
default pet, all agent pets, and all plugin-spawned pets. Pets on a removed
display are snapped to the nearest remaining display; pets on surviving displays
are left untouched.

The `petCrossDisplayEnabled` toggle lives in Control Center → Settings, under
the **Movement** section, and is a global flag (not per-pet). It is shown
disabled with explanatory helper text until a movement plugin — one granted the
`pet:move` permission, such as Walkabout — is enabled, since cross-display
roaming has no effect without a mover driving motion. Confinement remains
strictly per-pet and always takes priority regardless of the cross-display flag.

### Linux & Wayland

All pet motion depends on the app being able to **programmatically position a
top-level window** and keep it **always-on-top** (`setPosition`/`setBounds` plus
`setAlwaysOnTop`). Native Wayland deliberately forbids clients from positioning
or restacking their own toplevels, so under a native Wayland backend every
position write is silently ignored by the compositor: gravity, walkabout,
follow-cursor, cross-display roaming, drag, and z-order all become no-ops even
though the motion engine keeps computing new coordinates. (This is the root
cause behind "pet doesn't move / gravity doesn't work" reports on KDE/KWin
Wayland.)

To keep motion working, OpenPets forces the Linux Ozone backend to **x11
(XWayland)**, where these window operations are honored. Drag selects its path
at window creation via `isEffectiveWaylandBackend()` in `pet-window.ts` (which
delegates the pure decision to `computeEffectiveWaylandBackend()` in
`wayland-backend.ts`): under the forced x11 backend it returns `false` and the
working `setBounds` drag path is used. The backend-forcing itself lives in `main.ts` and is documented in
[desktop.md](desktop.md#linux-display-backend-ozonewayland), including the
`OPENPETS_ALLOW_WAYLAND=1` opt-out (which restores native Wayland and therefore
disables the motion/drag/always-on-top behavior above, with a one-time startup
warning).

## Installation

Two install paths exist; they share the same safety rules.

### Through the running app (preferred)

`pet-installation.ts`:

1. `getCatalogPet()` resolves the pet from the catalog (`catalog.ts`).
2. `downloadPetZip()` streams the ZIP from `zip.openpets.dev`, validating magic
   bytes.
3. `extractPetZip()` extracts with `yauzl` under strict entry validation
   (`zip-safety.ts`): no path traversal, no symlinks, case-collision detection,
   size/file-count caps.
4. Extraction is atomic (temp dir → rename) into `userData/pets/{id}/`, and
   `installPetState()` records it in app state.

Local pet packages can also be installed through the running app via the CLI:
- `openpets install --from-zip <path-to-zip>`
- `openpets install --from-folder <path-to-folder>`

These send a `pets.install-local` request to the running app over IPC, which validates and imports the local zip file or folder.
The CLI resolves relative paths before sending them; the IPC/client protocol
itself requires an absolute path plus an explicit `zip` or `folder` kind.

### Standalone installer (`install-pet`)

`packages/install-pet/` is a standalone CLI (`install-pet <pet-id>` or
`npx -y install-pet <pet-id>`). It prefers the running app via
`@open-pets/client` and **falls back** to a direct download + extract when the
app is unavailable. Direct mode uses a lock file (`.install-pet.lock`, 10-min
stale timeout) to prevent concurrent installs, the same ZIP safety limits (50MB
download / 200MB extracted / 500 files / 100MB per file), and the same
platform-specific user-data path resolution. This is what powers
"`npx install-pet <id>`" without requiring the app to be open.

### ZIP safety (shared)

Both paths enforce: HTTPS-only catalog/ZIP hosts on an allowlist, no encrypted
entries, only stored/deflate compression, valid Unix modes, required files
(`pet.json` + `spritesheet.webp`), and atomic extraction with private
permissions. The pet `id` must match `^[a-z0-9][a-z0-9_-]{0,63}$` and cannot be
`builtin`.

## Codex pets (local authoring)

`codex-pets.ts` imports pets from `~/.codex/pets/` with the same metadata
validation, so an author can iterate on a pet locally before it is published to
the catalog. The publishing path (zipping, thumbnailing, uploading to R2,
regenerating the catalog) lives in `web/`'s sync scripts and is documented in
`web/docs/pet_publishing.md`; the contract those produce is in [catalog.md](catalog.md).

## Image protocols & CSP

Pet images are served to renderers through internal protocols
(`openpets-codex:`, `openpets-installed:`, `openpets-pet-preview:`). Any new
protocol or image source must be added to the CSP in **both**
`apps/desktop/vite.config.ts` and `apps/desktop/src/renderer/index.html`, or
images silently fall back to the default pet. This is the single most common
"why is my pet showing the wrong sprite" bug — see [desktop.md](desktop.md).

## Where to look first

| If you're touching… | Start in |
|---------------------|----------|
| How a reaction looks | `reaction-animation-mapping.ts` |
| What a pet says | `reaction-messages.ts` + `i18n/reactions/` |
| Per-pet conversational identity | `companion-settings.ts`, `companion-context.ts` |
| Recent conversation memory | `companion-memory.ts` |
| Typed/PTT conversation and providers | `companion-orchestrator.ts`, `companion-target-*.ts`, `voice-listening-service.ts` |
| Time expression / proactive check-ins | `companion-time.ts`, `companion-proactivity.ts`, `companion-proactive-service.ts` |
| Window behavior (drag, click-through) | `pet-window.ts`, `pet-preload.cjs` |
| Default vs agent visibility | `default-pet-controller.ts`, `agent-pet-controller.ts` |
| Installing / extracting | `pet-installation.ts`, `zip-safety.ts` |
| Standalone install | `packages/install-pet/` |
| Local pet authoring | `codex-pets.ts` |
| Movement | `pet-motion-engine.ts` |
| Display containment / cross-screen | `display.ts`, `confinement-manager.ts` |
| Topology-change reclamp | `default-pet-controller.ts` → `reclampAllLivePetWindows` |
</content>
