# packages/openclaw/

## Responsibility

Native OpenClaw plugin package for OpenPets. It packages the OpenClaw runtime
entry, its local-only activity adapter, and the shared management/status contract
used by the desktop Control Center and the OpenPets CLI.

This is separate from OpenPets SDK v3 catalog plugins: OpenClaw installs it
through its own plugin registry and loads the native `openclaw.plugin.json`
manifest and `openclaw.extensions` package metadata.

## Design

- **Native entry**: `src/index.ts` exports the OpenClaw `definePluginEntry`
  default entry with plugin id `openpets` and startup activation metadata.
- **Payload-free hooks**: the runtime registers only `model_call_started` and
  `before_tool_call`; callbacks take no arguments and never inspect lifecycle
  payloads.
- **Local-only dispatch**: reactions use `@open-pets/client` with remote mode
  disabled, scheduled asynchronously with bounded timeouts and curated speech.
- **Management contract**: `src/management.ts` builds exact OpenClaw CLI
  commands, classifies cold inventory into explicit setup states, and plans
  install/update/enable/remove mutations without replacing conflicts.
- **Native packaging**: `package.json` exposes `dist/index.js`, ships
  `openclaw.plugin.json`, and declares the supported OpenClaw plugin API and
  minimum Gateway version.

## Flow

```text
OpenClaw Gateway
    ├── model_call_started ──┐
    └── before_tool_call ────┤
                              ▼
                    src/index.ts → src/runtime.ts
                              ▼
                       @open-pets/client
                              ▼
                    OpenPets local IPC / default pet
```

```text
Control Center or CLI
    ├── version + plugins list --json + plugins inspect openpets --json
    ├── src/management.ts status classification and mutation plan
    └── OpenClaw plugins install/enable/update/uninstall commands
```

Cold list/inspect data describes persisted inventory and manifest metadata; it
does not prove that an already-running Gateway loaded the plugin. Runtime
inspection and Gateway restart remain OpenClaw lifecycle concerns.

## Integration points

- **Dependencies**: `@open-pets/client` for local IPC and
  `@open-pets/agent-events` for curated speech; `openclaw` is an optional peer
  dependency supplying the native plugin SDK at runtime.
- **Desktop**: `apps/desktop/src/agent-setup.ts` consumes the management export
  for status, previews, command-path selection, and postcondition-checked
  actions; `windows.ts` exposes the setup snapshot/actions to the Control Center
  boundary.
- **CLI**: `packages/cli/src/index.ts` owns the global
  `configure --agent openclaw` ensure flow and post-action refresh.
- **OpenClaw package contract**: `openclaw.plugin.json` declares id `openpets`,
  startup activation, and an empty strict config schema; `package.json` points
  `openclaw.extensions` at `dist/index.js`.

## Key files

- `package.json`: package exports, optional peer dependency, native extension
  metadata, and build/check commands.
- `openclaw.plugin.json`: cold manifest metadata and configuration schema.
- `src/index.ts`: native OpenClaw entry and public exports.
- `src/runtime.ts`: exact lifecycle mapping and non-blocking local dispatch.
- `src/management.ts`: command construction, inventory parsing, status states,
  and mutation planning.
- `src/openclaw.d.ts`: narrow local type declaration for the supported SDK entry
  helper and hook registration contract.
- `src/check-openclaw.ts`: focused package contract validation.
