# apps/desktop/src/

## Responsibility

Core TypeScript source for the OpenPets desktop application. Organized into: lifecycle management, state persistence, Control Center and pet windows, IPC server, agent integrations, pet installation/management, and declarative plus JavaScript plugin runtimes.

## Design/Patterns

- **Modular Controllers**: Separate controllers for default pet vs agent pets (lease-based)
- **Protocol-First IPC**: Versioned JSON protocol over TCP/Unix sockets with token auth
- **Defensive I/O**: All file operations use temp+rename for atomicity, path traversal validation, symlink checks
- **Validation at Boundaries**: Catalog, ZIP entries, pet metadata, and IPC params all strictly validated
- **Lease Pattern**: Agent pets use expiring leases (15s TTL) with heartbeats; default pet is persistent
- **Sandboxed Renderers**: Control Center loads the Vite React/Tailwind bundle through a hardened BrowserWindow and narrow preload bridge; transparent pet windows and plugin SDK host windows stay separate
- **Structured Logging**: Scoped logging (app, ipc, lease, pet.*, state, tray, ui) with log rotation and redaction
- **Reaction Animation Mapping**: User-configurable mapping from reaction types to sprite animation states
- **Plugin Runtimes**: Plugins use validated manifests, approved permissions, persisted config, safe path checks, declarative timer-triggered actions, or sandboxed JavaScript entry modules through the SDK bridge.
- **Capability-Oriented SDK Surface**: The plugin bridge is split into focused SDK modules for audio, bus, config, events, quotas, routes, state, storage, types, and UI so permission checks and host effects stay localized.
- **Host-Rendered Plugin UI**: Plugins describe bubbles, alerts, commands, panels, assets, and pet behavior; the host validates descriptors and renders them through pet windows, Control Center IPC, or sandboxed panel windows.
- **Localized Runtime Content**: `i18n/` and plugin locale catalogs resolve host UI text, pet reaction messages, and plugin `$t:` strings through fallback-aware message catalogs.
- **Motion Engine Abstraction**: Advanced pet movement uses a small physics/interpolation engine rather than embedding movement math in window or SDK routing code.

## Data & Control Flow

**Main Process Flow**:
```
main.ts
├── lifecycle.ts (app events, cleanup)
├── logger.ts (structured logging init)
├── app-state.ts (state init)
├── plugin-service.ts (plugin state/runtime init, JS host wiring)
├── tray.ts (tray creation)
├── local-ipc.ts (IPC server start)
└── windows.ts (UI handlers)
```

**IPC Request Flow**:
```
local-ipc.ts → parseIpcRequest() → handleRequest()
├── hello/status/pets.list/pets.install
└── lease.acquire/heartbeat/release
    └── lease-manager.ts
        ├── resolveTarget() (default vs explicit pet)
        ├── onFirstExplicitLease → agent-pet-controller.showAgentPet()
        └── onLastExplicitLease → agent-pet-controller.closeAgentPetIfOpen()
        └── Logging via logger.ts (ipc, lease scopes)
```

**Pet Display Flow**:
```

**LAN visiting-pet flow**: with `OPENPETS_LAN_PETS=multi`, each client
registers its selected default pet through `lan-http-controller.ts`.
`lan-controller.ts` reports positions for every pet currently hosted locally
and reconciles coordinator snapshots through `lan-pet-controller.ts`.
Visiting windows are keyed by owner host, use `lan-pet-presence.ts` for pure
show/close and asset-availability decisions, and stay isolated from agent
leases. The bundled pet can render explicitly for fresh-profile LAN testing;
missing or broken catalog assets are skipped without stopping LAN polling.
`lan-pet-activity.ts` gates coarse work signals to active meetings and plans
single-use visitor departures. `lan-pet-controller.ts` renders the built-in
return line plus `running` animation before `lan-controller.ts` requests the
coordinator return the visitor to its owner.
pet-window.ts
├── createDefaultPetWindow() / createAgentPetWindow()
├── loadDefaultPetContent() / loadExplicitPetContent()
│   ├── HTML generation with CSS sprite animation
│   ├── reaction-animation-mapping.ts (resolveReactionSpriteState)
│   ├── reaction-messages.ts (pickReactionMessage for bubbles)
│   ├── i18n/reactions (localized reaction speech pools)
│   └── Speech bubbles, alert indicators, pinned HUDs, and status reactions
└── pet-preload.cjs (renderer IPC for drag/click-through)

Plugin motion APIs:
plugin-sdk-bridge.ts → plugin-sdk-routes.ts → plugin-pet-registry.ts
└── pet-motion-engine.ts tick() calculates interpolated target vectors for spawned/default pets
```

**Agent Setup Flow**:
```
windows.ts (IPC handlers)
└── agent-setup.ts
    ├── detectClaudeCodeStatus() (claude --version, claude mcp list)
    ├── runAgentSetupAction()
    │   ├── configure/replace/remove (MCP commands)
    │   ├── install-memory (claude-memory.ts)
    │   └── install-hooks/uninstall-hooks/doctor-hooks (@open-pets/claude)
    ├── OpenCode global config management (@open-pets/opencode)
    └── Cursor global MCP config management (@open-pets/cursor)
```

**Pet Installation Flow**:
```
pet-installation.ts
├── installPet()
│   ├── getCatalogPet() → catalog.ts
│   ├── downloadPetZip() → validate ZIP magic
│   ├── extractPetZip() → yauzl with entry validation
│   └── installPetState() → app-state.ts
└── importCodexPet() → codex-pets.ts
```

**Control Center Flow**:
```
tray.ts → openControlCenterWindow(route) → windows.ts
├── hardened BrowserWindow loads Vite renderer or packaged dist/renderer/index.html
├── control-center-preload.cjs exposes page-specific APIs
├── Dashboard snapshot: default pet, catalog, plugin health, update status, activity
└── renderer/src/main.tsx routes Dashboard/Pets/Integrations/Plugins/Settings
```

**Plugin Flow**:
```
main.ts → initializePluginService(userData, defaultPluginPetApi, appVersion, ElectronPluginJsHost).start()
├── plugin-state.ts reads/writes userData/openpets-plugin-state.json
├── plugin-platform-settings.ts gates audio, voice, speech, mic, quiet hours, and AI provider choices
├── plugin-assets.ts validates/resolves declared plugin assets for SDK refs and rendered UI
├── plugin-user-sound-store.ts stores imported user sounds as plugin-scoped opaque refs
├── plugin-diagnostics.ts records plugin errors/quota/settings blocks for inspector/health UI
├── plugin-runtime.ts reloads enabled manifests
│   ├── declarative runtime schedules timer triggers
│   ├── plugin-js-host.ts starts hidden sandboxed BrowserWindow hosts for JavaScript plugins
│   └── plugin-sdk-bridge.ts dispatches namespaced SDK routes
│       ├── plugin-sdk-audio.ts/plugin-voice.ts → renderer/OS playback and speech surfaces
│       ├── plugin-sdk-bus.ts/plugin-sdk-events.ts → curated pub/sub and host event streams
│       ├── plugin-sdk-config.ts/plugin-sdk-storage.ts/plugin-sdk-state.ts → config, persistent plugin data, and subscriptions
│       ├── plugin-sdk-ui.ts/plugin-panels.ts/plugin-toast.ts → bubbles, alerts, commands, panels, and toasts
│       ├── plugin-oauth.ts/plugin-secrets.ts/plugin-ai-gateway.ts → host-mediated auth, encrypted secrets, and AI gateway
│       └── plugin-pet-api.ts/plugin-pet-registry.ts/default-pet-controller → default/spawned pet actions
├── plugin-service.ts orchestrates UI actions, permission confirmation, config validation, install/update/uninstall/load-local, and runtime reloads
└── lifecycle.ts → stopPluginService() on quit

Control Center plugins route:
tray.ts → openControlCenterWindow("plugins") → windows.ts → renderer React app
└── openpets:plugins-* IPC handlers call PluginService methods

Catalog install/update:
plugin-catalog.ts → plugin-catalog-validation.ts
└── plugin-package.ts downloads HTTPS ZIP, validates SHA-256, extracts root manifest only, and installs to userData/plugins/{id}

Local development load:
plugin-local-loader.ts validates selected folder manifest and snapshots only openpets.plugin.json to userData/plugins-dev/{id}
```

**Localization Flow**:
```
main.ts/settings → i18n.setLocaleFromPreference(system/user locale)
├── i18n/catalog.ts resolves host message dictionaries with English fallback
├── reaction-messages.ts reads localized reaction pools for pet speech
├── windows.ts exposes active messages to the Control Center renderer
└── plugin-i18n.ts resolves plugin locales, manifest $t: fields, and ctx.t(...) runtime strings
```

## Integration Points

- **Within src/**:
  - `main.ts` → all modules (orchestrator), including `ElectronPluginJsHost` for JavaScript plugins
  - `local-ipc.ts` ↔ `lease-manager.ts` ↔ `agent-pet-controller.ts`
  - `windows.ts` ↔ `app-state.ts`, `agent-setup.ts`, `catalog.ts`, `codex-pets.ts`, `update-checker.ts` for Control Center route snapshots/actions
  - `windows.ts` ↔ `plugin-service.ts` for Control Center plugin UI IPC, plugin commands, and Dashboard plugin health
  - `pet-window.ts` ↔ `default-pet-controller.ts`, `agent-pet-controller.ts`
  - `pet-window.ts` ↔ `plugin-bubble-arbiter.ts`, `plugin-pet-registry.ts`, `pet-motion-engine.ts` for plugin-driven bubbles, spawned pets, and movement updates
  - `pet-installation.ts` ↔ `app-state.ts`, `catalog.ts`, `zip-safety.ts`
  - `plugin-service.ts` ↔ `plugin-state.ts`, `plugin-runtime.ts`, `plugin-catalog.ts`, `plugin-package.ts`, `plugin-local-loader.ts`, `plugin-js-host.ts`, `plugin-sdk-bridge.ts`, plugin SDK namespace modules, diagnostics, assets, settings, panels, voice, OAuth, secrets, and user sounds
  - `i18n/` ↔ `tray.ts`, `windows.ts`, `pet-window.ts`, `reaction-messages.ts`, `plugin-i18n.ts`

- **To packages/**:
  - `@open-pets/claude`: `buildClaudeMcpPreview`, `installClaudeHooks`, `doctorClaudeHooks`, etc.
  - `@open-pets/opencode`: `prepareOpenCodeGlobalSetup`, `doctorOpenCodeGlobalSetup`
  - `@open-pets/cursor`: `planCursorMcpInstall`, `executeCursorMcpWrite`, `buildCursorRulesPreview`, etc.
  - `@open-pets/cli`: Version lookup for bundled mode
  - `@open-pets/plugin-sdk`: Published SDK contract mirrored by the desktop bridge and conformance checks

- **To System**:
  - File system: `app.getPath("userData")`, `userData/plugins/`, `userData/plugins-dev/`, plugin storage JSON, `~/.codex/pets/`, `~/.claude/`, `~/.opencode/`
  - Network: `fetch()` to openpets.dev, GitHub API, plugin catalog at `https://openpets.dev/plugins/catalog.v1.json`, plugin ZIPs restricted to `https://zip.openpets.dev/plugins/`
  - Processes: `spawn()` for `claude`, `opencode`, `node`

## Key Modules

**Core**:
- `main.ts`: Entry, single-instance lock, bootstrap sequence, JavaScript plugin host construction
- `lifecycle.ts`: App event handlers (quit, window-all-closed, second-instance) with logging; stops plugin service, IPC, and pet windows on quit
- `state.ts`: Simple shell pause state
- `app-state.ts`: Persistent JSON state with V1 schema, atomic writes, reaction animation overrides
- `app-state-core.ts`: Pet scale options, onboarding normalization
- `logger.ts`: Structured logging with scopes (app, ipc, lease, pet.default, pet.agent, pet.window, state, tray, ui), log rotation, redaction

**UI**:
- `tray.ts`: Tray icon (nativeImage), context menu builder, update status integration, route-targeted Control Center entries, logs folder
- `windows.ts`: Control Center BrowserWindow factory, Dashboard snapshot, IPC handler registration, route targeting, reaction animation settings, plugin/integration/pet/settings UI IPC endpoints, and scoped internal protocols
- `preference-patch.ts`: Pure validation of Control Center preference patches (`validatePreferencePatch`/`PreferencePatch`) for the `update-preferences` IPC path, including the `petCrossDisplayEnabled` toggle; consumed by `windows.ts`
- `assets.ts`: Tray icon loading with generated fallback
- `display.ts`: Screen geometry helpers, pet window positioning
- `window-tracker-latch.ts`: Re-entrancy latch helper (`createLatchedTick`) that prevents overlapping async ticks from stacking; used by the window-tracking poller
- `renderer/`: Vite React/Tailwind Control Center shell for Dashboard, Pets, Integrations, Plugins, and Settings.

**Pets**:
- `pet-window.ts`: Window creation (transparent, frameless, always-on-top), HTML/CSS generation, sprite animation states, speech bubbles, status badges, transient displays
- `default-pet-controller.ts`: Default pet visibility, position persistence, transient reactions, status badges, logging
- `agent-pet-controller.ts`: Lease-triggered pet windows, dismissal tracking, transient displays, status badges, logging
- `pet-motion-engine.ts`: Interpolated movement vector/tick engine for plugin-driven pet motion and target-following behavior
- `built-in-pet.ts`: Built-in pet constant
- `reaction-messages.ts`: Message pools for each reaction type
- `reaction-animation-mapping.ts`: Reaction-to-animation state mapping, user-configurable overrides, sprite state definitions
- `i18n/`: Host message catalogs and localized reaction pools; see [i18n/codemap.md](i18n/codemap.md)

**IPC**:
- `local-ipc.ts`: net.Server implementation, request routing, discovery file management, network security (loopback/private address filtering), logging
- `local-ipc-protocol.ts`: Protocol constants, request/response types, validation functions
- `local-ipc-paths.ts`: Platform-specific socket paths and discovery file locations
- `lease-manager.ts`: Lease lifecycle (acquire, heartbeat, release, cleanup), target resolution

**Installation**:
- `pet-installation.ts`: ZIP download, yauzl extraction with safety limits, pet validation
- `pet-paths.ts`: Safe path resolution for pet directories
- `codex-pets.ts`: Import from `~/.codex/pets/` with validation
- `codex-pets-core.ts`: Codex metadata validation constants
- `catalog.ts`: Remote catalog fetch with V3 pagination support, search, fixture fallback
- `catalog-validation.ts`: CatalogV2/V3 schema validation
- `zip-safety.ts`: ZIP entry path validation (traversal prevention, case collision detection)

**Plugins**:
- `plugin-manifest.ts`: Manifest V1/V2/V3 schema/types and validation for declarative and JavaScript runtimes, permissions (`timer`/`schedule`, `pet:*`, `pets:*`, `audio`, `events`, `ui:*`, `notify`, `bus`, `ai`, `secrets`, `voice:*`, `auth`, `files`, `system:*`, `clipboard`, `network:*`), config schema, timer triggers, assets, panels, entry files, and pet actions.
- `plugin-manifest-reader.ts`: Safe manifest reader with realpath/allowed-root checks, root filename enforcement, size limit, and expected id/version matching.
- `plugin-config.ts`: Config defaulting, replacement validation, and runtime resolution for string/number config references.
- `plugin-state.ts`: Persistent plugin state store (`openpets-plugin-state.json`) with atomic temp+rename writes, normalized records, approved permissions, config, source, and broken reason.
- `plugin-runtime.ts`: Runtime that compiles enabled declarative timer triggers, starts/stops JavaScript plugin hosts, verifies approved permissions, exposes public command/status state, validates actions, schedules cancellable timers, and marks broken plugins on validation/action failure.
- `plugin-pet-api.ts`: Narrow adapter from plugin actions to default pet external `say`/`react` controller calls.
- `plugin-service.ts`: Application-facing plugin orchestrator for safe snapshots, enable/disable, config save, command execution, reload, catalog install/update, local load, uninstall, permission prompts, compatibility checks, JavaScript host/SDK bridge integration, and runtime reloads.
- `plugin-catalog.ts`: Remote plugin catalog fetch with timeout, redirect rejection, response size cap, cache, and refresh support.
- `plugin-catalog-validation.ts`: Catalog V1 schema validation, duplicate id checks, semver/SHA fields, permissions canonicalization, and optional minimum OpenPets version.
- `plugin-package.ts`: Catalog plugin package download/install with HTTPS host/path allowlist, SHA-256 verification, ZIP size/entry restrictions, manifest/catalog consistency checks, and safe uninstall path resolution.
- `plugin-local-loader.ts`: Developer loader that validates a selected local folder and snapshots only the manifest into `plugins-dev` with symlink/path/size protections.
- `plugin-js-host.ts`: Sandboxed hidden BrowserWindow host for JavaScript plugin entry modules with per-plugin session partitioning, navigation/window-open hardening, SDK IPC tokening, registration handshake, config listener cleanup, and teardown.
- `plugin-sdk-bridge.ts`: Permission-checked JavaScript plugin SDK bridge that validates routes, creates plugin contexts, enforces approved permissions/quotas, and delegates namespace behavior to focused SDK modules.
- `plugin-sdk-audio.ts`: Audio SDK facade that checks global audio settings, resolves plugin/user sound refs, and reports blocked playback through diagnostics.
- `plugin-sdk-bus.ts`: Inter-plugin publish/subscribe namespace with clone-safe payload routing and plugin-scoped topic handling.
- `plugin-sdk-config.ts`: Runtime config read/change namespace backed by validated plugin config state.
- `plugin-sdk-events.ts`: Curated host event subscription namespace for pet clicks, drag/drop, display, power, idle, and config change signals.
- `plugin-sdk-quotas.ts`: Shared quota counters and limits for SDK namespaces.
- `plugin-sdk-routes.ts`: Route table and dispatch contract between preload IPC calls and host SDK handlers.
- `plugin-sdk-state.ts`: Shared plugin context state, listener cleanup, and lifecycle bookkeeping used by route handlers.
- `plugin-sdk-storage.ts`: Quota-bound plugin storage namespace with key enumeration and subscriptions.
- `plugin-sdk-types.ts`: Internal host-side SDK interfaces mirroring the published `@open-pets/plugin-sdk` contract.
- `plugin-sdk-ui.ts`: Host-rendered UI namespace for bubbles, alerts, menu items, panels, and dynamic interaction callbacks.
- `plugin-assets.ts`: Declared asset resolution and validation for icon/image/svg/sprite/sound references used by plugin SDK calls and catalog cards.
- `plugin-bubble-arbiter.ts`: Priority/coalescing arbiter for transient and pinned plugin bubble slots.
- `plugin-diagnostics.ts`: Per-plugin error/quota/settings-block collector surfaced to inspector and plugin health views.
- `plugin-events-source.ts`: Host event source adapter for pet/window/system events consumed by `plugin-sdk-events.ts`.
- `plugin-host-capabilities.ts`: Main-process capability bundle injected into the bridge for Electron side effects.
- `plugin-i18n.ts`: Plugin locale catalog loader and `$t:`/`ctx.t()` resolver with English fallback.
- `plugin-oauth.ts`: Host-mediated OAuth/PKCE flow and token session lifecycle for plugins.
- `plugin-panels.ts`: Sandboxed plugin panel BrowserWindow coordinator and message bridge.
- `plugin-pet-registry.ts`: Registry for default and plugin-spawned pets, including lifecycle and SDK targeting.
- `plugin-platform-settings.ts`: Global plugin-platform settings for audio, voice, speech, microphone, quiet hours, and provider toggles.
- `plugin-secrets.ts`: Plugin-scoped encrypted secret storage backed by Electron safe storage primitives.
- `plugin-toast.ts`: Host toast/notification routing for plugin UI events.
- `plugin-user-sound-store.ts`: Plugin-scoped imported user sound registry that stores opaque sound refs instead of raw filesystem paths.
- `plugin-voice.ts`: Voice/TTS and one-shot listen facade gated by settings and permissions.

**Agent Integration**:
- `agent-setup.ts`: Claude/OpenCode/Cursor detection, MCP configuration, hooks management, action journaling
- `claude-memory.ts`: Claude instructions file management (`~/.claude/openpets.md`)
- `update-checker.ts`: GitHub release polling, update status
- `update-version.ts`: Version parsing and comparison

**Tests** (excluded from detailed codemap coverage per repository conventions):
- Behavior tests live in `tests/*.test.ts` (compiled to `.test-dist/tests/`)
- Contract tests live in `contracts/*.contract.ts` (compiled to `.test-dist/contracts/`)
- Runtime checks (`check-*.ts`) remain in `src/` for packaging/validation (compiled to `dist/`)

## Data Flow Summary

| Source | Destination | Data |
|--------|-------------|------|
| Catalog API | `catalog.ts` | `CatalogV2/V3` JSON with pagination |
| ZIP Download | `pet-installation.ts` | Extracted to `userData/pets/{id}/` |
| `app-state.ts` | `userData/openpets-state.json` | Atomic JSON writes with reaction animation overrides |
| CLI via IPC | `local-ipc.ts` | `pet.react`, `pet.say`, `lease.*` |
| `lease-manager.ts` | `agent-pet-controller.ts` | Show/close agent pets |
| `windows.ts` | Renderer | State snapshots via IPC invoke |
| `agent-setup.ts` | Claude/OpenCode/Cursor CLI | MCP add/remove, config writes |
| All modules | `logger.ts` | Structured logs to `userData/logs/openpets.log` |
| Plugin catalog | `plugin-catalog.ts`/`plugin-service.ts` | Discoverable plugin metadata filtered by app version and install state |
| Plugin ZIP/local folder | `plugin-package.ts`/`plugin-local-loader.ts` | Validated manifest snapshot installed under `userData/plugins*` |
| `plugin-state.ts` | `userData/openpets-plugin-state.json` | Installed plugins, enabled flag, approved permissions, config, broken status |
| Control Center renderer | `control-center-preload.cjs`/`windows.ts` | Narrow Dashboard/Pets/Integrations/Plugins/Settings snapshots and route-targeted actions |
| `plugin-runtime.ts` | `plugin-pet-api.ts`/`plugin-js-host.ts`/`plugin-sdk-bridge.ts` | Declarative timers and JavaScript SDK actions on default/spawned pets, schedules, storage, commands, status, logs, network, UI, audio, events, bus, AI, OAuth, secrets, voice, and panels |
| Plugins renderer | `windows.ts`/`plugin-service.ts` | Snapshot, enable, config, command, reload, install/update/uninstall, local-load operations |
| Locale preference | `i18n/`/`plugin-i18n.ts` | Host UI dictionaries, localized reaction pools, manifest `$t:` values, and runtime `ctx.t()` strings |
| Plugin SDK asset refs | `plugin-assets.ts`/`plugin-package.ts`/`plugin-sdk-ui.ts` | Validated icons, images, SVGs, sprites, panels, and sounds rendered by host surfaces |
