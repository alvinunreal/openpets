# Developer Experience (DX)

How to set up, build, run, and release the workspace. This doc is the practical
"how do I work in this repo" companion; testing and production-validity gates get
their own doc, [testing-and-validation.md](testing-and-validation.md).

## Layout & toolchain

- **Monorepo**: pnpm workspaces (`pnpm-workspace.yaml`) over `apps/*` and
  `packages/*`. Package manager pinned to `pnpm@11.x`; Node `>=20`.
- **ESM + TypeScript everywhere**: every package is `"type": "module"` with dual
  type exports; internal links use `workspace:*`.
- **`web/` uses Bun + Nuxt** and is a separate toolchain — its commands run from
  `web/` with `bun`, not pnpm. Only its data/catalog side is in scope here (see
  [catalog.md](catalog.md)).
- **Versioning**: packages align around SDK v3 / `manifestVersion 3`. The
  workspace version is in the root `package.json` (`3.1.0` at time of writing).

The authoritative structural map is the root `codemap.md` plus per-folder
`codemap.md` files; read those before editing a subsystem.

## Root command surface

All from the repo root unless noted (full list in root `package.json`):

| Command | What it does |
|---------|--------------|
| `pnpm build` | Build every package (`pnpm -r build`) |
| `pnpm typecheck` | Type-check every package |
| `pnpm check` | Per-package `check` (typecheck + build + contract checks) |
| `pnpm test` | Build, then run each package's tests |
| `pnpm dev:desktop` | Run the desktop app in dev |
| `pnpm dev:desktop:control-center` | Dev with renderer/Control Center focus |
| `pnpm dev:desktop:plugins` | Dev with official plugins hot-loaded |
| `pnpm dev:desktop:third-parties` | Dev with direct plugin folders under `third-parties` hot-loaded |
| `pnpm package:desktop` / `:dir` | Build + package the desktop app (full / unpacked dir) |
| `pnpm release:desktop` | macOS-local build, automatic SignPath Windows signing, and verified GitHub publication |
| `pnpm release:npm` | Publish npm packages |
| `pnpm plugins:*` | Plugin test/validate/package/publish/deploy (see below) |

### Plugin DX commands

| Command | Purpose |
|---------|---------|
| `openpets plugin new <name> --template <t>` | Scaffold an SDK v3 plugin |
| `openpets plugin validate <dir>` | Validate a plugin locally |
| `pnpm plugins:test` | Locale checks + official-plugin harness tests |
| `pnpm plugins:check` | Dry-run the catalog package plan |
| `pnpm plugins:package` | Build catalog + ZIP staging (no upload) |
| `pnpm plugins:validate-release` | Pre-ship release gate |
| `pnpm plugins:publish` | Upload ZIPs to R2 |
| `pnpm plugins:validate-live` | Post-deploy live check |
| `pnpm plugins:deploy` | Deploy the web catalog |

See [plugins.md](plugins.md) for the authoring workflow and
[testing-and-validation.md](testing-and-validation.md) for what the validators
catch.

## Running the desktop app

- `pnpm dev:desktop` launches Electron against the TypeScript source with the
  Vite renderer dev server.
- Plugin authors using the installed app do not need this repo: open **Plugins →
  Developer Mode → Load unpacked plugin folder** to validate, snapshot, watch, and
  reload a standalone plugin folder.
- For plugin work, `pnpm dev:desktop:plugins` points the local loader at both
  `plugins/official` and `plugins/dev` (via `OPENPETS_DEV_PLUGIN_ROOTS`) so
  official plugins and in-progress dev plugins hot-load when working on OpenPets
  itself.
- `pnpm dev:desktop:third-parties` loads every direct child of `third-parties`
  that contains `openpets.plugin.json` through `OPENPETS_DEV_PLUGIN_ROOTS`, with
  the plugin catalog disabled. Non-plugin folders are ignored, and changes to a
  discovered plugin's manifest or entry file hot-reload it.
- Logs land in `userData/logs/openpets.log` (path varies by OS). Route renderer
  diagnostics into the app log, not just DevTools (per `AGENTS.md`).

### The CSP footgun

Any renderer-visible URL scheme, image source, dev endpoint, or internal
protocol must be added to the CSP in **both** `apps/desktop/vite.config.ts` and
`apps/desktop/src/renderer/index.html`. Symptom of forgetting: images fall back
to the default pet even though install/render logic is correct. See
[desktop.md](desktop.md).

## Logging-as-DX

When working on renderer/IPC/catalog/plugin/pet-window behavior, add **targeted,
scoped** logs as part of the change (data shapes, selected ids, load/error
states, boundary decisions). Avoid noisy permanent logs, secrets, full payload
dumps, or logging inside animation/render loops. The logger
(`apps/desktop/src/logger.ts`) provides scopes and redaction. This is an explicit
repo convention (`AGENTS.md`), not optional polish.

## Release flows

### npm packages

`pnpm release:npm` (`scripts/release-npm.mjs`) orchestrates publishing the
workspace packages. Packages must build and pass `check`/`test` first.

### Desktop app

`pnpm release:desktop -- --yes` (`apps/desktop/scripts/release-local.mjs`) does a
macOS-local build + packaging, creates and pushes the release tag, dispatches
the production SignPath Windows workflow, waits for its signed artifact, and
only then creates a draft GitHub release, verifies its complete asset set, and
publishes it. The local Windows installer is disposable; macOS and Linux
artifacts remain unsigned.

Use `pnpm release:desktop -- --dry-run` for a local artifact preview; it does
not tag, dispatch SignPath, or mutate GitHub. If a tagged attempt is interrupted
before publication, recover with `pnpm release:desktop -- --yes --resume`. Resume
requires local and origin `v<version>` tags at `HEAD`, accepts only no release or
a draft release, and refuses a published release. SignPath may pause for manual
approval in its dashboard while the release script visibly waits.
`electron-builder` handles cross-platform packaging; bundled mode unpacks the
integration CLIs and bundles `plugins/official` as extra resources (verified by
the packaging contract — see [testing-and-validation.md](testing-and-validation.md)).

### Web catalog

Pet and plugin catalog deploys run from `web/` with Bun (`bun run deploy`,
`pnpm plugins:deploy`). Catalog generation/verification is in [catalog.md](catalog.md)
and the runbooks under `web/docs/`.

## Cross-platform & Linux testing

- An **Ubuntu 24.04 ARM64 VMware/Vagrant VM** exists for Linux GUI testing.
  Details and host-side commands are in `AGENTS.md` (VM dir
  `/Volumes/external/vmware/ubuntu24`; guest checkout `/home/vagrant/src/openpets`;
  helpers `cdpets` + `openpets-dx`). Use the **isolated guest clone**, never the
  mounted macOS checkout (platform-specific `node_modules`).
- Use the VM to validate Linux/Wayland renderer, tray, pet-window drag, IPC,
  plugin, and packaging behavior.
- **WSL** cross-platform IPC (WSL client → Windows host over private TCP) is part
  of the protocol — see [ipc.md](ipc.md).

## Code intelligence

This repo has a **CodeGraph** index (`.codegraph/`) and an MCP server
(`codegraph_*` tools) — a tree-sitter knowledge graph of every symbol/edge/file.
Prefer it for structural questions (who calls X, what breaks if I change Y, where
is Z defined) over grep. Read-only dependency clones for inspecting Electron /
KWin behavior live under `.slim/clonedeps/repos/` (do not edit). Both are
described in `AGENTS.md`.

## Conventions checklist

- Match surrounding code style; keep comment density and naming idiomatic.
- Update the matching `docs/*.md` and `codemap.md` when behavior changes.
- Honor forward-only direction: no legacy compat in current runtime paths.
- Validate at boundaries; atomic writes; reject path traversal/symlinks.
- For plugin/catalog/i18n changes, follow the explicit "update docs / run
  validators" rules in `AGENTS.md`.
</content>
