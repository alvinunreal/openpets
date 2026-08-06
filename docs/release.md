# OpenPets Desktop Release Guide

This guide is for an AI agent creating a new OpenPets desktop release. The release flow builds the desktop artifact set locally from macOS, then hands Windows signing to GitHub Actions/SignPath before creating and publishing a verified GitHub Release. The local Windows installer is disposable and is never uploaded.

## Repository and app

- GitHub repo: `alvinunreal/openpets`
- Desktop app: `apps/desktop`
- Release script: `apps/desktop/scripts/release-local.mjs`
- Root command: `pnpm release:desktop`
- SignPath Windows workflow: `.github/workflows/signpath-windows.yml`
- Update checker expects GitHub release tags like `v2.0.0`.

## Current SDK v3, translations, and plugin release plan

The next end-user release is a **desktop + web plugin catalog + npm SDK release**. The baseline local release tag before this work is `v2.5.1`; changes since then include the new plugin SDK v3 package, a much larger desktop plugin host surface, manifest v3 plugins, plugin/app translations, and catalog packaging changes.

This is not a small patch release. Treat it as a major plugin-platform release unless product direction says otherwise.

Release goals:

1. Ship desktop plugin platform v3: SDK bridge, manifest v3 support, capability/permission enforcement, quotas, storage/state, events, bus, routes, UI panels, audio, notifications, diagnostics, and conformance checks.
2. Publish `@open-pets/plugin-sdk` so plugin authors can depend on the SDK v3 types and `./testing` harness.
3. Publish the plugin catalog with the current first-party official lineup plus
   reviewed community plugins:
   - Day Routine (`openpets.day-routine`)
   - Focus Buddy (`openpets.focus-buddy`)
   - Fortune Cookie (`openpets.fortune-cookie`)
   - Launch Buddy (`openpets.launch-buddy`)
   - Magic 8 Ball (`openpets.magic-8-ball`)
   - Mood Check-in (`openpets.mood-check-in`)
   - Reminders (`openpets.reminders`)
   - Virtual Pet (`openpets.virtual-pet`)
   - Water Reminder (`openpets.water-reminder`)
   - Community: Walkabout (`openpets.walkabout`)
4. Ship app/plugin translations and locale validation.
5. Remove or keep hidden the old plugin lineup from public discovery unless it has been migrated to manifest v3 and intentionally retained.
6. Keep older catalog endpoints available only as compatibility boundaries for old app versions; do not optimize current runtime behavior for legacy catalog/plugin paths.
7. Release desktop artifacts through GitHub Releases so app update checks see the new version.

Recommended versioning for this release:

- If publishing the SDK v3 package to npm, align **all publishable npm packages** to one shared version because `scripts/release-npm.mjs` enforces a single version across the publish order. For the SDK v3 launch, `3.0.0` is the natural version unless a different release decision is made.
- Bump `apps/desktop/package.json` to the same release version when shipping the desktop host/runtime that implements SDK v3. The current tagged desktop baseline is `v2.5.1`, so the next GitHub Release tag must be a new version.
- Do not leave `packages/sdk/package.json` at `3.0.0` while other publishable packages remain at `2.1.1` if running `pnpm release:npm`; the release script will reject mixed publishable package versions.

## Release workstreams for the SDK v3/plugin release

### A. Desktop app release

Desktop release includes:

- SDK v3 runtime bridge and `@open-pets/plugin-sdk` conformance alignment.
- Manifest v3/catalog support for translated official and community plugins.
- Expanded plugin host capabilities: permissions, storage/state, schedules, commands, events, bus, routes, UI panels, audio, notifications, quotas, diagnostics, and security validation.
- Plugin SDK preload and panel preload packaging contracts.
- Official/community plugin install/update/uninstall support.
- Plugins hub/configuration UI with translated plugin metadata/config fields.
- Local dev plugin workflow cleanup and plugin diagnostics.

Required validation before desktop release:

```bash
pnpm --filter @open-pets/desktop check
pnpm --filter @open-pets/desktop test
pnpm plugins:locales
pnpm --filter @open-pets/desktop package:dir
```

Manual desktop QA:

1. Run normal desktop dev startup or a packaged app (`pnpm dev:desktop` or the output from `pnpm --filter @open-pets/desktop package:dir`) so bundled seeding runs.
2. Open tray → Plugins.
3. Confirm the current official manifest v3 plugins appear in dev mode: Day Routine, Focus Buddy, Fortune Cookie, Launch Buddy, Magic 8 Ball, Mood Check-in, Reminders, Virtual Pet, and Water Reminder.
4. Confirm community plugins appear separately/labeled as community when present; currently Walkabout should be a community catalog plugin, not official or bundled.
5. Confirm old sample/legacy plugins do not appear unless they were intentionally migrated and listed in the release plan.
6. Confirm plugin names, descriptions, config labels, command labels, and pet messages resolve through translations rather than raw `$t:` keys.
7. Exercise the SDK v3 surfaces used by official/community plugins: schedule, storage/state, commands, status, audio, notifications, pet reactions/interactions, movement, and any panel UI.
8. Configure Reminders, Water Reminder, Focus Buddy, Launch Buddy, Day Routine, Walkabout, and other config-heavy plugins with form controls, not JSON.
9. Run plugin commands from the Plugins UI and pet right-click menu when available.
10. Restart desktop and confirm enabled plugins reload without broken state or duplicate timers/listeners.
11. Inspect logs for plugin SDK, translation, permission, quota, and manifest validation errors.

For explicit local plugin development, run `pnpm dev:desktop:plugins` separately and confirm official plugins are loaded as local dev plugins and start disabled; this mode intentionally skips bundled seeding.

### B. Web plugin catalog release

Web release includes:

- `plugins/official/**` and `plugins/community/**` source plugins.
- `web/public/plugins/catalog.v2.json`, regenerated from the current manifest v3 official and community plugin sources. Catalog entries include `publisherType: "official" | "community"`; desktop treats missing `publisherType` as official for older catalogs. The desktop runtime currently reads the v2 catalog endpoint even when the contained plugins use manifest v3 / SDK v3.
- `web/public/plugins/catalog.v1.json` retained as an empty compatibility catalog for old desktop versions.
- Removal or hiding of legacy sample plugin manifests from current public discovery.
- Updated `web/docs/plugin-publishing.md`.

Required validation from the repository root:

```bash
pnpm plugins:locales
pnpm plugins:test
pnpm plugins:check
pnpm plugins:package
pnpm --dir web generate
```

Publishing sequence:

1. From the repository root, validate and stage local catalog/ZIP artifacts:
   ```bash
   pnpm plugins:locales
   pnpm plugins:test
   pnpm plugins:check
   pnpm plugins:package
   ```
2. Confirm `pnpm plugins:package` regenerated `web/public/plugins/catalog.v2.json` from the current official and community manifest v3 plugin lineup. Do not release if the checked-in v2 catalog still lists the old ambient/break/pet-pal/wander/quick-reminders/github lineup.
3. Confirm `web/public/plugins/catalog.v1.json` has `plugins: []` and does not expose stale legacy plugins.
4. Upload plugin ZIPs to R2 and regenerate catalogs:
   ```bash
   pnpm plugins:publish
   ```
5. Deploy web:
   ```bash
   pnpm plugins:deploy
   ```
   If the local web deploy times out during the large static upload, commit and
   push both root and nested `web/` repos, then trigger the remote deploy helper:
   ```bash
   ./web/deploy.sh
   ```
   The helper SSHes to the remote checkout, force-resets it to `origin/main`, and
   runs `npm run deploy` inside a tmux session. Remote reset is acceptable for
   this deployment lane because the remote checkout is disposable deploy state.
6. Verify live endpoints:
   - `https://openpets.dev/plugins/catalog.v2.json`
   - `https://openpets.dev/plugins/catalog.v1.json`
   - each `https://zip.openpets.dev/plugins/<plugin-id>.zip`

### C. GitHub Release notes

The release script generates notes from the Git commit range between the previous
desktop tag and the release commit. Do not keep static release-note text in the
script or this guide; stale notes are worse than short generated notes.

Before publishing, inspect the generated notes in a dry run if the release is
risky. After publishing, verify the GitHub Release body matches the actual commit
range and artifact set. If it does not, edit the release body immediately with
`gh release edit v<version> --notes-file <file>`.

### D. NPM release decision

Default decision for this SDK v3 release: **publish npm packages** after versions are aligned.

NPM publishing is required if any of these are true:

- `@open-pets/plugin-sdk` should be available to plugin authors.
- CLI/MCP/client packages changed and users need the published package update.
- Existing published packages are incompatible with the desktop release in a way that affects normal use.

Before running `pnpm release:npm`, align every publishable package in `scripts/release-npm.mjs` to one shared version. The script currently publishes the SDK first and rejects mixed versions.

## What the release script does

`pnpm release:desktop -- --yes` performs these checks/actions:

1. Requires macOS.
2. Requires `pnpm` and `gh`.
3. Requires GitHub CLI auth for `github.com`.
4. Requires `origin` to point to `alvinunreal/openpets`.
5. Requires a clean git working tree.
6. Requires the current branch to have an upstream.
7. Requires local `HEAD` to match the upstream branch.
8. Requires desktop version to be stable semver and not `0.0.0`.
9. Requires tag/release `v<version>` to not already exist.
10. Captures the previous release tag before creating the new tag.
11. Runs build/checks and builds the complete local artifact plan while `v<version>` does not exist.
12. Creates and pushes an annotated `v<version>` tag at `HEAD`.
13. Dispatches `.github/workflows/signpath-windows.yml` against that tag with the production signing inputs.
14. Finds and waits for the matching workflow run, including any required manual SignPath approval.
15. Downloads `signed-openpets-windows-x64` outside the repository, requires the exact signed installer and handoff checksum, and replaces the disposable local Windows installer.
16. Generates the release-wide `SHA256SUMS` only after the signed installer is in place.
17. Creates a **draft** GitHub Release, uploads only the final artifacts and `SHA256SUMS`, verifies the exact remote asset set, and publishes it.

`--resume` is available only with `--yes`. It requires local and origin `v<version>` tags to point to `HEAD`, refuses a published release, rebuilds and re-runs SignPath, and re-uploads draft assets with `--clobber` before repeating final verification and publication.

Published releases are visible to the app update checker.

## Default release assets

Default command for every desktop release:

```bash
pnpm release:desktop -- --yes
```

Default build matrix for the local release script always includes the full x64
artifact set:

- macOS DMG: x64 + arm64
- macOS ZIP: x64 + arm64
- Windows NSIS installer: x64, replaced by the SignPath-signed workflow artifact
- Linux AppImage: x64
- Linux DEB: x64
- Linux RPM: x64
- Linux tar.gz: x64

Expected main artifacts look like:

```txt
OpenPets-<version>-mac-x64.dmg
OpenPets-<version>-mac-arm64.dmg
OpenPets-<version>-mac-x64.zip
OpenPets-<version>-mac-arm64.zip
OpenPets-<version>-win-x64-setup.exe  (SignPath Authenticode-signed)
OpenPets-<version>-linux-x86_64.AppImage
OpenPets-<version>-linux-amd64.deb
OpenPets-<version>-linux-x86_64.rpm
OpenPets-<version>-linux-x64.tar.gz
SHA256SUMS
```

The old per-target optional flags were removed to avoid partial releases. The
experimental ARM flag remains optional, and `--linux-package-dir` is available
only for the validated Ubuntu DEB/RPM fallback described below:

```bash
pnpm release:desktop -- --yes --include-experimental-arm
```

On Apple Silicon macOS, Linux RPM packaging can fail in `fpm`/`rpmbuild`, and
Electron Builder can produce an invalid tiny DEB archive. If that happens, do
not publish a partial release. Build valid DEB/RPM replacements inside the
Ubuntu VMware guest, place them in an external staging directory, and use
`--linux-package-dir` for both the dry run and production command. The script
then skips the failing local DEB/RPM targets, copies and validates the staged
files into `dist-electron`, and continues only with the complete final artifact
set. See [Linux DEB/RPM fallback via VMware](#linux-debrpm-fallback-via-vmware).

`--include-experimental-arm` builds Windows ARM64 and Linux ARM64 locally. The SignPath handoff currently signs only the x64 installer, so the unsigned Windows ARM64 installer remains disposable and is not uploaded. Only use this flag if the additional Linux artifact can be tested.

## Windows code signing with SignPath

OpenPets has a production certificate through the SignPath Foundation program. Use SignPath for Windows Authenticode signing before publishing Windows release artifacts. SignPath's GitHub trusted-build integration requires signing inputs to be uploaded from a GitHub Actions workflow artifact, so do not expect the local macOS release script to produce trusted SignPath-signed Windows files by itself.

### Public code-signing policy

The canonical public policy is https://openpets.dev/code-signing-policy. SignPath signing is limited to official OpenPets open-source release artifacts. The homepage, download page, and release pages must link to that policy. Update the policy whenever signing approvers, maintainer/committer/reviewer roles, or signing-related network handling changes.

Current repository support:

- Workflow: `.github/workflows/signpath-windows.yml`
- Output workflow artifact: `signed-openpets-windows-x64`
- Production signing policy: `release-signing`
- App executable artifact configuration: `openpets-windows-app-exe-zip`
- NSIS installer artifact configuration: `openpets-windows-installer-zip`
- Signed files produced by the workflow:
  - Nested app executable: `openpets.exe`
  - `OpenPets-<version>-win-x64-setup.exe`
  - `SHA256SUMS.windows.txt`

Note: Windows SmartScreen can still show a "not commonly downloaded" prompt for a newly signed OpenPets installer. That does **not** mean the signature is invalid; it usually means the file hash has little distribution history.

The workflow builds the Windows x64 unpacked app on `windows-latest`, uploads `openpets.exe` for SignPath signing, replaces the unpacked app executable with the signed file, builds the NSIS installer from that signed app, uploads the installer for SignPath signing, then publishes the signed installer as a GitHub Actions artifact. The project is linked to the GitHub.com trusted-build system; its repository variables `SIGNPATH_ORGANIZATION_ID` and `SIGNPATH_PROJECT_SLUG`, plus the `SIGNPATH_API_TOKEN` secret, must remain configured.

Verification steps after download (before first run):

```powershell
Get-FileHash .\OpenPets-<version>-win-x64-setup.exe -Algorithm SHA256
Get-AuthenticodeSignature .\OpenPets-<version>-win-x64-setup.exe | Format-List *
```

Only run the installer when the SHA-256 matches the release `SHA256SUMS` and the authenticode signature is valid.

### SignPath setup checklist

These setup values are already configured. If the SignPath project or GitHub repository configuration is recreated, restore them before signing:

1. Accept the SignPath OSS organization invitation.
2. In SignPath, add the predefined trusted build system **GitHub.com** to the organization.
3. Link the GitHub.com trusted build system to the OpenPets SignPath project.
4. Install/authorize the SignPath GitHub App for `alvinunreal/openpets` if SignPath asks for source/build policy verification.
5. Create a SignPath project for OpenPets and note its project slug.
6. Create or identify a signing policy slug. Start with the self-signed test certificate policy; switch to the production certificate policy after SignPath reviews the setup.
7. Add this GitHub repository secret:
   - `SIGNPATH_API_TOKEN` — API token for a SignPath user with submitter permission for the project/signing policy.
8. Add these GitHub repository variables:
   - `SIGNPATH_ORGANIZATION_ID` — SignPath organization ID.
   - `SIGNPATH_PROJECT_SLUG` — SignPath OpenPets project slug.

### SignPath artifact configurations

GitHub `actions/upload-artifact` stores each upload as a ZIP archive for SignPath, so each SignPath artifact configuration must use `<zip-file>` as the root element.

The unpacked app executable configuration is `openpets-windows-app-exe-zip`:

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="openpets.exe">
      <authenticode-sign />
    </pe-file>
  </zip-file>
</artifact-configuration>
```

The NSIS installer configuration is `openpets-windows-installer-zip`:

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="OpenPets-*-win-x64-setup.exe">
      <authenticode-sign />
    </pe-file>
  </zip-file>
</artifact-configuration>
```

Use `test-signing` only to validate SignPath setup. The normal `--yes` release command dispatches the workflow after the local build has succeeded and the annotated release tag has been pushed. It supplies these production inputs:

```bash
gh workflow run signpath-windows.yml --repo alvinunreal/openpets --ref v<version> \
  -f signing_policy_slug=release-signing \
  -f artifact_configuration_app_exe_slug=openpets-windows-app-exe-zip \
  -f artifact_configuration_installer_slug=openpets-windows-installer-zip
```

The release script locates the newly dispatched run by workflow, tag ref, `HEAD` SHA, event, and dispatch time. It visibly waits for completion; if the run pauses during a SignPath approval step, a signer/approver must approve the request in the SignPath dashboard before the workflow can continue. The script does not assume that approval succeeds automatically.

After the workflow succeeds, the script downloads its `signed-openpets-windows-x64` artifact to a temporary directory outside the repository. It requires exactly `OpenPets-<version>-win-x64-setup.exe` and `SHA256SUMS.windows.txt`, validates the handoff checksum, replaces the disposable local Windows installer, and then generates the release-wide `SHA256SUMS`. `SHA256SUMS.windows.txt` is not uploaded to the GitHub Release.

### Recovery when the automated handoff is interrupted

If the initial signing step fails after the tag was pushed, do not delete the tag. Retry the complete build/sign/upload flow with:

```bash
pnpm release:desktop -- --yes --resume
```

`--resume` requires both local and origin `v<version>` tags to point to `HEAD`, accepts no release or a draft release, refuses a published release, and replaces draft assets with `--clobber` only after a fresh successful signing handoff. If the tag push itself failed, push that existing local tag to origin first. The script never deletes tags automatically.

For a narrowly scoped manual recovery when the script cannot dispatch the workflow, use the production dispatch shown above, download the named final artifact with `gh run download`, and use only its signed installer when repairing a draft release. Never upload the workflow's `SHA256SUMS.windows.txt` as a release asset, never upload the local unsigned installer, and regenerate the release-wide `SHA256SUMS` after any replacement.

## Full release procedure

### 1. Choose the next version

Use stable semver only:

```txt
2.0.0
2.0.1
2.1.0
3.0.0
```

Do not use `0.0.0` or prerelease tags unless the release script is intentionally changed.

### 2. Bump package versions

For a **desktop-only release** that changes only the Electron app and GitHub desktop artifacts, bump `apps/desktop/package.json` only. Do not bump or publish public npm packages unless their package contents changed.

Desktop-only releases may intentionally use a different version than the root workspace and public npm packages. The GitHub desktop release tag follows `apps/desktop/package.json`, and the app update checker reads GitHub Releases, not npm.

For a full workspace/npm release, update all workspace package versions together so bundled packages and npm packages report the same release version.

Use a new version for every release artifact you publish. npm package versions are immutable, so any change to a published package requires a new version across all public OpenPets npm packages.

Files to update for a full workspace/npm release:

```txt
package.json
apps/desktop/package.json
packages/agent-events/package.json
packages/claude/package.json
packages/cli/package.json
packages/client/package.json
packages/cursor/package.json
packages/install-pet/package.json
packages/mcp/package.json
packages/opencode/package.json
packages/pet-format/package.json
packages/pi/package.json
packages/sdk/package.json
```

Set each top-level `version` field to the chosen version, for example:

```json
"version": "2.0.1"
```

### 3. Install/update lockfile if needed

Run:

```bash
pnpm install
```

If `pnpm-lock.yaml` changes, include it in the version bump commit.

### 4. Run checks before committing

Run:

```bash
pnpm build
pnpm --filter @open-pets/desktop check
```

Fix any failures before continuing.

### 5. Commit and push the version bump

Check status:

```bash
git status --short
```

Commit the version bump and any intentional release changes. For a desktop-only release, stage `apps/desktop/package.json` instead of every package manifest.

```bash
git add package.json apps/desktop/package.json packages/*/package.json pnpm-lock.yaml
git commit -m "release desktop v<version>"
git push
```

Only add files that are intentionally part of the release. Do not accidentally include unrelated worktree changes.

### 6. Confirm GitHub CLI auth

Run:

```bash
gh auth status --hostname github.com
```

If not authenticated:

```bash
gh auth login
```

### 7. Optional dry run

Run:

```bash
pnpm release:desktop -- --dry-run
```

This should pass preflight, build artifacts, generate a local preview checksum,
and stop before creating a tag, dispatching SignPath, or changing GitHub. The
dry-run Windows installer is unsigned and is not a release asset. A dry run is
recommended for risky releases, but it can be skipped when the current release
has already been validated and the user explicitly approves publishing directly.

If it fails because the tree is dirty, inspect:

```bash
git status --short
```

The release script requires a clean tree before release creation.

### 8. Build, sign, verify, and publish the GitHub Release

For the standard full-artifact desktop release:

```bash
pnpm release:desktop -- --yes
```

The script builds locally while the tag does not exist, creates and pushes an
annotated tag, automatically dispatches the production SignPath workflow, and
waits for its final artifact. It then replaces the local unsigned Windows
installer, calculates `SHA256SUMS`, creates a **draft** release, uploads only
the final artifacts and `SHA256SUMS`, verifies the exact remote asset names,
and publishes the release named/tagged:

```txt
v<version>
```

Example:

```txt
v2.0.1
```

If SignPath pauses for approval, approve the request in the SignPath dashboard;
the script continues waiting and fails if the workflow does not succeed. If a
signing or upload failure leaves the tag pushed, recover with:

```bash
pnpm release:desktop -- --yes --resume
```

`--resume` is only for the same tagged `HEAD` and refuses a published release.

### 9. Smoke test after publishing

After publishing the release, manually test at least:

- macOS DMG on the current Mac.
- Windows installer on a Windows machine or VM.
- Linux AppImage on a Linux machine or VM.

Warnings behavior to expect:

- macOS may show Gatekeeper warnings.
- Windows may show SmartScreen reputation warnings on first launch, even for signed installers. This is usually reduced after repeated trustworthy downloads.

### Linux release-smoke VM

Use the clean Ubuntu release-smoke VM for Linux artifact install checks that
should behave like a normal user machine, not the development VM with a repo
checkout and build dependencies.

The VM is documented in `/Volumes/external/repos/vagrants.md`:

```txt
VM directory: /Volumes/external/vmware/ubuntu24-release-smoke
Provider: vmware_desktop / VMware Fusion
Guest OS: Ubuntu 24.04 ARM64
SSH: 127.0.0.1:2200 when the main Ubuntu VM already owns 2222
```

Start and enter the VM from macOS:

```bash
cd /Volumes/external/vmware/ubuntu24-release-smoke
vagrant up
vagrant ssh
```

This VM intentionally does **not** mount the macOS OpenPets checkout. Use it to
download and install released Linux artifacts from GitHub/R2 like a user would.

Smoke checklist inside the VM:

1. Download/install the current Linux release artifact.
2. Launch OpenPets from the installed artifact, not from a repo checkout.
3. Confirm the tray icon appears.
4. Confirm a pet window appears.
5. Open Control Center.
6. Confirm the live plugin catalog loads from `https://openpets.dev/plugins/catalog.v2.json`.
7. Confirm community plugins, including `openpets.spotify-buddy`, appear as installable when the live catalog includes them.
8. Install, enable, and open configuration for at least one plugin without crashes or raw `$t:` strings.

The existing `/Volumes/external/vmware/ubuntu24` VM remains the Linux development
VM. Prefer `ubuntu24-release-smoke` for fresh-user release validation, and use
the dev VM only for build/debug workflows.

## Common failure modes

### Version is `0.0.0`

Fix `apps/desktop/package.json` and the other workspace package versions.

### Dirty working tree

The release script refuses to create releases from a dirty checkout. Commit, stash, or revert changes first.

### HEAD is not pushed

Push the current branch before releasing:

```bash
git push
```

### Tag or release already exists

For a normal release, use a new version after inspecting GitHub. If this is a
failed release attempt and local/origin `v<version>` both point to `HEAD`, use
`pnpm release:desktop -- --yes --resume`; do not delete tags automatically.

### Partial GitHub upload failure or replacing an existing release's assets

The script keeps the release draft until the complete final asset set is
uploaded and verified. If an upload fails:

1. Inspect the release on GitHub.
2. Re-run the complete tagged flow:

```bash
pnpm release:desktop -- --yes --resume
```

3. Re-check the release asset list; do not trust a wrapper's success summary if
   `gh release view` shows missing assets.
4. Never repair a public release with an unsigned Windows installer or
   `SHA256SUMS.windows.txt`. If the script is unavailable, manually upload only
   the verified final assets to the existing **draft** with `--clobber`, then
   verify the exact set before publishing.

## Manual packaging smoke commands

These do not create a GitHub Release:

```bash
pnpm --filter @open-pets/desktop build
node apps/desktop/scripts/clean-package-output.cjs
pnpm --dir apps/desktop exec electron-builder --mac dmg --x64 --publish never
pnpm --dir apps/desktop exec electron-builder --mac dmg --arm64 --publish never
pnpm --dir apps/desktop exec electron-builder --win nsis --x64 --publish never
pnpm --dir apps/desktop exec electron-builder --linux AppImage --x64 --publish never
pnpm --dir apps/desktop exec electron-builder --linux rpm --x64 --publish never
```

Artifacts are written to:

```txt
apps/desktop/dist-electron/
```

## Linux DEB/RPM fallback via VMware

Use this flow when the local macOS release host cannot produce valid Linux DEB
or RPM artifacts. This happened for `v3.2.0`: RPM failed under macOS
`fpm`/`rpmbuild`, and the generated DEB was a 96-byte invalid archive. Building
the Linux package targets inside the Ubuntu VMware guest produced valid x64
artifacts.

The VM is documented in `/Volumes/external/repos/vagrants.md`:

```txt
VM directory: /Volumes/external/vmware/ubuntu24
Guest checkout: /home/vagrant/src/openpets
Provider: vmware_desktop / VMware Fusion
```

Start and prepare the VM from macOS:

```bash
cd /Volumes/external/vmware/ubuntu24
vagrant up
vagrant ssh -c 'set -e; cd /home/vagrant/src/openpets; git fetch origin --tags; git checkout main; git pull --ff-only'
vagrant ssh -c 'set -e; sudo apt-get update; sudo apt-get install -y rpm fakeroot'
```

Build only the Linux package targets in the guest:

```bash
vagrant ssh -c 'set -e; cd /home/vagrant/src/openpets; pnpm install --frozen-lockfile; pnpm --filter @open-pets/desktop build; cd apps/desktop; node scripts/clean-package-output.cjs; pnpm exec electron-builder --linux deb --x64 --publish never; pnpm exec electron-builder --linux rpm --x64 --publish never; ls -lh dist-electron/OpenPets-<version>-linux-amd64.deb dist-electron/OpenPets-<version>-linux-x86_64.rpm; file dist-electron/OpenPets-<version>-linux-amd64.deb dist-electron/OpenPets-<version>-linux-x86_64.rpm'
```

Copy the valid artifacts back through the VM's `/vagrant` share, then place
them in an absolute host staging directory. Do not put them in
`apps/desktop/dist-electron/`; the release script cleans that directory and
copies the validated files into it itself:

```bash
vagrant ssh -c 'set -e; cp /home/vagrant/src/openpets/apps/desktop/dist-electron/OpenPets-<version>-linux-amd64.deb /vagrant/; cp /home/vagrant/src/openpets/apps/desktop/dist-electron/OpenPets-<version>-linux-x86_64.rpm /vagrant/'
STAGING_DIR="/absolute/path/openpets-linux-packages/<version>"
mkdir -p "$STAGING_DIR"
cp /Volumes/external/vmware/ubuntu24/OpenPets-<version>-linux-amd64.deb "$STAGING_DIR/"
cp /Volumes/external/vmware/ubuntu24/OpenPets-<version>-linux-x86_64.rpm "$STAGING_DIR/"
```

Run the complete release flow with the same staging directory for the dry run
and production command:

```bash
pnpm release:desktop -- --dry-run --linux-package-dir "$STAGING_DIR"
pnpm release:desktop -- --yes --linux-package-dir "$STAGING_DIR"
```

The option requires exactly these two files, rejects symlinks and packages
smaller than 1 MiB, skips only the local DEB/RPM builds, and copies the files under
`dist-electron` before strict artifact validation. This remains a full release:
do not publish a partial set or upload the staged files directly. If using
`--include-experimental-arm`, add it to both commands; the unsigned Windows
ARM installer remains disposable and is not published.

## Microsoft Store package quick actions

Use this flow when Partner Center rejects the unsigned Win32 `.exe` installer under Store policy 10.2.9. GitHub Releases should still prefer the NSIS setup `.exe`; Microsoft Store submission should use the Store package artifact.

Important Partner Center routing:

- Do **not** paste an `.appx` URL into the standalone `.exe`/`.msi` package URL field. That field is only for signed Win32 installers.
- Start a Microsoft Store **MSIX/AppX package** submission and upload the `.appx` package directly.
- If reusing the same app name from a failed Win32 submission is blocked, delete/abandon the Win32 package flow and recreate the submission as MSIX/AppX.

Electron Builder v26 uses the Windows Store target name `appx`. There is no separate `msix` target in this project setup; Partner Center accepts AppX/MSIX-family uploads.

AppX tile assets are separate from `win.icon`/`app-icon.ico`. Keep branded tile assets in `apps/desktop/build/appx/`; if these files are missing, Electron Builder falls back to its bundled `SampleAppx.*.png` placeholders and Microsoft Store certification rejects the package as using default tile images.

Required OpenPets AppX tile assets:

```txt
apps/desktop/build/appx/StoreLogo.png
apps/desktop/build/appx/Square44x44Logo.png
apps/desktop/build/appx/Square150x150Logo.png
apps/desktop/build/appx/Wide310x150Logo.png
```

Additional branded assets currently included:

```txt
apps/desktop/build/appx/SmallTile.png
apps/desktop/build/appx/LargeTile.png
apps/desktop/build/appx/BadgeLogo.png
apps/desktop/build/appx/SplashScreen.png
```

These assets are generated from `apps/desktop/assets/app-icon.png` plus OpenPets-branded tile art. Do not delete or rename them unless the AppX manifest/build config is updated at the same time.

Build a Windows x64 AppX package:

```bash
pnpm --filter @open-pets/desktop build
pnpm --filter @open-pets/desktop exec electron-builder --win appx --x64 \
  -c.appx.identityName=AlvinUnreal.OpenPetsDesktopCompanion \
  -c.appx.publisher=CN=5749BA4D-6A45-4111-8CAA-6B151AEDC238 \
  -c.appx.publisherDisplayName=AlvinUnreal \
  -c.appx.displayName="OpenPets: Desktop Companion" \
  -c.appx.applicationId=OpenPetsDesktopCompanion
```

`publisherDisplayName` must match the exact publisher display name shown by Partner Center. For the current Store account this is:

```txt
AlvinUnreal
```

If Partner Center reports `The PublisherDisplayName element ... doesn't match your publisher display name`, rebuild the AppX with the correct `-c.appx.publisherDisplayName=<Partner Center publisher display name>` value.

Partner Center validates AppX identity against the reserved Store product identity. For the current Store reservation, the expected values are:

```txt
identityName: AlvinUnreal.OpenPetsDesktopCompanion
package family name: AlvinUnreal.OpenPetsDesktopCompanion_aq5mzr83863gr
publisher: CN=5749BA4D-6A45-4111-8CAA-6B151AEDC238
displayName: OpenPets: Desktop Companion
applicationId: OpenPetsDesktopCompanion
```

If Partner Center reports `Invalid package identity name`, `Invalid package family name`, `Invalid package publisher name`, or an unreserved `Package/Properties/DisplayName`, rebuild using the exact values above. The package family name is derived from `identityName` and `publisher`, so do not set it manually.

Expected artifact:

```txt
apps/desktop/dist-electron/OpenPets-<version>-win-x64.appx
```

On macOS, AppX packaging runs Windows `makeappx.exe` through Parallels. If the repo is on an external drive and the build fails with `prlctl process failed 2` or a `\\Mac\\Host\\Volumes\\...` path error, either enable Parallels shared folders for all Mac disks or copy the repo to a Parallels-accessible home-folder path and build there.

If Electron Builder creates the AppX staging folder but fails only at the final `makeappx.exe` step because Parallels cannot resolve `\\Mac\\Host` paths, a manual fallback is:

1. Copy the Electron Builder `winCodeSign` cache into the accessible build folder.
2. Rewrite `dist-electron/__appx-x64/mapping.txt` paths from `\\Mac\\Host\\Users\\<user>` to `C:\\Mac\\Home`.
3. Run `makeappx.exe pack` from the Windows VM against the rewritten mapping file.

Known-good local workaround path from the May 2026 Store packaging session:

```txt
/Users/alvin/Downloads/openpets-msix-build/apps/desktop/dist-electron/OpenPets-2.5.0-win-x64.appx
```

Known-good corrected `2.5.0` AppX after rebuilding with Store identity values:

```txt
SHA256 4cc451a94d4be146b18ac59eb011ef3e89ff46e4e0836c8de0f36e68ad9b4a25
```

Verify the final AppX contains OpenPets tile assets, not Electron Builder sample defaults:

```bash
python3 - <<'PY'
from zipfile import ZipFile
appx = 'apps/desktop/dist-electron/OpenPets-<version>-win-x64.appx'
with ZipFile(appx) as z:
    for name in [
        'assets/StoreLogo.png',
        'assets/Square44x44Logo.png',
        'assets/Square150x150Logo.png',
        'assets/Wide310x150Logo.png',
        'assets/SmallTile.png',
        'assets/LargeTile.png',
        'assets/BadgeLogo.png',
        'assets/SplashScreen.png',
    ]:
        print(name, z.getinfo(name).file_size)
PY
```

Partner Center may warn that the restricted capability `runFullTrust` requires approval. This is expected for Electron desktop bridge/AppX packages because the manifest uses `EntryPoint="Windows.FullTrustApplication"` and `rescap:Capability Name="runFullTrust"`. The warning must be acknowledged or approved in Partner Center; it is not fixed by changing the URL or repackaging as a standalone `.exe`.

Upload the Store package to the public R2-backed download host:

```bash
bunx wrangler r2 object put \
  "openpets/releases/OpenPets-<version>-win-x64.appx" \
  --file "apps/desktop/dist-electron/OpenPets-<version>-win-x64.appx" \
  --remote
```

Public URL shape:

```txt
https://zip.openpets.dev/releases/OpenPets-<version>-win-x64.appx
```

Verify before submitting to Partner Center:

```bash
curl -I "https://zip.openpets.dev/releases/OpenPets-<version>-win-x64.appx"
```

R2 upload is optional for Partner Center MSIX/AppX submissions because the Store package flow accepts direct file upload. Use R2 only as a backup/share URL or for internal handoff.

## NPM package release

OpenPets publishes these public npm packages, in dependency order:

```txt
@open-pets/plugin-sdk
@open-pets/client
@open-pets/agent-events
@open-pets/mcp
@open-pets/claude
@open-pets/opencode
@open-pets/cursor
@open-pets/pi
@open-pets/cli
install-pet
```

Do not publish the private workspace root, `@open-pets/desktop`, or `@open-pets/pet-format`.

Publish all public packages together at the same version whenever any public package changes. The CLI depends on the other `@open-pets/*` packages by exact published version, so partial/mixed-version npm releases can break `npx -y @open-pets/cli ...`.

The npm release helper enforces one shared version across every package in its publish order, including `@open-pets/plugin-sdk`. If this release publishes SDK v3, bump the existing public packages to the same version before running the helper.

Dry-run npm publishing first:

```bash
pnpm release:npm
```

Publish all missing packages to npm. Package versions that already exist on npm are skipped automatically. The helper pins its npm authentication check, registry probes, and `pnpm publish` commands to `https://registry.npmjs.org`. Before the publish plan, it logs each registry probe. Its 30-second watchdog stops the release and terminates the probe process tree; only npm's structured `E404` missing-version response for that exact package version is treated as unpublished. Registry, process, network, and authentication failures stop the release:

```bash
pnpm release:npm -- --yes
```

If npm requires two-factor auth:

```bash
pnpm release:npm -- --yes --otp <code>
```

Publishing with the npm helper requires `npm whoami --registry https://registry.npmjs.org` to succeed, a clean working tree, and local `HEAD` to match the upstream branch.

After publishing, verify the npm dependency set resolves:

```bash
npm view @open-pets/plugin-sdk@<version> version
npm view @open-pets/client@<version> version
npm view @open-pets/agent-events@<version> version
npm view @open-pets/mcp@<version> version
npm view @open-pets/claude@<version> version
npm view @open-pets/opencode@<version> version
npm view @open-pets/cursor@<version> version
npm view @open-pets/pi@<version> version
npm view @open-pets/cli@<version> version
npm view install-pet@<version> version
npx -y @open-pets/cli@<version> --help
```

## Important notes for future agents

- Do not publish from an uncommitted local state.
- Do not use `--skip-checks` with `--yes`; the script rejects this.
- `--dry-run` is local only; it does not create tags, dispatch SignPath, or change GitHub.
- Use `--resume` only with `--yes` after a failed tagged attempt; it refuses published releases.
- Do not upload the entire `dist-electron` directory manually. Upload only final top-level artifacts and `SHA256SUMS`.
- Do not upload `SHA256SUMS.windows.txt` or a locally built unsigned Windows installer.
- Keep the tag format as `v<version>`.
- Keep `publish: null` in `electron-builder.yml`; GitHub release upload is handled by the local script.
- Windows icon is `apps/desktop/assets/app-icon.ico`.
- macOS icon is `apps/desktop/assets/app-icon.icns`.
- Windows artifacts are signed in the release handoff, but Windows SmartScreen reputation warnings may still appear on first run.
- macOS artifacts may still show Gatekeeper warnings until notarization is configured.
