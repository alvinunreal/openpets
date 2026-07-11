## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.

## Documentation Map

`docs/` holds the maintained, conceptual documentation — the narrative layer on
top of the codemaps. It explains concepts and contracts and points at the files
that own each behavior (it deliberately avoids pasting code, which rots). Start
at `docs/README.md`, then read the doc for the area you're touching:

- **`docs/architecture.md`** — system overview, runtime topology, package spine,
  end-to-end flows, cross-cutting invariants, glossary. Read first.
- **`docs/desktop.md`** — the Electron app: process model, tray/Control Center,
  windows, app state, lifecycle, security, logging, CSP.
- **`docs/ipc.md`** — local IPC protocol + `@open-pets/client`: discovery,
  transports, the lease model, request surface, security.
- **`docs/pets.md`** — pet model, reactions→animations→speech, installation,
  Codex pets, motion.
- **`docs/catalog.md`** — pet/plugin catalog contracts (v3/v2), pagination,
  search, R2 ZIP hosting, and how the app consumes them.
- **`docs/agent-integrations.md`** — Claude/MCP/OpenCode/Cursor/Pi + the CLI.
- **`docs/plugins.md`** — plugin platform: manifest, permissions, runtime,
  sandbox, install paths, packaging/publishing, troubleshooting.
- **`docs/superplugins.md`** — companion-first direction, official lineup,
  bundling/enabled defaults, right-click action strategy.
- **`docs/sdk.md`** — public SDK v3 contract + the deterministic test harness.
- **`docs/i18n.md`** — translations across host UI, reaction speech, and plugins.
- **`docs/development.md`** — DX: layout, command surface, dev modes, releases.
- **`docs/testing-and-validation.md`** — tests, contracts, release validators,
  catalog verification, and what "production-valid" means before shipping.

When you change behavior, update the matching `docs/*.md` in the same change.
Ongoing improvement ideas / known issues are tracked in the root `improvements.md`.

## Tests Must Protect Behavior

Tests are evidence of a user-visible behavior, public contract, or a plausible
regression—not a record of the implementation that happened to be written.

- Before adding a test, state the bug or contract it would catch. If there is
  no concrete answer, do not add it.
- Prefer a small assertion of the observable outcome over exact internal calls,
  helper sequencing, incidental data shapes, generated asset/source mappings,
  arbitrary versions/counts, or full wording snapshots.
- Do not test private implementation details merely to increase coverage.
  Test assets only when their format or integrity is itself a shipped contract.
- Keep one behavior-focused purpose per test. Remove no-op assertions,
  duplicate coverage, and brittle snapshots/regexes that fail on harmless
  refactors or copy changes.
- When fixing a bug, add the narrowest regression test that fails without the
  fix. When reviewing existing tests, delete or rewrite tests that do not
  protect a plausible failure mode.

## Catalog Direction

Catalog v2 is legacy and exists only for old app versions/fallback compatibility.
For new work, migrations, and Control Center UI, do not optimize for v2 behavior.
Use catalog v3 (`thumbnail`, `spritesheet`, paginated pages, and search index) as the source of truth.

See `docs/catalog.md` for the v3/v2 contracts, pagination/search, ZIP hosting, and how the app consumes them.

## Forward-Only Product Direction

Move the current app forward; do not keep legacy compatibility code, duplicate
paths, stale shims, or old behavior in current runtime code unless it is required
so older released app versions can still open/use versioned catalogs or existing
published data. Prefer clean migrations, versioned catalog/data boundaries, and
removing obsolete code over preserving backwards-compatible branches. The bar is:
old app versions should not break catastrophically, but the current app should
not carry legacy bloat for deprecated plugin/catalog behavior.

## Plugin Docs

Before changing plugin platform code, official plugins, plugin catalog generation, plugin packaging, plugin runtime behavior, or plugin-facing UI, read:
- `docs/plugins.md` for the current plugin platform architecture, manifest/runtime rules, local development workflow, publishing commands, and troubleshooting notes.
- `docs/superplugins.md` for the companion-first plugin direction, planned official plugin lineup, bundling defaults, and right-click plugin action strategy.

When plugin work is finished, update these docs if behavior, commands, manifests, plugin IDs, default bundled/enabled status, catalog workflow, permissions, or the planned plugin lineup changed. Do not leave plugin docs stale after implementation.

For plugin release/catalog work, run the release validator before shipping:
- `pnpm plugins:package`
- `pnpm plugins:validate-release`
- after deploy/R2 upload, `pnpm plugins:validate-live`

The validator exists to catch production-breaking plugin mistakes: unresolved
`$t:` names/descriptions in catalog cards, missing plugin ZIPs, SHA mismatches,
missing `locales/en.json`, missing declared assets/entry files, and catalog/package
drift. Do not rely on `plugins:check` alone for release readiness.

See `docs/testing-and-validation.md` for the full quality ladder and what "production-valid" means per change type.

## Logging for Fast DX

When working on desktop UI, renderer, IPC, catalog, plugin, or pet-window behavior, add targeted logging as part of the implementation when it helps diagnose issues quickly.
Prefer concise, scoped logs that capture data shape, selected IDs, load/error states, and boundary decisions.
Route renderer diagnostics into the app log when possible so failures are visible in `openpets.log`, not only DevTools.
Avoid noisy permanent logs, secrets, full payload dumps, or logging in tight animation/render loops.

See `docs/development.md` (DX) and `docs/desktop.md` (logging subsystem and scopes).

## Control Center CSP

When adding any renderer-visible URL scheme, image source, dev server endpoint, or internal protocol, update the Control Center CSP in both `apps/desktop/vite.config.ts` and `apps/desktop/src/renderer/index.html`.
Common pet image protocols include `openpets-codex:`, `openpets-installed:`, and `openpets-pet-preview:`; forgetting CSP causes images to load as the default/fallback pet even when install/render logic is correct.

See `docs/desktop.md` (security model) and `docs/pets.md` (image protocols).

## Ubuntu VMware Testing

An Ubuntu 24.04 ARM64 VMware/Vagrant development VM exists for Linux GUI testing. See `/Volumes/external/repos/vagrants.md` for the host-side VM inventory and commands.

- VM directory: `/Volumes/external/vmware/ubuntu24`
- Provider: `vmware_desktop` / VMware Fusion on Apple Silicon
- Guest OpenPets checkout: `/home/vagrant/src/openpets`
- Guest helper aliases: `cdpets` and `openpets-dx`

Do not mount the macOS OpenPets checkout into Ubuntu for development. The macOS `node_modules` tree contains platform-specific packages and ownership metadata; using it from Linux can break local macOS development. Ubuntu testing should use the isolated guest clone and its own Linux `node_modules`.

For Linux GUI bug reproduction or Electron desktop testing:

1. Start or inspect the VM from `/Volumes/external/vmware/ubuntu24` with `vagrant up` / `vagrant status`.
2. SSH with `vagrant ssh`.
3. In the guest, run `cdpets` then `openpets-dx` to update dependencies, fix Electron sandbox permissions, and launch OpenPets in the Ubuntu desktop session.
4. Check guest logs at `~/.config/@open-pets/desktop/logs/openpets.log`.

The VM is configured to boot into the Ubuntu desktop (`graphical.target`) with GDM auto-login for the `vagrant` user. Prefer this VM when validating Linux-specific renderer, Electron, tray, pet-window, IPC, plugin, or packaging behavior.

See `docs/development.md` (cross-platform & Linux testing) for how this fits the wider DX/testing workflow.

## Cloned Dependency Source

Read-only dependency source repositories are available under
`.slim/clonedeps/repos/` for inspection. Do not edit these clones.

- `.slim/clonedeps/repos/electron__electron/` — `electron/electron` at `v42.0.0`; inspect Electron BrowserWindow, Linux, and Wayland geometry behavior used by OpenPets drag handling.
- `.slim/clonedeps/repos/KDE__kwin/` — `KDE/kwin` at `master` (`10273ea5f8c43f9a17825e9560f9616b23cef1ba`); inspect KDE Wayland compositor handling of xdg toplevel movement, activation, and geometry constraints.
