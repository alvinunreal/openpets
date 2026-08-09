# apps/desktop/

## Responsibility

OpenPets desktop companion application. Tray-first Electron app providing animated desktop pets that react to coding agent events. Manages pet installations, the React/Tailwind Control Center, plugin automation/runtime, agent integrations (Claude Code, OpenCode, Cursor, Pi guidance), and local IPC for CLI communication.

## Design

- **Tray-First UX**: No default main window; tray actions open the singleton React/Tailwind Control Center and route directly to Dashboard, Pets, Integrations, Plugins, and Settings.
- **Single Instance**: Uses `app.requestSingleInstanceLock()` with second-instance focusing
- **Security Model**: 
  - Sandboxed renderers with contextIsolation
  - Preload scripts expose limited APIs via `contextBridge`
  - CSP: `default-src 'none'`, inline styles only
  - Mock keychain to prevent OS credential prompts
  - IPC network security: loopback/private address filtering for TCP mode
- **State Management**: File-based JSON state with atomic writes (temp + rename)
- **Pet Architecture**: 
  - Default pet (always visible when enabled)
  - Agent pets (lease-based, appear on explicit agent requests)
  - Built-in fallback pet (bundled spritesheet)
  - Speech bubbles with reaction messages and status badges
  - User-configurable reaction-to-animation mapping
- **Lease Manager**: 15s TTL leases for agent pet routing with heartbeat renewal
- **Logging**: Structured logging with scopes, log rotation (2MB max), and sensitive data redaction
- **Plugin Subsystem**: Declarative manifest plugins and JavaScript plugin hosting with permission approval, config schemas, command/status surfaces, catalog/local installs, SDK bridge quotas, storage, schedules, restricted HTTPS fetch, and safe path/ZIP/manifest validation

## Flow

**Startup**: `main.ts` → `installAppLifecycle()` → `initializeAppState()` → `initializeLogger()` → `createAppTray()` → `startLocalIpcServer()` → initialize plugin service with JavaScript host/SDK bridge → optionally `showDefaultPet()`

**Pet Display**: IPC Request → `local-ipc.ts` → `LeaseManager.acquire()` → `agent-pet-controller.ts` → `pet-window.ts` → HTML/CSS spritesheet animation with reaction-to-animation mapping

**Installation**: Catalog fetch (V3 with pagination fallback to V2) → ZIP download → `yauzl` extraction → validation → state update → tray refresh

**Agent Setup**: UI → `agent-setup.ts` → Claude/OpenCode/Cursor CLI detection → MCP config modification → hooks installation → memory file management

**Control Center**: Tray route → `openControlCenterWindow(route)` → `windows.ts` loads Vite renderer and sends route events → `control-center-preload.cjs` exposes narrow page APIs → React Dashboard/Pets/Integrations/Plugins/Settings routes render snapshots and invoke actions.

**Plugins**: Control Center plugins route → `plugin-service.ts` → catalog or local manifest/entry loader → permission approval/state update → `plugin-runtime.ts` schedules declarative timers or starts `plugin-js-host.ts` → `plugin-sdk-bridge.ts` applies approved SDK calls to pet/schedule/storage/command/status/network APIs

## Integration Points

- **Workspace Packages**: `@open-pets/agent-events`, `@open-pets/claude`, `@open-pets/cli`, `@open-pets/cursor`, `@open-pets/mcp`, `@open-pets/opencode`
- **External Services**: 
  - `https://openpets.dev/pets/catalog.v2.json` (pet catalog V2)
  - `https://openpets.dev/pets/catalog.v3.json` (pet catalog V3 with pagination)
  - `https://openpets.dev/plugins/catalog.v1.json` (plugin catalog V1)
  - `https://zip.openpets.dev/pets/{id}.zip` (pet downloads)
  - `https://zip.openpets.dev/plugins/{id}.zip` (plugin downloads)
  - GitHub API (release checks)
- **System Integration**:
  - Claude Code: `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, `claude mcp` commands
  - OpenCode: `~/.opencode/config.json`
  - Cursor: `~/.cursor/mcp.json`, `.cursor/rules/openpets.mdc`
  - Codex: `~/.codex/pets/` (local pet development)
  - IPC: Discovery file at platform-specific path, Unix socket/Windows named pipe/TCP
  - Logs: `userData/logs/openpets.log`
- **Build**: `electron-builder` with ASAR, cross-platform (macOS/Windows/Linux)

## Key Files

- `main.ts`: Entry point, lifecycle coordination
- `tray.ts`: System tray icon and menu
- `windows.ts`: Control Center BrowserWindow management, Dashboard snapshot, route targeting, IPC handlers, and internal protocols
- `renderer/`: React/Tailwind Control Center for Dashboard, Pets, Integrations, Plugins, and Settings
- `local-ipc.ts`: TCP/Unix socket server for CLI communication
- `lease-manager.ts`: Pet routing lease lifecycle
- `pet-window.ts`: Pet rendering (transparent frameless windows, CSS sprite animation, speech bubbles, status badges)
- `default-pet-controller.ts`/`agent-pet-controller.ts`: Pet visibility/state management with transient displays; `reclampAllLivePetWindows()` re-clamps all live pet windows on topology changes
- `pet-roaming-controller.ts`: Host-side roaming orchestrator — registers every live pet (default + agent) with the motion engine and applies the active physics configuration (gravity + bounce). Unregisters before window destroy to prevent the shared ticker from touching closed windows.
- `pet-motion-engine.ts`: Shared-ticker motion engine (~60 fps) — `Map<petHandleId, MotionState>`, single `setInterval` for all pets, sub-pixel fractional accumulators, bottom-center gravity-floor anchor, `registerPet`/`unregisterPet` seams, sole continuous position writer.
- `display.ts`: Screen-geometry helpers — `getDefaultPetInitialPosition`, `clampToVisibleWorkArea` (legacy single-display), `clampToNearestDisplayIfOffscreen` (permissive multi-display), `isOnAnyDisplay`, `setCrossDisplayRoamingEnabled`/`isCrossDisplayRoamingEnabled` flag; display list cache with `invalidateDisplayCache()`
- `app-state.ts`: Persistent state management (JSON file)
- `agent-setup.ts`: Claude/OpenCode/Cursor integration logic
- `plugin-service.ts`: Plugin orchestration for snapshots, enable/config/reload, command execution, catalog install/update/uninstall, local loading, permission approval, JavaScript host wiring, and runtime reloads
- `plugin-manifest.ts`: `openpets.plugin.json` v1/v2 schema/types/validator for declarative timer plugins and JavaScript SDK plugins, config fields, permissions, commands/status/network, and actions
- `plugin-runtime.ts`: Runtime that compiles enabled declarative timers and starts JavaScript plugin hosts for approved pet/schedule/storage/command/status/network actions
- `plugin-state.ts`: Atomic JSON state store for installed plugins, enabled flag, approved permissions, config, broken state, and update metadata
- `plugin-config.ts`: Plugin default/effective config validation and config reference resolution
- `plugin-catalog.ts`/`plugin-catalog-validation.ts`: Plugin catalog fetch/cache and strict catalog entry validation
- `plugin-package.ts`: Catalog plugin ZIP download, SHA-256 verification, manifest extraction, install, and safe uninstall path resolution
- `plugin-local-loader.ts`: Local developer plugin folder validation and manifest snapshotting into app data
- `plugin-manifest-reader.ts`: Safe installed-manifest reader enforcing allowed roots, size limits, path containment, and expected id/version
- `plugin-pet-api.ts`: Runtime bridge from plugin actions to default pet speech/reaction APIs
- `plugin-js-host.ts`: Hidden sandboxed BrowserWindow host for JavaScript plugin entry modules, SDK IPC tokening, session hardening, startup handshake, and teardown
- `plugin-sdk-bridge.ts`: Permission-checked SDK API for JavaScript plugins with quotas, plugin storage, schedules, config listeners, commands/status, logs, and restricted HTTPS fetch
- `plugin-voice.ts` plus `voice-capture*.ts`, `voice-listening-service.ts`, and `voice-privacy-indicator*.ts`: Host-owned one-shot voice capture, transcription bounds, privacy state, and teardown cleanup
- `pet-installation.ts`: Catalog ZIP download and extraction
- `codex-pets.ts`: Local Codex pet import
- `catalog.ts`: Remote catalog fetching with V3 pagination and fixture fallback
- `logger.ts`: Structured logging with scopes (app, ipc, lease, pet, state, tray, ui)
- `reaction-animation-mapping.ts`: Reaction-to-animation state mapping with user overrides
- `reaction-messages.ts`: Message pools for each reaction type
- `control-center-preload.cjs`/`pet-preload.cjs`/`plugin-sdk-preload.cjs`: Narrow contextBridge APIs for the Control Center, pet windows, and plugin SDK host; the legacy `preload.cjs` task-window bridge and `plugins-window.ts` UI have been removed
- `electron-builder.yml`: Packaging configuration
- `scripts/release-local.mjs`: macOS-local release automation as resumable checkpointed stages, with GitHub draft creation
- `contracts/catalog-fixture.contract.ts`: Catalog V2 validation contract tests against fixture data
- `contracts/local-ipc-protocol.contract.ts`: IPC protocol validation contract tests for request/response parsing
- `contracts/plugin-manifest.contract.ts`: Plugin manifest boundary contract for v1 schema, config references, permissions, deferred features, and action validation

## Test Structure

- **Behavior tests** (`tests/*.test.ts`): Unit tests for lease manager (incl. PID liveness + pool toggle), state management, version checking, ZIP safety, Codex pets, Claude memory, reaction animation mapping, plugin bridge/gateway guards, bounded voice capture lifecycle (`voice-lifecycle.test.ts`), display geometry helpers (`display.test.ts`), pet motion-engine clamping and shared-ticker (`pet-motion-engine-clamp.test.ts`, `pet-motion-engine-shared-ticker.test.ts`), gravity seam (`pet-motion-engine-gravity-seam.test.ts`), single-writer invariant (`pet-motion-engine-single-writer.test.ts`), roaming controller (`pet-roaming-controller.test.ts`), and pool toggle (`pool-toggle.test.ts`). Compiled to `.test-dist/tests/`.
- **Contract tests** (`contracts/*.contract.ts`): Public API boundary validation for catalog fixtures, IPC protocol, and plugin manifest schema. Compiled to `.test-dist/contracts/`.
- **Runtime checks** (`src/check-*.ts`): Remaining runtime validation checks compiled to `dist/`.
- **Test runner** (`scripts/run-tests.mjs`): Orchestrates preload syntax checks → test compilation → behavior tests → contract tests → dist checks.
