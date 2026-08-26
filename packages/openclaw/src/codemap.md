# packages/openclaw/src/

## Responsibility

Source for the native OpenClaw integration package: the OpenClaw plugin entry,
payload-free activity runtime, CLI management/status contract, local SDK type
boundary, and focused package check.

## Data flow

```text
OpenClaw hook registration (`index.ts`)
    ├── model_call_started → runtime.handleModelCallStarted()
    └── before_tool_call → runtime.handleBeforeToolCall()
                              ↓
                   runtime.ts → local @open-pets/client
                              ↓
                         OpenPets default pet
```

```text
management.ts
    ├── buildOpenClawCommand()
    ├── parse/classify version, list, and inspect snapshots
    └── planOpenClawMutation()
```

## Key symbols and files

- `index.ts`: `definePluginEntry` default export, id `openpets`, startup entry,
  and package-facing management/runtime exports.
- `runtime.ts`: `createOpenPetsOpenClawRuntime`, curated thinking speech,
  `thinking`/`working` mapping, cooldowns, bounded local client, and closed
  debug codes. Hook callbacks intentionally accept no payload.
- `management.ts`: OpenClaw command specs, exact package source checks,
  `OpenClawSetupState`, inventory parsing, status classification, version support,
  and mutation planning.
- `openclaw.d.ts`: narrow declaration for `openclaw/plugin-sdk/plugin-entry`.
- `check-openclaw.ts`: package-level assertions for command shapes, state
  classification, conflict handling, postcondition planning, and payload-free
  dispatch behavior.

## Consumers

- `apps/desktop/src/agent-setup.ts` uses management commands/status for the
  Control Center setup boundary.
- `packages/cli/src/index.ts` uses management commands/status for global CLI
  setup.
- OpenClaw loads the default entry from `package.json#openclaw.extensions`.
