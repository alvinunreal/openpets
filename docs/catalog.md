# Catalogs & App-Facing Web Data

The app discovers and installs pets and plugins from versioned JSON **catalogs**
served at `openpets.dev`, with ZIPs hosted on R2 behind `zip.openpets.dev`. This
doc describes those catalogs as **contracts** and how the desktop **consumes**
them. It is intentionally scoped to the app-facing data of `web/` — catalogs,
ZIP hosting, pet/plugin metadata — and not the marketing site/frontend.

The **publishing runbooks** (how content is generated and uploaded) live in
`web/docs/`: `pet_publishing.md`, `plugin-publishing.md`, `pet-import-process.md`.
This doc is the consumer-and-contract view; it points into those for the
producer view.

## Direction (read this first)

- **Pet catalog v3 is the source of truth.** v2 exists only for old app versions
  and as a fallback. New work targets v3.
- **Plugin catalog v2 is active.** v1 is kept as an *empty compatibility shim*
  for older desktop builds. (Verified URLs in `apps/desktop/src/plugin-catalog.ts`.)
- This matches the forward-only direction in `AGENTS.md`: don't optimize new
  behavior for legacy catalog versions.

## Endpoints the app fetches

| Data | URL | Owner in app |
|------|-----|--------------|
| Pet catalog v3 (index) | `https://openpets.dev/pets/catalog.v3.json` | `apps/desktop/src/catalog.ts` |
| Pet catalog v3 pages | `…/pets/catalog.v3/page-NNN.json` | `catalog.ts` |
| Pet catalog v3 search | `…/pets/catalog.v3/search.json` (+ search pages) | `catalog.ts` |
| Pet catalog v2 (legacy/fallback) | `https://openpets.dev/pets/catalog.v2.json` | `catalog.ts` |
| Pet ZIPs | `https://zip.openpets.dev/pets/{slug}/{installId}.zip` | `pet-installation.ts` |
| Plugin catalog v2 (active) | `https://openpets.dev/plugins/catalog.v2.json` | `plugin-catalog.ts` |
| Plugin catalog v1 (empty compat) | `https://openpets.dev/plugins/catalog.v1.json` | `plugin-catalog.ts` |
| Plugin ZIPs | `https://zip.openpets.dev/plugins/{plugin-id}.zip` | `plugin-package.ts` |

## Pet catalog v3 contract

v3 is **paginated** to keep each runtime fetch small. The flow the app follows:

1. Fetch the **root index** (`catalog.v3.json`): `version: 3`, `generatedAt`,
   `total`, `pageSize`, a `search` URL, `filters` (categories with counts,
   `originalsCount`, `featuredCount`), and a `pages[]` array of page URLs.
2. Fetch **pages** on demand. Each page entry carries install + render data:
   `id`, `displayName`, `description`, `thumbnail`, `spritesheet`, `zip`,
   `category`, optional `subcategory`, `featured`, `original`.
3. Use **search pages** for lightweight lookup: `id`, `displayName`,
   `searchText`, `category`, `catalogPage`, `featured`, `original`.

Only pets with a valid `category` (`western` or `asian`) appear in v3 — the
generator drops the rest and logs a warning. To keep the app UI clean, the
Control Center browsing/search indexes surface only "curated" (original or
featured) pets. However, explicit lookup/installation by ID allows installing
any valid v3 catalog pet. The validators on the app side live
in `catalog-validation.ts` (`validateCatalogV3Index`, `validateCatalogV3Page`,
`validateCatalogV3SearchIndex`, `validateCatalogV3SearchPage`, plus
`validateCatalogV2`). The canonical field list is maintained in
`web/docs/pet_publishing.md` — treat the generator + validator as the contract,
not any hand-written copy.

### Fetch fallback chain

`catalog.ts` resolves the catalog **V3 → V2 → bundled fixture**. The fixture
(`catalog.v2.fixture.json`) keeps the app usable offline / in tests. The fixture
should never be the path real users hit online; it is a last-resort floor, not a
shipping catalog.

## Pet generated artifacts

The publishing scripts (`web/scripts/`) treat `web/public/pets/manifest.json` as
the **canonical generated state** and derive everything else from it:

```
web/public/pets/
  manifest.json          canonical generated catalog state
  install.json           install metadata
  catalog.v2.json        legacy/fallback catalog
  catalog.v3.json        v3 index
  catalog.v3/
    page-000.json …       paginated pages
    search.json
    search-page-NNN.json
  {slug}/
    spritesheet.webp
    thumb.webp
    thumb.webp.meta.json
```

Regenerating artifacts from the manifest is `generate:catalog-artifacts`;
verifying them is the `verify:catalog*` family (see
[testing-and-validation.md](testing-and-validation.md)). The web build also emits
`app/lib/pets.generated.js` / `pets.preview.js` for the site — out of scope here.

## Plugin catalog contract

The plugin catalog (`plugin-catalog-validation.ts`) is validated strictly:
schema version, unique ids, semver + SHA fields, canonicalized permissions, and
an optional minimum-OpenPets-version gate. Catalog cards may carry an
`iconDataUrl` (base64 SVG) so the Plugins UI renders an icon without an extra
fetch. Each entry's `downloadUrl` must point at `zip.openpets.dev/plugins/`.
Catalog v2 also carries `publisherType: "official" | "community"`; older
catalogs without the field are treated as official by the desktop validator.
Community entries are public catalog plugins but cannot be bundled/default-on.

### Plugin generated artifacts

The tracked root producer, `scripts/sync-plugins.mjs`, discovers
`plugins/official/` and `plugins/community/` and generates the ignored deploy
artifacts:

```
web/public/plugins/
  catalog.v2.json        active plugin catalog
  catalog.v1.json        empty compatibility catalog
  provenance.json        reviewed community snapshots
  submissions.json       pending, non-installable submissions
web/.data/plugin-zips/
  {plugin-id}.zip        deterministic hash-pinned package
```

Each source plugin appears exactly once. Catalog download URLs are canonical
`https://zip.openpets.dev/plugins/{id}.zip` URLs, SHA-256 values are computed
from store-only ZIP bytes ordered by UTF-8 path bytes, network hosts appear only
with the `network` permission, and community entries are always labeled `publisherType:
"community"`. The tracked provenance/submission sources live beside community
plugin source under `plugins/community/`. Generation rejects platform-unsafe
paths and symlinked output ancestry; release validation checks ZIP CRC-32 plus
the complete local-header/central-directory/EOCD structure. Catalog generation
and release validation share the desktop v2 schema limits for versions, SDK
versions, network hosts, and SVG icon data URLs.

The reviewed tree and ZIP hashes use checkout bytes. Root `.gitattributes`
forces LF for every text format currently stored below `plugins/` (including
`.openpets-approved-hosts`) and marks WebP assets binary, keeping hashes stable
when a contributor enables `core.autocrlf`.

### Sidecars: plugin provenance and submissions (website-only)

To secure community-contributed plugins without changing the app-facing
`catalog.v2.json` schema, the website serves sidecar metadata files:

| File | Purpose |
|------|---------|
| `https://openpets.dev/plugins/provenance.json` | Reviewed provenance for installable community plugins. |
| `https://openpets.dev/plugins/submissions.json` | Pending external GitHub submissions shown on the website but not installable. |

These files are only used by the website/CI environment for provenance display,
validation, and automated owner-publishing policy. `provenance.json` is keyed by
plugin ID and defines:
* `publisher`: GitHub user/organization owner.
* `sourceUrl`: Upstream GitHub repository.
* `sourceSubdirectory`: Optional subdirectory under the repository root.
* `sourceCommit`: The reviewed and approved commit SHA.
* `reviewedTreeSha256`: SHA-256 of the deterministic reviewed-directory file framing.
* `reviewedAt`: ISO date/time of review.
* `updatePolicy`: `safe-auto` (safe for automated release updates) or `manual-review`.

`sourceCommit` is the upstream snapshot the maintainer reviewed;
`reviewedTreeSha256` is the mechanically enforced content boundary and is
recomputed from every regular file in the current community directory. Offline
validation deliberately does not fetch or cryptographically link the commit to
the digest, so reviewers must perform that comparison when accepting a plugin.
Any digest change requires manual review and a new commit/digest/date.

`submissions.json` is also keyed by plugin ID, but entries are candidates only:
they must not appear in the installable catalog until promoted into
`plugins/community/`, packaged, uploaded, and release-validated.

The desktop fetch (`plugin-catalog.ts`) is hardened: timeout, redirect
rejection, response-size cap, and caching with refresh. Install/verification of
the downloaded ZIP (SHA-256, host/path allowlist, entry restrictions, manifest
↔ catalog consistency) is `plugin-package.ts`. See [plugins.md](plugins.md).

## ZIP hosting (R2)

Both pet and plugin ZIPs live on the R2 bucket (default `openpets`) backing
`zip.openpets.dev`. The hard rule: **never ship a catalog entry whose ZIP isn't
live on R2.** The verification commands HEAD-check every ZIP for exactly this
reason. Override the bucket with `OPENPETS_R2_BUCKET`; `--skip-r2` is for local
testing only.

## How the app uses all this

- **Browsing**: the Pets page in the Control Center pages through v3 and uses the
  search index for filtering.
- **Installing**: see the install flow in [pets.md](pets.md) — catalog lookup (which allows installing any valid v3 catalog pet by ID, even if not original or featured) →
  ZIP download → validated extraction → state update → tray refresh. (Control Center UI surfaces only curated original/featured pets, but explicit install by ID allows any valid v3 pet).
- **Plugins**: the Plugins page lists catalog v2 entries filtered by app version
  and install state; install downloads + verifies the plugin ZIP. See
  [plugins.md](plugins.md).

## Pointers

- Producer/runbook detail: `web/docs/pet_publishing.md`,
  `web/docs/plugin-publishing.md`, `web/docs/pet-import-process.md`.
- Verification gates: [testing-and-validation.md](testing-and-validation.md).
- Note: as of 2026-06-13, `web/docs/plugin-publishing.md` lists a stale official
  lineup (see root `improvements.md`); trust the catalog generator + the live
  `plugins/official/` folder.
</content>
