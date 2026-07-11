# Testing, Verification & Production Validity

OpenPets ships an Electron app, npm packages, third-party-runnable plugin code,
and remotely-hosted catalogs — so "does it pass tests" is necessary but not
sufficient. This doc lays out the full quality ladder: unit/behavior tests,
**contract tests** at public boundaries, runtime checks, the **plugin release
validators**, and **catalog verification** — i.e. what "production-valid" means
before you ship pets, plugins, packages, or the app.

## The quality ladder

From fastest/narrowest to broadest:

1. **Behavior tests** — unit tests of pure logic.
2. **Contract tests** — validate public boundaries (IPC, catalog, manifest)
   against fixtures so producers and consumers can't drift apart.
3. **Runtime checks** (`check-*.ts`) — assertions about packaging, CSP, SDK
   conformance, and integration previews that run as part of `check`/`test`.
4. **Release validators** — the gates that catch *production-breaking* mistakes
   the test suite alone misses (catalog/package drift, missing ZIPs, SHA
   mismatches, unresolved `$t:`).
5. **Live validation** — post-deploy checks against the real origin.

Run the suite with `pnpm test` (builds first, then each package's tests) and
`pnpm check` (per-package typecheck + build + contract checks). See
[development.md](development.md) for the command surface.

## Desktop tests

The desktop runner (`apps/desktop/scripts/run-tests.mjs`) orchestrates:
preload syntax checks → test compilation → behavior tests → contract tests →
dist checks. Three buckets:

- **Behavior** (`apps/desktop/tests/*.test.ts`): lease manager, app state,
  version checking, ZIP safety, Codex pets, Claude memory, reaction-animation
  mapping. Compiled to `.test-dist/`.
- **Contract** (`apps/desktop/contracts/*.contract.ts`): the public boundaries —
  - `catalog-fixture.contract.ts` — catalog validation against fixture data.
  - `local-ipc-protocol.contract.ts` — IPC request/response parsing
    ([ipc.md](ipc.md)).
  - `plugin-manifest.contract.ts` — manifest v1 schema, config refs, permissions,
    deferred features, action validation ([plugins.md](plugins.md)).
- **Runtime checks** (`apps/desktop/src/check-*.ts`): notably
  - `check-packaging-contract.ts` — asserts the packaged app includes bundled
    official plugins as extra resources, every bundled plugin's manifest + entry
    exist, the pet-window CSP allows the bundled emoji font, etc. This is the
    guard that a *packaged* build is actually shippable.
  - `check-opencode-desktop-setup.ts` — verifies the bundled OpenCode setup
    preview matches expectations.

## Package tests & contracts

Each package runs its own `check`/`test`. Notable contract/boundary coverage:

- `packages/client/contracts/client-protocol.contract.ts` — the client side of
  the IPC protocol, paired with the desktop's server-side contract so both ends
  validate the same shapes.
- `packages/sdk/src/check-plugin-sdk.ts` — **SDK conformance**: compiles/runs a
  representative plugin against the test harness to detect drift between the
  published types (`index.ts`), the harness (`testing.ts`), and the desktop
  bridge. Changing the SDK without updating all three fails here. See [sdk.md](sdk.md).
- `packages/cursor/src/check-cursor.ts`, `packages/opencode` checks, etc. —
  validate the safe config-write behavior (status classification, redaction,
  symlink/oversize rejection, atomic writes, uninstall preserving user entries).
  See [agent-integrations.md](agent-integrations.md).

## Plugin testing

- **Unit**: each official plugin has a `test.js` using
  `@open-pets/plugin-sdk/testing` — fake time/events, descriptor-level
  assertions, no Electron. Run via `pnpm plugins:test`, which first runs
  `pnpm plugins:locales` (`scripts/check-plugin-locales.mjs`) to verify every
  `$t:`/`ctx.t()` key resolves. See [sdk.md](sdk.md).
- **Manifest validation**: `openpets plugin validate <dir>` checks manifest,
  permissions, SDK compatibility, config field types, network hosts, asset
  formats/size caps, entry files, and panels — run it before packaging.

- **Calendar Airmail**: its deterministic harness coverage should exercise the
  primary-calendar reconciliation, state-appropriate connection commands,
  ten-minute and start deliveries, duplicate suppression, selected/default
  couriers, and reconnect-required cleanup. Run its plugin test alongside
  `pnpm plugins:locales`,
  `pnpm plugins:test`, and `pnpm --filter @open-pets/plugin-sdk check` when
  changing its SDK-facing behavior.
- **Delivery/picker boundary**: desktop bridge tests cover `ui:delivery`
  permission and lifecycle semantics; manifest validation covers declared
  sprite-grid options and asset references. For an Electron end-to-end smoke run,
  verify that the Airmail settings grid loads each bundled courier, keyboard and
  pointer selection persist, reduced motion is static, and a test delivery uses
  the selected courier without requiring any installed pet.

## Plugin release validation (production gate)

`plugins:check` alone is **not** release-readiness. The dedicated validators are
the production gate (`scripts/validate-plugin-release.mjs`):

| Command | When | Catches |
|---------|------|---------|
| `pnpm plugins:package` | build artifacts | (produces catalog + ZIP staging) |
| `pnpm plugins:validate-release` | **before deploy** | unresolved `$t:` names/descriptions in catalog cards, missing plugin ZIPs, SHA mismatches, missing `locales/en.json`, missing declared assets/entry files (including courier sprites), catalog/package drift, and **community plugin sidecar validation** (`provenance.json`, `submissions.json`) |
| `pnpm plugins:validate-live` | **after deploy/R2 upload** | the same, against the live catalog + live ZIPs & live sidecars |

### Plugin sidecar validation

The release validator automatically loads `web/public/plugins/provenance.json`
and `web/public/plugins/submissions.json` and asserts:
1. Every community plugin mapped in the catalog has a matching provenance entry.
2. All provenance entries contain valid URLs, hex SHAs (40 characters), and formatted dates.
3. Update policy is strictly limited to either `safe-auto` or `manual-review`.
4. Pending submissions are well-formed and are not also present in the installable catalog.

The full pre-ship sequence (from `AGENTS.md`):
`pnpm plugins:package` → `pnpm plugins:validate-release` → deploy/upload →
`pnpm plugins:validate-live`. Treat a failing validator as a hard stop — these
are exactly the mistakes that 404 a plugin or render a raw `$t:...` to users.
For the full plugin catalog release path in one command, run
`pnpm plugins:release`; it packages, validates, publishes ZIPs, deploys the web
catalog, then validates the live catalog.

## Catalog verification (production gate for pets)

Pet catalogs have a parallel "doctor" run from `web/` (read-only; safe anytime).
Detailed in `web/docs/pet_publishing.md`; the gate in brief:

| Command | Adds |
|---------|------|
| `bun run verify:catalog` | manifest integrity, artifact freshness vs manifest, on-disk assets, orphan dirs |
| `bun run verify:catalog:remote` | HEAD-checks every ZIP on R2 — catches "not installable" pets |
| `bun run verify:catalog:prod` | diffs local vs the deployed prod catalog (pending/removed) |
| `bun run verify:catalog:all` | all of the above |

The non-negotiable rule: **never ship a catalog entry whose ZIP isn't live on
R2.** Run `verify:catalog:remote` before deploying and `verify:catalog:prod`
after to confirm the deploy landed. See [catalog.md](catalog.md).

## What "production-valid" means

Before shipping, the relevant gate must be green:

- **A package change** → `pnpm check` + `pnpm test` (incl. contract + conformance
  checks) pass.
- **An app change** → desktop behavior + contract + runtime checks pass; if it
  touches packaging/CSP/bundled plugins, `check-packaging-contract.ts` passes.
  A delivery, trusted-asset protocol, or sprite-picker change additionally needs
  the desktop bridge/static checks and the targeted Electron smoke above.
- **A plugin release** → `validate-release` before deploy, `validate-live` after.
- **A pet catalog change** → `verify:catalog:remote` before, `verify:catalog:prod`
  after.
- **Linux-specific behavior** → validated on the Ubuntu VM
  ([development.md](development.md)).

If a gate is skipped, say so explicitly rather than implying coverage. Contract
and validator failures are signal, not noise — they encode the ways this product
has broken in production before.
</content>
