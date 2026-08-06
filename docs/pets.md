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

Experimental multi-pet LAN mode adds a third, isolated controller for visiting
pets. Windows are keyed by LAN owner host rather than pet ID, so they do not
collide with lease-managed agent pets or with another visitor using the same
pet package. Unavailable remote assets are logged and skipped safely.
Fresh coarse work activity can temporarily render a built-in return-to-work
line with the visitor's `running` animation; after the dash delay, coordinator
state returns that visitor to its owner.

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

The waiting animation cycle is a global preference in Control Center → Settings
→ Reactions. **Normal** keeps the default `1010` ms cycle and **Relaxed** uses
`2200` ms. The renderer derives a fresh sprite-state table for the selected
duration instead of mutating `defaultPetSprite.states`, so all other reaction
mappings and animation durations stay unchanged. The setting applies to both
built-in and installed pets; plugin-provided sprite overrides continue to use
their own FPS and loop settings. Changing the preference refreshes open default
and agent pet windows, and the duration is part of their render identity so
already-open windows reload their CSS immediately. The Settings preview uses the
same configured duration.

This separation — mapping vs message vs render — is deliberate: agents and
plugins speak in *reactions*, and the host owns *how* those look and sound.

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
prevent jitter from competing writers. Sub-pixel fractional accumulators
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
| Window behavior (drag, click-through) | `pet-window.ts`, `pet-preload.cjs` |
| Default vs agent visibility | `default-pet-controller.ts`, `agent-pet-controller.ts` |
| Installing / extracting | `pet-installation.ts`, `zip-safety.ts` |
| Standalone install | `packages/install-pet/` |
| Local pet authoring | `codex-pets.ts` |
| Movement | `pet-motion-engine.ts` |
| Display containment / cross-screen | `display.ts`, `confinement-manager.ts` |
| Topology-change reclamp | `default-pet-controller.ts` → `reclampAllLivePetWindows` |
</content>
