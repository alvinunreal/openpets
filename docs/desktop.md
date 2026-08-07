# Desktop App

The desktop app (`apps/desktop/`) is the heart of OpenPets: the only long-lived
process, owner of all state, windows, the tray, pet rendering, the plugin
runtime, and the local IPC server that agents talk to. This doc explains its
process model, the major subsystems, and the rules that keep it secure and
stable. For the pet rendering specifics see [pets.md](pets.md); for the IPC wire
contract see [ipc.md](ipc.md); for plugins see [plugins.md](plugins.md).

Source map: `apps/desktop/codemap.md` and `apps/desktop/src/codemap.md` are the
authoritative file-by-file maps. This doc is the narrative on top of them.

## Process model

Electron gives us a **main process** and multiple **renderer processes**. In
OpenPets:

- The **main process** (`src/main.ts` and the modules it orchestrates) holds all
  authority: state, lifecycle, tray, windows, IPC, leases, catalog/install,
  plugins, i18n.
- **Renderers** are sandboxed and powerless by default. Each gets a *narrow*
  preload bridge exposing only the APIs it needs:
  - The **Control Center** renderer (the React/Tailwind UI) via
    `control-center-preload.cjs`.
  - **Pet windows** (transparent, frameless, always-on-top) via `pet-preload.cjs`.
  - **Plugin JS hosts** and **plugin panels** via `plugin-sdk-preload.cjs`.

There is **no default main window**. The app is tray-first: tray actions open
the singleton Control Center routed to a specific page. A single-instance lock
(`app.requestSingleInstanceLock()`) focuses the existing instance instead of
launching a second one.

## Startup sequence

`main.ts` runs a deterministic bootstrap (see `src/codemap.md` for the exact
order): install lifecycle handlers → initialize app state → initialize the
logger → create the tray → start the local IPC server → start the persisted,
opt-in remote-control service if enabled → initialize the plugin service (with
the Electron JS host) → optionally show the default pet. Shutdown stops the
plugin service, remote-control listener, local IPC server, and pet windows.

Key files: `main.ts` (entry/bootstrap), `lifecycle.ts` (app events + cleanup),
`state.ts` (shell pause flag).

## Linux display backend (Ozone/Wayland)

On Linux, `main.ts` appends `--ozone-platform=x11` **before** `app` is ready, so
the app always runs under x11/XWayland. This is required because OpenPets pets
depend on programmatic top-level window positioning (`setPosition`/`setBounds`)
and z-order control (`setAlwaysOnTop`); native Wayland forbids clients from
positioning or restacking their own toplevels, which silently breaks motion,
gravity, walkabout, drag, and always-on-top stacking. The forcing is
unconditional (it overrides even an explicit `--ozone-platform=wayland`) so a
mistaken launch flag cannot disable pet movement.

The escape hatch is the environment variable `OPENPETS_ALLOW_WAYLAND=1`: when
set, the app honors the system default backend (or an explicit
`--ozone-platform`) and emits a one-time `warn("app", ...)` at startup (after the
startup-begin log) stating that positioning, gravity, walkabout, and drag are
unsupported under native Wayland and how to restore full functionality. The
pet-drag path keys off this same effective backend via
`isEffectiveWaylandBackend()` in `pet-window.ts`, which is evaluated at
window-creation time (after the switch is applied) and cached. The pure backend
decision (platform + `--ozone-platform` + `XDG_SESSION_TYPE`/`WAYLAND_DISPLAY`)
is factored into `computeEffectiveWaylandBackend()` in `wayland-backend.ts`;
`pet-window.ts` delegates to it and owns only the cache.

The x11-forcing branch and the `OPENPETS_ALLOW_WAYLAND` opt-out are asserted by
`check-packaging-contract.ts`, so this behavior cannot silently regress.

On Windows, the shell silently strips `HWND_TOPMOST` from other windows when an
app enters fullscreen (browser video, games) and never restores it — and no
Electron event fires when it happens, so the `show`/`restore` re-assertions
never run and the pet stays buried until manually toggled. Pet windows
therefore re-assert always-on-top on a 1s interval while visible (the
shell's demotion sweep re-strips the flag every ~2-4s while a fullscreen app
is foreground, so the cadence bounds the buried time to under a second),
dropping
Electron's cached always-on-top flag first — Electron short-circuits
`setAlwaysOnTop(true)` when its cached state already matches, so without the
cache-bust the re-assert never reaches the OS
(`createBasePetWindow` in `pet-window.ts`); the call is a cheap no-op while the
flag is intact, and keeping the pet above fullscreen content matches the
explicit macOS `visibleOnFullScreen: true` behavior.

Separately, Chromium's native window occlusion tracker considers every window
on a display occluded while a fullscreen app is active there and stops
painting it — a transparent pet window goes blank even with its z-order
intact. `main.ts` disables `CalculateNativeWinOcclusion` on Windows so the
pet keeps rendering during fullscreen video and games.

## Subsystems

### Tray & windows

- `tray.ts` builds the tray icon (`assets.ts` loads `assets/tray-icon.png`,
  keeps it as a full-color image, and falls back to a generated icon if the
  asset is missing) and the context menu,
  including update status and route-targeted Control Center entries and a "open
  logs" action.
- `windows.ts` is the Control Center coordinator: it creates the hardened
  `BrowserWindow`, loads the Vite renderer (dev) or packaged `dist/renderer`
  (prod), targets a route, registers all renderer-facing IPC handlers, builds
  the Dashboard snapshot, and defines the internal asset protocols.
- `display.ts` provides screen-geometry helpers for positioning pet windows,
  including the permissive `clampToNearestDisplayIfOffscreen` helper that allows
  pets to roam across display seams while only snapping when fully off-screen.

### Control Center (renderer)

The React/Tailwind UI under `src/renderer/`. Pages: **Dashboard, Pets,
Integrations, Plugins, Settings**. It is a pure consumer of main-process
snapshots and actions exposed over the preload bridge — it holds no privileged
capability of its own. The renderer is the only "frontend" in scope for these
docs (the `web/` marketing site is out of scope). See
`src/renderer/src/codemap.md` for component structure.

### Pet windows

Pet rendering lives in `pet-window.ts` plus the two controllers
(`default-pet-controller.ts`, `agent-pet-controller.ts`) and the motion/mapping
helpers. This is covered in depth in [pets.md](pets.md).

### Local IPC server

`local-ipc.ts` runs a `net.Server` over a Unix socket / Windows named pipe /
TCP, routes a versioned JSON protocol, and writes a discovery file so clients
can find it. The lease manager (`lease-manager.ts`) sits behind it. Full
contract in [ipc.md](ipc.md).

### Remote control service

`remote-control-service.ts` is deliberately not a mode of `local-ipc.ts`. It is
disabled unless a local caller explicitly configures a concrete private,
loopback, link-local, or CGNAT-range IPv4 address and port. Wildcards, public
addresses, hostnames, IPv6, non-canonical IPv4 text, and port zero are rejected.
Its own versioned protocol has a 4 KiB payload cap, bounded socket lifetime,
concurrent-socket cap, and per-remote-address rate limit. The absolute deadline
remains through response shutdown so half-open peers are reclaimed without
truncating a complete response.

Pairing creates a named client and a high-entropy token. The plaintext token is
returned only by the local pairing/rotation API; persistence stores only its
SHA-256 verifier plus client metadata and activity timestamps. The main-process
IPC interface (`openpets:remote-*`) supports Control Center management: configuration,
pairing, listing, rotation, and revocation. Control Center (Settings → Remote)
provides a dedicated UI with listener configuration, explicit IPv4 bind validation,
a prominent unencrypted TCP transport warning with explicit acknowledgement before
enabling, paired client listing with scope badges, pairing with `say` unchecked by default,
a one-time token handoff panel with environment/CLI setup guidance (`OPENPETS_REMOTE_ENDPOINT="tcp://<address>:<port>"` derived from active listener state), and confirmation
modals for token rotation and client revocation.

Remote requests can only read a sanitized status snapshot, react to the default pet,
or say a short validated message with the `say` scope. Leases, installation, discovery,
files, media, paths, prompts, tool output, and arbitrary pet targets are not part of the
remote capability. Explanatory copy in Control Center highlights these default-pet-only
and no-files/media constraints. LAN ownership is initialized before the remote service
singleton and Control Center handlers; the persisted listener starts only after the normal
UI/local-IPC startup steps. While LAN ownership is unknown or belongs to another host,
remote reactions and speech return `shown: false` instead of waking or forwarding the
local default pet. With LAN mode off, local default-pet behavior is unchanged.

**Pet fallback notification:** when an agent requests a specific pet via
`--pet <id>` and that pet is not installed (or is invalid/broken), the lease
manager silently falls back to the default pet and window confinement does not
activate. `pet-fallback-notify.ts` detects this condition and fires a native
macOS notification (once per unique pet ID) so the user knows why confinement
is inactive. The notification includes the command to use once the pet is
installed.

### App state

`app-state.ts` persists a versioned JSON document under
`userData/openpets-state.json` using atomic temp-write + rename. It holds
installed pets, the default-pet config, reaction→animation overrides, onboarding
state, locale preference, the pet pool preference (ordered pet list +
`petPoolEnabled` toggle), and display-roaming preferences (`petConfinementEnabled`,
`petCrossDisplayEnabled`), plus the global `waitingAnimationDurationMs`
preference. That duration is normalized to `1010` ms (Normal) or `2200` ms
(Relaxed), with `1010` ms as the default. `app-state-core.ts` holds pure helpers
(scale options, waiting-duration options, onboarding normalization) that are
testable without Electron.

#### Pet pool preference

The **pet pool** is an ordered list of installed pets plus a master enable/disable
toggle (`petPoolEnabled`, default `true`), both configurable in Control Center →
Settings → General. When enabled, the lease manager uses the ordered list to
assign a distinct pet to each concurrent agent session that does not explicitly
request one via `--pet <id>`. Slot 1 is the primary/default pet; slot 2 onwards
are assigned to additional sessions in order. When all pool slots are taken,
further sessions receive a random eligible pet (installed, non-broken, not the
built-in default). Slots free up when their session ends. `--pet <id>` bypasses
the pool entirely. When disabled, all sessions without `--pet` share the single
default pet (legacy behavior). Pool assignment is pure lease logic and works on
all platforms.

**Toggle side-effects:** disabling the pool immediately despawns all active pool
pets (releases their leases, which closes their windows). Re-enabling respawns a
pool pet for every session whose client PID is still alive — those sessions
acquire new leases and their windows reopen. Sessions whose processes have already
terminated are skipped. This is handled by `dispatchPoolToggle` in `local-ipc.ts`,
wired from the `update-preferences` IPC handler in `windows.ts`.

**Session teardown:** a periodic liveness sweep (the `local-ipc.ts` cleanup timer
calling `lease-manager.ts`'s `checkPidLiveness`) releases an agent pet's lease —
and so closes its window — once the owning session is gone. It probes the
**terminal owner PID** (when known) as well as the client PID, so an orphaned but
still-running client can't keep a pet alive indefinitely. Expiring the 15s TTL is
the backstop; liveness is the prompt path.

See [agent-integrations.md](agent-integrations.md) for the
full behavioral description.

### Plugin subsystem

A large, self-contained subsystem (`plugin-*.ts`) covering manifests, state,
runtime, the sandboxed JS host, the permission-checked SDK bridge, catalog/local
install, assets, panels, diagnostics, and platform settings. Fully documented in
[plugins.md](plugins.md) and [sdk.md](sdk.md).

The plugin voice foundation is deliberately smaller than a conversation platform.
`voice-capture-electron.ts` owns a hidden, sandboxed microphone window and
isolated session; `voice-capture.ts` owns exactly-once cleanup and cancellation; and
`voice-privacy-indicator-electron.ts` shows the host-owned **OpenPets is listening**
surface only after `getUserMedia()` succeeds. A capture is one-shot and one-at-a-
time, with a 15-second acquisition timeout, a separate 30-second transcription
timeout, and an explicit host cancellation path. Plugin teardown and app shutdown
cancel the active capture, abort transcription, stop tracks, destroy the capture
window, clear its temporary session data, and hide the indicator. No ambient or
wake-word listening is implemented. While active, the existing tray menu exposes
**Stop microphone listening** during acquisition/recording and **Cancel
transcription** while provider transcription is pending; the control disappears
when the operation settles.

The plugin subsystem also owns **display deliveries**: a lazy, transparent,
host-owned surface used by `ctx.ui.delivery`. A delivery is rendered as a single
courier-and-banner surface on the cursor display, rather than as a spawned pet
or a plugin-controlled overlay. Each display advances a bounded FIFO queue;
expiry, dismissal, display removal, plugin reload/disable/uninstall, and app
shutdown are host lifecycle events. The host animates the declared courier strip
and owns its layout; plugins only supply a trusted sprite reference and text.

Calendar Airmail's configuration is a plugin-exclusive courier picker. It is an
accessible animated sprite grid whose selected/hovered/focused cards animate,
while reduced-motion users see a static first frame. It does not select, preview,
or validate installed pets; its bundled courier sprites remain available wherever
the plugin is installed.

### Agent setup

`agent-setup.ts` detects installed agents and runs configuration actions (MCP
add/replace/remove, hooks install/uninstall/doctor, memory file install),
delegating to the integration packages. `claude-memory.ts` manages the Claude
instructions file. See [agent-integrations.md](agent-integrations.md).

### Catalog & installation

`catalog.ts` fetches the pet catalog (v3 paginated, with v2/fixture fallback);
`pet-installation.ts` downloads + validates + extracts pet ZIPs; `codex-pets.ts`
imports locally-developed pets. See [catalog.md](catalog.md) and [pets.md](pets.md).

### i18n

`src/i18n/` resolves the active locale and serves localized host UI text and pet
reaction speech, with English fallback. See [i18n.md](i18n.md).

### Updates

`update-checker.ts` polls GitHub releases and surfaces update status to the tray
and Dashboard; `update-version.ts` does version parsing/comparison.

### Logging

`logger.ts` provides scoped, structured logging (scopes: `app`, `ipc`, `lease`,
`pet.*`, `state`, `tray`, `ui`) with log rotation (~2MB) and redaction of
sensitive data, written to `userData/logs/openpets.log`. Renderer diagnostics
should be routed here so failures are visible in the log file, not only DevTools
(see the logging guidance in `AGENTS.md`).

## Security model

This is non-negotiable surface area. The app handles remote content (catalogs,
ZIPs) and runs third-party plugin code, so it is defensive by construction:

- **Sandboxed renderers** with `contextIsolation`; capabilities reach them only
  through narrow `contextBridge` preload APIs.
- **Strict CSP**: `default-src 'none'`, inline styles only. Any new
  renderer-visible URL scheme, image source, dev endpoint, or internal protocol
  **must** be added to the CSP in *both* `apps/desktop/vite.config.ts` and
  `apps/desktop/src/renderer/index.html`. Common pet image protocols:
  `openpets-codex:`, `openpets-installed:`, `openpets-pet-preview:`, and
  `openpets-plugin-asset:`. Forgetting the CSP makes images fall back to the
  default pet even when install/render logic is correct. (This is a documented,
  easy-to-hit footgun in `AGENTS.md`.)
- **Mock keychain** to avoid OS credential prompts.
- **IPC network security**: local TCP mode is restricted to loopback/private
  addresses; public IPs and hostnames are rejected. Remote control is separate,
  opt-in, explicitly bound, authenticated per client, and scope limited; it
  never writes a discovery file. See [ipc.md](ipc.md).
- **Defensive I/O**: atomic writes everywhere; path-traversal and symlink checks
  on every filesystem boundary; strict ZIP entry validation (`zip-safety.ts`).
- **Plugin sandbox**: plugins run in hidden, session-partitioned BrowserWindows
  with navigation/window-open hardening and permission-gated SDK calls. See
  [plugins.md](plugins.md).

- **Trusted plugin assets**: `openpets-plugin-asset:` serves only an enabled,
  exact-version JavaScript plugin's declared sprite. The protocol accepts only a
  narrow sprite route, resolves it beneath the real install root, rechecks WebP
  dimensions against manifest frame metadata, and returns no filesystem paths to
  a renderer. Delivery documents have their own restrictive CSP and can load
  only this protocol (or data URLs).

## Packaging

`electron-builder.yml` configures cross-platform packaging (macOS/Windows/Linux)
with ASAR. Bundled mode unpacks the integration binaries from ASAR so hooks/MCP
can spawn them. `scripts/release-local.mjs` automates a macOS-local release with
a GitHub draft. See [development.md](development.md) for the release flow.

## Where to look first

| If you're touching… | Start in |
|---------------------|----------|
| Tray menu / Control Center routing | `tray.ts`, `windows.ts` |
| Pet appearance / animation | `pet-window.ts`, `reaction-animation-mapping.ts` ([pets.md](pets.md)) |
| Agent → pet command path | `local-ipc.ts`, `lease-manager.ts` ([ipc.md](ipc.md)) |
| Persisted settings | `app-state.ts` |
| Plugin behavior | `plugin-service.ts` + `plugin-*.ts` ([plugins.md](plugins.md)) |
| Agent configuration | `agent-setup.ts` ([agent-integrations.md](agent-integrations.md)) |
| Install / catalog | `catalog.ts`, `pet-installation.ts` ([catalog.md](catalog.md)) |
| Anything renderer-visible with a URL | also update the CSP (both files) |
</content>
