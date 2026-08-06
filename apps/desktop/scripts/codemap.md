# apps/desktop/scripts/

## Responsibility

Build and release automation scripts for the OpenPets desktop application. Handles packaging cleanup and local release orchestration (macOS-focused).

## Design

- **Node.js Scripts**: CommonJS (`.cjs`) for sync fs operations, ESM (`.mjs`) for modern async flow
- **Safety-First**: Path validation before `rmSync`, git state verification, dry-run support
- **GitHub Integration**: Uses `gh` CLI for tag management, SignPath workflow dispatch/waiting, draft release creation, asset verification, and publication
- **Cross-Platform Builds**: Orchestrates `electron-builder` for macOS, Windows, Linux from macOS host

## Flow

**Clean Package Output** (`clean-package-output.cjs`):
```
Resolve dist-electron path → Validate path components → rmSync recursive
```

**Local Release** (`release-local.mjs`):
```
Preflight checks (git clean, remote sync, version validity)
→ Capture previous release tag before any new tag
→ Build and test (unless --skip-checks)
→ Clean output directory
→ Execute electron-builder for each target in build plan
→ (with --linux-package-dir) skip local DEB/RPM and copy validated Ubuntu packages into output
→ (dry-run) Generate local preview SHA256SUMS and stop
→ Create/push annotated release tag
→ Dispatch SignPath workflow and wait for the matching signed run
→ Replace disposable local Windows installer with the exact signed artifact
→ Generate final SHA256SUMS
→ Create GitHub draft, upload final assets with --clobber, verify names, publish
→ (--resume) Rebuild/re-sign an existing tagged HEAD and repair only a draft
```

**Desktop Tests** (`run-tests.mjs`):
```
Check preload syntax → Compile tests to .test-dist → Run behavior tests → Run contract tests → Run remaining dist checks
```

## Integration Points

- **File System**: `apps/desktop/dist-electron/` (build output), `apps/desktop/dist/` (compiled JS), optional external Linux package staging directory
- **Git**: Working tree status, remote sync verification, tag existence checks
- **GitHub**: `gh workflow run`, `gh run list/download`, and draft-to-published release operations for `alvinunreal/openpets`
- **Build Tools**: `pnpm`, `electron-builder`, `node --check`
- **Node APIs**: `crypto` (SHA256), `fs`, `path`, `child_process.spawnSync`

## Key Scripts

- `clean-package-output.cjs`: Removes `dist-electron` directory with path safety checks
- `release-local.mjs`: Full release orchestration with preflight validation, multi-platform builds, and GitHub draft creation
- `run-tests.mjs`: Desktop test runner for preload syntax checks, `.test-dist` behavior/contract tests, and remaining runtime checks

## Build Plan (release-local.mjs)

Default targets:
- macOS DMG (x64+arm64 universal)
- Windows NSIS installer (x64)
- Linux AppImage (x64)
- Linux DEB (x64)
- Linux RPM (x64)
- Linux tar.gz (x64)

Options:
- `--yes`: tag, obtain the SignPath-signed Windows x64 installer, verify a draft release, and publish
- `--resume`: with `--yes`, retry a tagged `HEAD` and clobber draft assets; refuses published releases
- `--dry-run`: local build/check and checksum preview only; no tag, signing, or GitHub mutation
- `--linux-package-dir <absolute-dir>`: use validated Ubuntu-built DEB/RPM files from external staging, skipping local DEB/RPM builds
- `--skip-checks`: skip build/check commands; incompatible with `--yes`
- `--include-experimental-arm`: build Windows/Linux ARM64 targets; unsigned Windows ARM64 is disposable and not published
