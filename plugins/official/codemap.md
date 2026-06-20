# plugins/official/

## Responsibility

First-party SDK v3 plugin product source. These plugins are the reviewed default/catalog lineup for OpenPets and demonstrate the current SuperPlugins direction: localized manifests, command surfaces, scheduled behaviors, host-rendered alerts/bubbles, persistent storage, and bundled asset references.

## Design/Patterns

- **Uniform Plugin Package Shape**: Every plugin folder contains `openpets.plugin.json` and `index.js`; most also provide `assets/*.svg`, `locales/*.json`, and `test.js` for deterministic SDK harness coverage.
- **Localization by Reference**: Manifests use `$t:` labels/descriptions and runtime code uses `ctx.t(key, vars)` so strings resolve through plugin `locales/en.json` with locale fallback.
- **Host-Rendered Interaction**: Plugins register right-click commands and render speech, alert, HUD, and action UI through `ctx.ui`/`ctx.pet`; the host owns validation, layout, and lifecycle.
- **Persistent Companion State**: Stateful plugins keep reminders, routines, mood history, focus sessions, and virtual-pet stats in `ctx.storage` and reconcile with schedules after restart/sleep.

## Data & Control Flow

1. `openpets.plugin.json` declares `manifestVersion: 3`, `sdkVersion`, permissions, entry file, commands/config, and asset/localization metadata.
2. The sandboxed plugin host loads `index.js` and calls the exported registration hook with the SDK context.
3. Plugin startup registers commands, schedules recurring/one-shot jobs, reads config/storage, and initializes visible state such as statuses or pinned HUD bubbles.
4. User actions from the pet context menu or bubble buttons call registered handlers, which update storage, schedule follow-up work, and ask the host to speak/react/alert.
5. Tests use `@open-pets/plugin-sdk/testing` to fake time/events and assert descriptor-level effects rather than pixels.

## Plugin Inventory

| Plugin | Primary responsibility | Main SDK surfaces |
|--------|------------------------|-------------------|
| `openpets.reminders` | Quick reminders with due/missed alert delivery, snooze/done actions, status text, optional notification/sound, and localized reminder messages. | `schedule`, `storage`, `status`, `ui.alert`, `commands`, `assets`, `config`, `notify` |
| `openpets.launch-buddy` | Launch/checklist companion for shipping moments, using scheduled prompts and command-driven progress feedback. | `schedule`, `storage`, `commands`, `pet`, `audio`, `assets`, `config` |
| `openpets.water-reminder` | Hydration reminder loop with configurable cadence and localized alerts. | `schedule`, `storage`, `commands`, `ui.alert`, `assets`, `config` |
| `openpets.focus-buddy` | Focus-session helper with timers, commands, status updates, and completion/break feedback. | `schedule`, `storage`, `status`, `commands`, `ui`, `config` |
| `openpets.magic-8-ball` | Command-driven decision/fortune response plugin with stored usage state. | `commands`, `storage`, `pet.speak` |
| `openpets.day-routine` | Daily routine nudges and scheduled check-ins. | `schedule`, `storage`, `commands`, `pet.speak`, `config` |
| `openpets.mood-check-in` | Mood logging/check-in companion with configurable prompts and command entry points. | `schedule`, `storage`, `commands`, `pet`, `config` |
| `openpets.fortune-cookie` | Periodic or command-triggered fortune messages. | `schedule`, `storage`, `commands`, `pet.speak` |
| `openpets.virtual-pet` | Tamagotchi-style companion state machine with hunger/energy/happiness/affection decay, pinned HUD, click handling, and action commands. | `events`, `schedule`, `storage`, `ui.bubble`, `commands`, `pet.react`, `assets`, `audio`, `config` |
| `openpets.spotify-buddy` | Music companion showing now-playing status, bubbles, controls, and LRCLIB synchronized lyrics. | `auth`, `storage`, `status`, `commands`, `network`, `network:write`, `ui.bubble`, `pet` |

## Integration Points

- **Desktop dev mode**: `OPENPETS_DEV_PLUGIN_ROOTS=plugins/official` lets the app hot-load these packages through the local loader.
- **Release validation**: `pnpm plugins:package` and `pnpm plugins:validate-release` package manifests, entries, assets, panels, and `locales/en.json` while checking catalog/package drift.
- **Catalog direction**: These plugins are packaged into catalog v3-compatible published artifacts; current runtime work should not optimize for legacy v2 defaults.
- **Assets/locales**: `assets/*.svg` are manifest-declared icon refs; `locales/*.json` are flat dotted-key dictionaries used by manifest `$t:` references and `ctx.t(...)`.
