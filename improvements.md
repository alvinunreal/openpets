# OpenPets — Improvements & Observations

A running, standalone log of improvements, risks, and inconsistencies noticed
while working in this repo. Not a task board — a curated backlog of things worth
fixing, with enough context to act on later. Newest sections reflect the most
recent pass.

**Criticality scale:** 🔴 high (correctness / production / breakage risk) ·
🟠 medium (DX friction, drift, or confusion that costs time) ·
🟡 low (polish, nice-to-have, organizational).

---

## Documentation pass — 2026-08-08

Context: moved the public docs source of truth into the root `docs/` tree and
rebuilt it as a Blume documentation site. Findings surfaced while reading the
codemaps, scripts, catalogs, and old website notes.

### Documentation & references

- 🔴 **`AGENTS.md` referenced docs that did not exist.** It pointed at
  `docs/plugins.md` and `docs/official-plugins.md` as required reading before plugin
  work, but `docs/` was empty. Any agent following `AGENTS.md` hit a dead end.
  *Fixed in this pass* — both docs now exist. Keep this from regressing: if a
  doc is referenced as required reading, it must exist.

- 🟢 **Old plugin publishing notes were replaced by the Blume docs path.** The
  public docs now describe the current official/community plugin lineup in
  `docs/official-plugins.md`, the platform/runtime contract in
  `docs/plugins.md`, and the release gates in `docs/testing-and-validation.md`
  plus `docs/release.md`. Keep plugin lineup copy tied to generated catalog
  output so it does not drift again.

### Project structure / organization

- 🟢 **Docs platform split is now explicit.** `docs/` is the public
  documentation source for Blume. The Nuxt site remains the product/marketing
  site and redirects old docs URLs to the dedicated docs domain.

- 🟡 **Top-level `DESIGN.md`** exists alongside `codemap.md` and now `docs/`.
  Confirm it is still current or fold its still-true parts into
  `docs/architecture.md` and retire the rest, so there is one front door.

### Observations to verify later (not yet confirmed bugs)

- 🟡 The desktop `catalog.ts` falls back V3 → V2 → fixture. Worth confirming the
  fixture path is only reachable in tests/offline and never silently ships a
  stale fixture catalog to users.
- 🟠 **Confirmed stale: `apps/desktop/codemap.md` "External Services" lists the
  plugin catalog as `plugins/catalog.v1.json`.** The source
  (`apps/desktop/src/plugin-catalog.ts`) actually fetches
  `plugins/catalog.v2.json` (`pluginCatalogUrl`), keeping the v1 URL only as a
  compat constant. The desktop codemap's external-services line should be updated
  to v2 (it implies the app still reads v1). Low blast radius but it's exactly the
  kind of drift that misleads an agent reading the codemap.

---

*Append new dated sections above this line as work continues.*
