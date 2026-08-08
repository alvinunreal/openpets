---
description: Understand the OpenPets plugin manifest, permissions, runtime sandbox, install paths, authoring workflow, and catalog release validation.
---

# Plugin platform

OpenPets plugins are small companion programs that extend the pet: reminders,
focus timers, a Tamagotchi-style virtual pet, GitHub notifications, and so on.
This doc is the platform architecture - the manifest contract, the permission
model, the runtime and sandbox, install paths, and packaging/publishing. For the
*author-facing* API see [Plugin SDK v3](/sdk); for the reviewed catalog lineup,
bundling defaults, and companion behavior rules see
[Official plugins](/official-plugins).

This doc is required reading before changing plugin platform code, official
plugins, catalog generation, packaging, runtime behavior, or plugin-facing UI
(per `AGENTS.md`). When you change behavior, update this doc in the same change.

Source maps: `apps/desktop/src/codemap.md` (the `plugin-*.ts` modules),
`plugins/codemap.md`, `plugins/official/codemap.md`, `packages/sdk/codemap.md`.

## Source lanes

Plugin source is split by publishing intent:

- `plugins/official/` - first-party, reviewed OpenPets plugins. Only these can be
  bundled or enabled by default.
- `plugins/community/` - public catalog plugins that are reviewed and shipped
  through the same ZIP/SHA/catalog pipeline, but are labeled `publisherType:
  "community"` and cannot be bundled.
- `plugins/dev/` - local experiments only. The catalog generator ignores this
  lane; move a plugin to `community/` or `official/` before publishing.

## Mental model

A plugin is a **package** validated by a **manifest**, run inside a **sandbox**,
talking to the host only through a **permission-checked SDK bridge**. The host
owns every side effect - the plugin only *describes* what it wants (a bubble, an
alert, a scheduled job, a stored value), and the host validates and renders it.
This is the "companion-first" stance: plugins never inject UI into pet windows
directly; they hand the host descriptors and the host owns layout and lifecycle.

```
openpets.plugin.json ──validate──▶ plugin-service ──▶ plugin-runtime
                                                          │
                              ┌───────────────────────────┤
                              ▼                            ▼
                    declarative timers           plugin-js-host (sandbox)
                              │                            │  SDK calls (IPC, tokened)
                              └────────────┬───────────────┘
                                           ▼
                                  plugin-sdk-bridge
                          (permission + quota checks, then dispatch)
                                           ▼
              pet · schedule · storage · ui · audio · events · bus · ai · …
```

## The manifest - `openpets.plugin.json`

The manifest is the contract the host validates before *any* plugin code runs
(`plugin-manifest.ts`, schema versions v1/v2/v3). Current plugins are
`manifestVersion: 3` / `sdkVersion: 3.x`. Key fields:

- `manifestVersion`, `id` (e.g. `openpets.reminders`), `name`, `description`,
  `version`, `sdkVersion`.
- `runtime`: `javascript` for SDK plugins (declarative timer-only plugins also
  exist for the simplest cases).
- `entry`: the JS entry file (e.g. `index.js`).
- `permissions`: the capabilities the plugin requests (see below).
- `configSchema`: typed config fields rendered as a no-JSON settings form.
  Fields include text, number, boolean, select, time, date, secret, and sound;
  a select can opt into the host's `sprite-grid` presentation when every option
  references a declared sprite preview.
- `assets`: declared icon/image/svg/sprite/sound refs (validated, see below).
- `commands`, `status`, `panels`, `network` hosts, and timer triggers as
  applicable.
- Localization: `name`/`description`/labels can be `$t:` keys resolved from
  `locales/en.json` (see [Internationalization](/i18n)).

`name`/`description`/labels in the manifest use `$t:` references; the catalog
generator and release validator fail if those don't resolve.

Catalog card icons can use bundled SVG assets. A plugin declares the SVG under
`assets.icons` (for example `"assets": { "icons": { "spotify":
"assets/spotify.svg" } }`); the packaging flow sanitizes the SVG and embeds it
as catalog `iconDataUrl`. Do **not** use external SVG URLs for plugin icons - the
icon must be part of the reviewed, hash-pinned package.

### Sprite-grid configuration

`sprite-grid` is a presentation for a `select` config field, not a general
renderer surface. Each option names a manifest-declared sprite as its preview;
manifest validation rejects undeclared previews. The Control Center renders
those choices as accessible radio cards, with animation only for the selected,
hovered, or keyboard-focused card. `prefers-reduced-motion` keeps the first frame
static.

Calendar Airmail uses this for its courier choice. The couriers are bundled
plugin assets, not installed pets: changing the selection never reads the pet
catalog, changes the default pet, or depends on a user-installed companion.

### Manifest reading is hardened

`plugin-manifest-reader.ts` enforces realpath/allowed-root checks, requires the
manifest to be the root file, caps size, and matches the expected id/version.
The manifest is never trusted blindly.

## Permission model

Permissions are declared in the manifest, **approved** by the user at install,
persisted in plugin state, and **re-checked on every SDK call** by the bridge.
The permission surface (from `plugin-manifest.ts`):

`timer`/`schedule`, `pet:*`, `pets:*`, `audio`, `events`, `ui:*`, `notify`,
`bus`, `ai`, `secrets`, `voice:*`, `auth`, `files`, `system:*`, `clipboard`,
`network:*`.

A plugin that calls a namespace it didn't declare (or wasn't approved for) is
denied and the block is recorded in diagnostics. `network:*` is further
constrained to declared hosts. This is defense in depth: manifest validation,
user approval, runtime permission check, and quotas all apply.

Network access is gated per call by the **intersection** of manifest-declared
permissions and the user's persisted approvals. A stale approval never grants a
capability the current manifest no longer declares.

- Canonical v3 API is `ctx.net.fetch` / `ctx.net.stream`. Hosts must appear in
  both `manifest.network.hosts` and the approved host list. Exact `host:port`
  entries match only that port. A bare hostname approval covers **only** the
  scheme default port (443 for HTTPS, 80 for HTTP) - never an explicit
  non-default port, and never a later `host:port` addition without fresh approval.
- `network` covers HTTPS GET to approved **public** hosts (public-host / private-IP
  checks still apply). Non-GET methods require `network:write` on `ctx.net` only.
- `network:local` is **additive**: it also allows declared loopback/private HTTP
  endpoints on `ctx.net` while public HTTPS hosts in the same manifest keep the
  normal public-host path. Local targets require explicit local IPs/`localhost`
  (DNS-rebinding defense); cloud-metadata addresses stay blocked.
- Legacy `ctx.http.fetch` remains GET-only, public HTTPS only - it never gains
  local or mutating access.

### Host AI providers

The host AI gateway uses one provider configured in OpenPets settings for plugin
chat requests. Supported providers are Anthropic, OpenAI, Ollama, and MiniMax.
Anthropic uses its native chat API; OpenAI, Ollama, and MiniMax use
OpenAI-compatible chat-completions APIs. All four support token streaming.

Voice input through `voice.listen` is a separate capability and uses the host's
OpenAI-compatible transcription path. OpenAI and Ollama support that path, while
MiniMax's configured OpenAI-compatible API does not accept audio input/transcription,
so it cannot be used for `voice.listen`. Anthropic is not transcription-capable
through this path. MiniMax supports OpenAI-compatible chat completions and
streaming; choose OpenAI or Ollama when a plugin needs `voice.listen`.

`voice.listen` is one-shot push-to-talk, never ambient. The host captures in a
hidden, isolated microphone window and displays **OpenPets is listening** only after
microphone acquisition succeeds. It accepts only one active capture, clamps the
recording duration to 1-30 seconds, times microphone acquisition out after 15
seconds, and bounds transcription separately at 30 seconds. The host can cancel
during acquisition, recording, or transcription; cancellation stops media tracks,
aborts transcription, closes the capture window, clears temporary session data,
and prevents late renderer events from reviving the request. Whitespace-only
transcripts fail with `Voice transcription returned no text.`
The host-owned tray menu provides **Stop microphone listening** during
acquisition/recording and **Cancel transcription** while transcription is
pending; cancellation is not a public plugin SDK method.

### Display deliveries

`ui:delivery` is a dedicated permission for the generic, host-owned delivery
surface. It lets a plugin request a short, plain-text delivery with one of its
own declared courier sprites; it is not permission to position windows, inject
markup, select arbitrary files, or control animation. The host chooses the cursor
display, renders the courier and banner together, queues competing deliveries,
enforces expiry and quotas, and owns the window lifecycle. The returned handle
can be dismissed and can observe `click`, `manual`, `expired`, or
`plugin-stopped` dismissal. Plugin teardown
removes that plugin's pending and active deliveries without calling handlers in
the stopped host. See [Plugin SDK v3](/sdk) for the author contract.

This surface is intended for time-sensitive companion messages such as Calendar
Airmail, not as a general custom-overlay API.

## Runtime & sandbox

`plugin-runtime.ts` is the engine:

- Compiles **declarative timer triggers** for enabled manifests and schedules
  cancellable timers.
- Starts/stops a **JavaScript host** per JS plugin and verifies approved
  permissions before dispatching actions.
- Exposes public **command/status** state to the UI, validates actions, and
  **marks a plugin broken** on validation/action failure (surfaced in the
  inspector/health UI).

`plugin-js-host.ts` is the sandbox: a hidden `BrowserWindow` with a per-plugin
session partition, navigation/window-open hardening, an SDK IPC **token**, a
registration handshake at startup, config-listener cleanup, and teardown. The
plugin's `index.js` runs here, isolated from the renderer and the main process.

`plugin-sdk-bridge.ts` is the gate between the sandbox and the host. It
validates routes, builds the per-plugin context, enforces permissions + quotas,
and delegates to focused namespace modules (`plugin-sdk-audio`, `-bus`,
`-config`, `-events`, `-quotas`, `-routes`, `-state`, `-storage`, `-ui`, plus
`plugin-voice`, `plugin-oauth`, `plugin-secrets`, `plugin-ai-gateway`,
`plugin-panels`, `plugin-pet-api`/`plugin-pet-registry`). The split keeps each
capability's permission check and host effect localized. The author-facing
mirror of all this is the SDK in [Plugin SDK v3](/sdk).

### Supporting modules

- `plugin-state.ts` - atomic JSON store (`userData/openpets-plugin-state.json`):
  installed plugins, enabled flag, approved permissions, config, source, broken
  reason, update metadata.
- `plugin-config.ts` - default/effective config validation and reference
  resolution.
- `plugin-assets.ts` - validates/resolves declared assets (formats + size caps)
  for SDK refs and catalog cards. Courier sprites are WebP strips with bounded,
  declared frame metadata; their dimensions are checked at package/install time.
- `plugin-bubble-arbiter.ts` - priority/coalescing of transient vs pinned bubble
  slots.
- `plugin-diagnostics.ts` - per-plugin error/quota/settings-block collector for
  the inspector and health UI.
- `plugin-platform-settings.ts` - global gates for audio, voice, speech,
  microphone, quiet hours, and AI provider choices.
- `plugin-voice.ts` + `voice-listening-service.ts` - the plugin-facing one-shot
  facade and host-owned transcription/cancellation lifecycle.
- `voice-capture.ts` + `voice-capture-electron.ts` - bounded capture state and
  the temporary Electron microphone session.
- `voice-capture-cancellation.ts` - idempotent renderer-cancel/window-destroy
  ordering.
- `voice-operation-state.ts` - internal tray cancellation state and phase tracking.
- `voice-privacy-indicator-electron.ts` - the host-owned listening indicator.
- `plugin-user-sound-store.ts` - stores imported user sounds as opaque refs, not
  raw filesystem paths.
- `plugin-i18n.ts` - resolves plugin locales, manifest `$t:`, and `ctx.t()`.

## Install paths

### Catalog install

`plugin-catalog.ts` fetches the active plugin catalog (v2; see
[Catalogs](/catalog)) with timeout, redirect rejection, size cap, and cache.
`plugin-catalog-validation.ts` validates the catalog strictly. `plugin-package.ts`
downloads the ZIP from `zip.openpets.dev/plugins/`, **verifies SHA-256**,
restricts ZIP size/entries, extracts the **root manifest only**, checks
manifest↔catalog consistency, and installs to `userData/plugins/{id}`. It also
owns safe uninstall path resolution.

### Local development

`plugin-local-loader.ts` validates a selected local folder and snapshots the
manifest, entry file, and declared assets into `userData/plugins-dev/{id}`, with
symlink/path/size protections. In the installed desktop app, authors use
**Plugins → Developer Mode → Load unpacked plugin folder**; OpenPets persists the
original source folder, watches it, and re-snapshots/reloads after edits. The
repo dev build still supports maintainer-only env paths with
`OPENPETS_DEV_PLUGIN_ROOTS` / `OPENPETS_DEV_PLUGIN_PATHS` and
`pnpm dev:desktop:plugins`. See [Development](/development).

## Authoring workflow (end to end)

1. **Scaffold**: `openpets plugin new <name> --template <blank|reminder|ambient|ai-chat|tamagotchi|calendar>`
   generates a `manifestVersion: 3` package with `index.js`, `test.js`, README,
   and `locales/en.json`. (`packages/cli/src/plugin-templates.ts`.)
2. **Develop**: write against the SDK ([Plugin SDK v3](/sdk)); hot-load via dev mode.
3. **Test**: `test.js` uses `@open-pets/plugin-sdk/testing` to fake time/events
   and assert descriptor-level effects - no Electron. See [Plugin SDK v3](/sdk).
4. **Validate**: `openpets plugin validate <dir>` checks manifest, permissions,
   SDK compatibility, config field types, network hosts, asset formats/size
   caps, entry files, and HTML panels. (`packages/cli/src/plugin-validate.ts`.)
5. **Package & publish**: see below.

Official plugins are the best worked examples for this workflow. Calendar
Airmail demonstrates OAuth, network allowlists, scheduled work, durable plugin
storage, status rows, and the host-owned `ui:delivery` surface; Quick Reminders
demonstrates reminder state, snooze/done actions, optional notifications, and
sound assets. See [Official plugins](/official-plugins) for the current
reviewed lineup.

## Packaging, catalog & release validation

The release path is gated by the validators in
[Testing and validation](/testing-and-validation), with maintainer release
steps in [Release guide](/release). The command surface (run from repo root):

| Command | Purpose |
|---------|---------|
| `pnpm plugins:check` | Validate the package plan (dry-run, no writes) |
| `pnpm plugins:package` | Write local catalog files + ZIP staging (no R2 upload) |
| `pnpm plugins:validate-release` | **Release gate** - catch production-breaking mistakes before shipping |
| `pnpm plugins:publish` | Generate + upload ZIPs to R2 |
| `pnpm plugins:validate-live` | Post-deploy validation against the live catalog |
| `pnpm plugins:deploy` | Deploy the web catalog |
| `pnpm plugins:release` | Full package → validate → publish → deploy → live-validate sequence |
| `pnpm plugins:test` | Run plugin locale checks + official/community plugin harness tests |

The release validator exists to catch exactly the production-breakers
`plugins:check` alone misses: unresolved `$t:` names/descriptions in catalog
cards, missing ZIPs, SHA mismatches, missing `locales/en.json`, missing declared
assets/entry files, and catalog/package drift. **Always run it before shipping a
plugin release.**

`plugins:package` and `plugins:publish` read both `plugins/official/` and
`plugins/community/`. Catalog v2 entries include `publisherType` so the app and
site can distinguish reviewed first-party plugins from community submissions.
Community plugins follow the same release validation but cannot set `bundled`.

### Community plugin provenance, pending submissions, and owner safe updates

To lock down the integrity and security of community-submitted plugins without
modifying the app-facing `catalog.v2.json` schema, OpenPets uses website-only
sidecars:

- `web/public/plugins/provenance.json` - reviewed provenance for installable
  community plugins.
- `web/public/plugins/submissions.json` - pending external GitHub submissions
  shown on the website but not installable yet.

`provenance.json` maps plugin IDs to their verified upstream metadata:
- `publisher`: The GitHub username or organization owning the plugin.
- `sourceUrl`: The canonical upstream GitHub repository URL.
- `sourceSubdirectory`: Subdirectory in the repository containing the plugin manifest and files (if applicable).
- `sourceCommit`: The specific git commit SHA that was reviewed and approved.
- `reviewedAt`: ISO date when the current version/commit was reviewed.
- `updatePolicy`: Can be `safe-auto` (safe for automated publishing of owner updates) or `manual-review` (always requires manual PR review).

Pending entries in `submissions.json` are candidates only. They must not appear
in the installable catalog until promoted into `plugins/community/`, packaged,
uploaded to R2, and release-validated.

Plugin owners can publish updates to their plugins without needing a manual PR to the main OpenPets repository. They do this by tag-publishing new releases on their immutable GitHub repository. OpenPets automation periodically validates updates against the following safety rules:
1. **Repository & Publisher Match**: The release must originate from the same owner, repository, and plugin ID registered in `provenance.json`.
2. **Version Increase**: The release version must be a clean semver increase.
3. **No New Permissions/Capabilities**: The update must not request any new `permissions`, new `network.hosts`, new private local API/privileged capabilities, or changes to publisher configuration.
4. **All Tests Pass**: The package must pass all validation gates (manifest, SDK compatibility, locales check, ZIP and SHA matches).

If an update is determined to be **safe**, OpenPets CI/CD automation automatically updates the catalog entry version and re-packages the plugin. If any safety boundary is crossed, the update triggers a `manual-review` block and requires a maintainer to inspect and merge the change.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Plugin marked "broken" | Manifest/action validation failed - check `plugin-diagnostics` / the inspector |
| SDK call silently does nothing | Permission not declared or not approved; or blocked by a global platform setting (audio/voice/quiet hours) |
| Network call rejected | Host not in declared `network` hosts |
| Catalog card shows raw `$t:...` | Missing locale key - `validate-release` should have caught it |
| ZIP install fails | SHA mismatch, non-HTTPS/disallowed host, or oversized/invalid ZIP entries |
| Local plugin won't load | Local loader rejected the folder (symlink/path/size) or manifest isn't at root |
| Icon/image missing | Asset not declared in `assets`, wrong format, or over size cap |

## Where to look first

| Concern | File |
|---------|------|
| Manifest schema/validation | `plugin-manifest.ts`, `plugin-manifest-reader.ts` |
| Orchestration / UI actions | `plugin-service.ts` |
| Runtime / scheduling / broken-state | `plugin-runtime.ts` |
| Sandbox host | `plugin-js-host.ts` |
| Permission + dispatch | `plugin-sdk-bridge.ts` + `plugin-sdk-*.ts` |
| Catalog install/verify | `plugin-catalog.ts`, `plugin-package.ts` |
| Local dev load | `plugin-local-loader.ts` |
| Official plugin examples | `plugins/official/*` |
