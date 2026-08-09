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
Load/validate checkpoint in .release-state/v<version>.json (discarded when HEAD or version moves)
→ Preflight checks (git clean, remote sync, version validity, tag/release expectations)
→ Capture previous release tag before any new tag
→ Run the stage plan, skipping stages already checkpointed with intact outputs:
   checks → clean → build:mac-dmg → build:mac-zip → build:linux-appimage
   → build:linux-deb → build:linux-rpm → build:linux-targz
   → (with --linux-package-dir) stage:linux-packages instead of local DEB/RPM
   → verify:local (working tree + pre-signing artifact set)
   → (dry-run) preview:checksums and stop
   → tag → sign:dispatch (records the run id) → sign:collect (re-attaches on resume)
   → verify:final (signed artifact set + SHA256SUMS)
   → release:draft → release:upload (skips assets already on the draft) → release:publish
→ On failure, the completed stages stay checkpointed and the same command resumes
```

**Desktop Tests** (`run-tests.mjs`):
```
Check preload syntax → Compile tests to .test-dist → Run behavior tests → Run contract tests → Run remaining dist checks
```

## Integration Points

- **File System**: `apps/desktop/dist-electron/` (build output), `apps/desktop/.release-state/` (gitignored release checkpoints), `apps/desktop/dist/` (compiled JS), optional external Linux package staging directory
- **Git**: Working tree status, remote sync verification, tag existence checks
- **GitHub**: `gh workflow run`, `gh run list/download`, and draft-to-published release operations for `alvinunreal/openpets`
- **Build Tools**: `pnpm`, `electron-builder`, `node --check`
- **Node APIs**: `crypto` (SHA256), `fs`, `path`, `child_process.spawnSync`

## Key Scripts

- `clean-package-output.cjs`: Removes `dist-electron` directory with path safety checks
- `release-local.mjs`: Full release orchestration with preflight validation, multi-platform builds, and GitHub draft creation
- `run-tests.mjs`: Desktop test runner for preload syntax checks, `.test-dist` behavior/contract tests, and remaining runtime checks

## Build Plan (release-local.mjs)

Default local targets (the Windows x64 installer is built and signed by SignPath, never locally):
- macOS DMG (x64+arm64)
- macOS ZIP (x64+arm64)
- Linux AppImage (x64)
- Linux DEB (x64)
- Linux RPM (x64)
- Linux tar.gz (x64)

Options:
- `--yes`: tag, obtain the SignPath-signed Windows x64 installer, verify a draft release, and publish
- `--status`: print the stage plan and checkpoint state, then exit
- `--from <stage>`: invalidate that stage and every later stage before running
- `--reset`: delete the checkpoint for this version, then exit
- `--resume`: legacy fallback for a tagged `HEAD` with no checkpoint; refuses published releases
- `--dry-run`: discouraged; local build/check and checksum preview only, no tag, signing, or GitHub mutation
- `--linux-package-dir <absolute-dir>`: use validated Ubuntu-built DEB/RPM files from external staging, skipping local DEB/RPM builds
- `--skip-checks`: skip build/check commands; incompatible with `--yes`
- `--include-experimental-arm`: build Windows/Linux ARM64 targets; unsigned Windows ARM64 is disposable and not published
