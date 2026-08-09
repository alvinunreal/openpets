---
description: Run OpenPets desktop, catalog, Windows signing, Linux package, Microsoft Store, GitHub Release, and npm release procedures.
---

# Release guide

This maintainer runbook covers OpenPets desktop releases, npm package releases,
and the plugin/catalog publishing steps that often ship beside a desktop build.
The desktop release flow builds macOS and Linux artifacts locally from macOS,
then uses GitHub Actions and SignPath to build and sign the Windows x64
installer before collecting the final verified GitHub Release artifacts. The
local flow does not build a disposable Windows x64 NSIS installer.

The desktop release runs as a sequence of **checkpointed stages**, not as one
long all-or-nothing command. Every stage that succeeds is recorded, so a failure
in the middle of a two-hour release is recovered by re-running the exact same
command: finished work is skipped and the release resumes at the stage that
failed. See [Staged desktop releases](#staged-desktop-releases).

## Repository and app

- GitHub repo: `alvinunreal/openpets`
- Desktop app: `apps/desktop`
- Release script: `apps/desktop/scripts/release-local.mjs`
- Root command: `pnpm release:desktop`
- SignPath Windows workflow: `.github/workflows/signpath-windows.yml`
- Update checker expects GitHub release tags like `v2.0.0`.

## Release surfaces

Most OpenPets releases touch one or more of these surfaces:

- **Desktop app** - Electron host, bundled official plugins, pet rendering,
  integrations, catalog consumers, and update checks.
- **npm packages** - CLI, MCP server, client, SDK, and integration packages.
- **Plugin catalog** - generated catalog JSON, reviewed plugin ZIPs, provenance,
  and R2-hosted downloads.
- **Website catalog data** - app-facing JSON and static assets under `web/public`.

Keep each release scoped. A desktop-only fix does not require npm publishing.
An SDK or CLI contract change usually does.

## Desktop release checklist

Required validation before a desktop release:

```bash
pnpm --filter @open-pets/desktop check
pnpm --filter @open-pets/desktop test
pnpm plugins:locales
pnpm --filter @open-pets/desktop package:dir
```

Manual desktop QA:

1. Run normal desktop dev startup or a packaged app (`pnpm dev:desktop` or the output from `pnpm --filter @open-pets/desktop package:dir`) so bundled seeding runs.
2. Open tray → Plugins.
3. Confirm the bundled official plugins appear with translated names and
   descriptions. See [Official plugins](/official-plugins) for the current
   bundled/default-enabled set.
4. Confirm community plugins appear separately/labeled as community when present.
5. Confirm stale sample/legacy plugins do not appear unless intentionally
   migrated and listed in the current catalog.
6. Confirm plugin names, descriptions, config labels, command labels, and pet messages resolve through translations rather than raw `$t:` keys.
7. Exercise the SDK v3 surfaces used by official/community plugins: schedule, storage/state, commands, status, audio, notifications, pet reactions/interactions, movement, and any panel UI.
8. Configure Reminders, Water Reminder, Focus Buddy, Launch Buddy, Day Routine, Walkabout, and other config-heavy plugins with form controls, not JSON.
9. Run plugin commands from the Plugins UI and pet right-click menu when available.
10. Restart desktop and confirm enabled plugins reload without broken state or duplicate timers/listeners.
11. Inspect logs for plugin SDK, translation, permission, quota, and manifest validation errors.

For explicit local plugin development, run `pnpm dev:desktop:plugins` separately and confirm official plugins are loaded as local dev plugins and start disabled; this mode intentionally skips bundled seeding.

## Plugin catalog release checklist

Plugin catalog release includes:

- `plugins/official/**` and reviewed community plugin source.
- `web/public/plugins/catalog.v2.json`, regenerated from the current manifest v3 official and community plugin sources. Catalog entries include `publisherType: "official" | "community"`; desktop treats missing `publisherType` as official for older catalogs. The desktop runtime currently reads the v2 catalog endpoint even when the contained plugins use manifest v3 / SDK v3.
- `web/public/plugins/catalog.v1.json` retained as an empty compatibility catalog for old desktop versions.
- Removal or hiding of legacy sample plugin manifests from current public discovery.
- Updated public docs when lineup, permissions, commands, provenance, or
  publishing behavior changes.

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
2. Confirm `pnpm plugins:package` regenerated `web/public/plugins/catalog.v2.json` from the current official and community manifest v3 plugin lineup. Do not release if the checked-in v2 catalog still lists deprecated sample plugins instead of the current catalog.
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

## GitHub Release notes

The release script generates notes from the Git commit range between the previous
desktop tag and the release commit. Do not keep static release-note text in the
script or this guide; stale notes are worse than short generated notes.

The notes are written when the draft release is created, before publication, so
a risky release can be inspected on the draft rather than in a dry run. After
publishing, verify the GitHub Release body matches the actual commit range and
artifact set. If it does not, edit the release body immediately with
`gh release edit v<version> --notes-file <file>`.

## NPM release decision

NPM publishing is required if any of these are true:

- `@open-pets/plugin-sdk` should be available to plugin authors.
- CLI/MCP/client packages changed and users need the published package update.
- Existing published packages are incompatible with the desktop release in a way that affects normal use.

Before running `pnpm release:npm`, align every publishable package in
`scripts/release-npm.mjs` to one shared version. The release script rejects mixed
publishable package versions.

## Staged desktop releases

`pnpm release:desktop -- --yes` runs preflight once, then executes an ordered
stage plan. After each stage succeeds, the script appends it to a checkpoint
file:

```txt
apps/desktop/.release-state/v<version>.json
```

The checkpoint is gitignored and belongs to one version at one `HEAD` commit.

### Stage plan

| Stage | What it does |
| --- | --- |
| `checks` | `pnpm build` and `pnpm --filter @open-pets/desktop check` |
| `clean` | cleans `apps/desktop/dist-electron` (runs only once per checkpoint) |
| `build:mac-dmg` | macOS DMG x64 + arm64 |
| `build:mac-zip` | macOS ZIP x64 + arm64 |
| `build:linux-appimage` | Linux AppImage x64 |
| `build:linux-deb` | Linux DEB x64, rejected if under 1 MiB |
| `build:linux-rpm` | Linux RPM x64, rejected if under 1 MiB |
| `build:linux-targz` | Linux tar.gz x64 |
| `stage:linux-packages` | only with `--linux-package-dir`; copies validated Ubuntu DEB/RPM |
| `verify:local` | working-tree check plus the complete pre-signing artifact set |
| `tag` | creates and pushes the annotated `v<version>` tag at `HEAD` |
| `sign:dispatch` | dispatches the SignPath workflow and records its run id |
| `sign:collect` | waits for that recorded run, downloads and verifies the signed installer |
| `verify:final` | validates the signed artifact set and writes `SHA256SUMS` |
| `release:draft` | creates or refreshes the **draft** GitHub Release |
| `release:upload` | uploads only the assets GitHub is missing, then verifies the exact asset set |
| `release:publish` | publishes the verified draft |

Preflight still enforces macOS, `pnpm`/`gh` availability, GitHub CLI auth, an
`origin` pointing at `alvinunreal/openpets`, a clean working tree, an upstream
branch, `HEAD` matching upstream, and stable non-zero semver. It refuses an
existing tag or release unless the checkpoint says this release already reached
the `tag` stage at this `HEAD`.

### Resuming after a failure

Re-run the identical command. Completed stages are skipped:

```bash
pnpm release:desktop -- --yes
```

Two things make the resume trustworthy rather than merely fast:

- Each build stage records the size of the artifacts it produced. If an artifact
  was deleted or changed, that stage re-runs even though it is checkpointed.
- `sign:dispatch` stores the SignPath workflow run id. A resume re-attaches to
  that same run instead of dispatching a second signing request, so a failure
  during download or upload never re-triggers signing or a second approval.

A checkpoint is discarded automatically when `HEAD` moves or the desktop version
changes, because the built artifacts no longer match the release. This is why a
commit made to fix a failing release — even a docs-only one — costs a rebuild:
the script will not publish artifacts built from a different commit than the tag.

Changing `--include-experimental-arm` or `--linux-package-dir` does **not**
discard anything. The stages that are still in the plan keep their artifacts, and
only the stages the options actually changed are re-run. Dropping a target can
leave its artifact behind in `dist-electron`; `verify:local` rejects any
unexpected artifact, so use `--reset` if you want a guaranteed clean rebuild.

### Inspecting and controlling stages

```bash
pnpm release:desktop -- --yes --status
```

Prints the stage plan with `done`, `stale`, `pending`, or `always` for each
stage, plus the recorded SignPath run.

Force a stage and everything after it to re-run:

```bash
pnpm release:desktop -- --yes --from build:linux-rpm
pnpm release:desktop -- --yes --from sign:dispatch
```

Use `--from sign:dispatch` when the recorded SignPath run itself failed and a
fresh signing run is required. Discard the whole checkpoint with:

```bash
pnpm release:desktop -- --reset
```

`--resume` remains as a legacy flag for resuming a tagged `HEAD` when no
checkpoint exists (for example after the checkpoint file was deleted). It
requires local and origin `v<version>` tags to point to `HEAD` and refuses a
published release. Normal recovery no longer needs it.

Published releases are visible to the app update checker.

## Default release assets

Default command for every desktop release:

```bash
pnpm release:desktop -- --yes
```

The final release artifact set always includes the full x64 artifact set. The
local release script builds the macOS and Linux artifacts; GitHub Actions builds
and SignPath-signs the Windows x64 installer:

- macOS DMG: x64 + arm64
- macOS ZIP: x64 + arm64
- Windows NSIS installer: x64, built and SignPath-signed by the workflow, then downloaded into the final artifacts
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
Electron Builder can produce an invalid tiny DEB archive. The `build:linux-deb`
and `build:linux-rpm` stages reject a package smaller than 1 MiB, so this failure
stops the release at that stage instead of producing a partial artifact set. Do
not publish a partial release. Build valid DEB/RPM replacements inside the Ubuntu
VMware guest, place them in an external staging directory, and re-run with
`--linux-package-dir`. The script then skips the failing local DEB/RPM targets,
copies and validates the staged files into `dist-electron`, and continues only
with the complete final artifact set. Adding `--linux-package-dir` on a resume
keeps the macOS and AppImage artifacts that already built; only the DEB/RPM
stages are replaced. See
[Linux DEB/RPM fallback via VMware](#linux-debrpm-fallback-via-vmware).

`--include-experimental-arm` builds Windows ARM64 and Linux ARM64 locally. Only the Windows x64 installer is handed off to SignPath; the locally built unsigned Windows ARM64 installer remains disposable and is not uploaded. Only use this flag if the additional Linux artifact can be tested.

## Windows code signing with SignPath

OpenPets has a production certificate through the SignPath Foundation program. Use SignPath for Windows Authenticode signing before publishing Windows release artifacts. SignPath's GitHub trusted-build integration requires signing inputs to be uploaded from a GitHub Actions workflow artifact, so the local macOS release script does not build the Windows x64 NSIS installer; it dispatches the workflow, which builds and signs it.

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
   - `SIGNPATH_API_TOKEN` - API token for a SignPath user with submitter permission for the project/signing policy.
8. Add these GitHub repository variables:
   - `SIGNPATH_ORGANIZATION_ID` - SignPath organization ID.
   - `SIGNPATH_PROJECT_SLUG` - SignPath OpenPets project slug.

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

After the workflow succeeds, the script downloads its `signed-openpets-windows-x64` artifact to a temporary directory outside the repository. It requires exactly `OpenPets-<version>-win-x64-setup.exe` and `SHA256SUMS.windows.txt`, validates the handoff checksum, copies the signed installer into the final artifact directory, and then generates the release-wide `SHA256SUMS`. `SHA256SUMS.windows.txt` is not uploaded to the GitHub Release.

### Recovery when the automated handoff is interrupted

If the initial signing step fails after the tag was pushed, do not delete the tag. Re-run the same command:

```bash
pnpm release:desktop -- --yes
```

The checkpoint keeps the `tag` stage, so preflight accepts the existing tag, and the release resumes at the failed signing stage. If the SignPath run itself failed, the recorded run id is no longer usable and the script says so; dispatch a fresh signing run with `--from sign:dispatch`. If the tag push itself failed, push that existing local tag to origin first. The script never deletes tags automatically.

When no checkpoint exists — for example the checkpoint file was deleted, or the release was started from another machine — use the legacy flag, which requires both local and origin `v<version>` tags to point to `HEAD`, accepts no release or a draft release, and refuses a published release:

```bash
pnpm release:desktop -- --yes --resume
```

For a narrowly scoped manual recovery when the script cannot dispatch the workflow, use the production dispatch shown above, download the named final artifact with `gh run download`, and use only its signed installer when repairing a draft release. Never upload the workflow's `SHA256SUMS.windows.txt` as a release asset, never upload a locally built unsigned Windows installer (including the optional ARM64 installer), and regenerate the release-wide `SHA256SUMS` after any replacement.

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

### 7. Do not dry run

**Do not run `pnpm release:desktop -- --dry-run` as a warm-up.** A dry run builds
the full macOS and Linux artifact set, which is the slowest part of a release,
and then stops without tagging or publishing. Since the dry run and the real
release are separate invocations of the same build stages, the time is spent
twice for no additional safety.

The staged checkpoint already provides what a dry run used to provide: preflight
runs before anything is built, and any failure is resumable without repeating
finished work. Go straight to `--yes`.

The `--dry-run` flag still exists for the rare case where you want local
artifacts and `SHA256SUMS.local-preview` without any GitHub interaction at all.
It shares the build-stage checkpoint with a real release, so a dry run
immediately followed by `--yes` at the same `HEAD` will not rebuild. It is still
not part of the normal release path.

If preflight fails because the tree is dirty, inspect:

```bash
git status --short
```

The release script requires a clean tree before release creation.

### 8. Build, sign, verify, and publish the GitHub Release

For the standard full-artifact desktop release:

```bash
pnpm release:desktop -- --yes
```

The script works through the stage plan: it builds locally while the tag does not
exist, creates and pushes an annotated tag, dispatches the production SignPath
workflow and records its run id, waits for that run's signed artifact, adds the
signed Windows x64 installer to the final artifacts, calculates `SHA256SUMS`,
creates a **draft** release, uploads the assets GitHub is missing, verifies the
exact remote asset names, and publishes the release named/tagged:

```txt
v<version>
```

Example:

```txt
v2.0.1
```

If SignPath pauses for approval, approve the request in the SignPath dashboard;
the script continues waiting and fails if the workflow does not succeed. If a
signing or upload failure leaves the tag pushed, recover by re-running the same
command:

```bash
pnpm release:desktop -- --yes
```

The checkpoint skips the finished stages and resumes at the failed one. Inspect
what will run first with `--status`, and use `--from <stage>` when a completed
stage must be redone.

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
failed release attempt, re-run `pnpm release:desktop -- --yes`; the checkpoint
recognises the tag it created. If the checkpoint is gone and local/origin
`v<version>` both point to `HEAD`, use `pnpm release:desktop -- --yes --resume`.
Do not delete tags automatically.

### Partial GitHub upload failure or replacing an existing release's assets

The script keeps the release draft until the complete final asset set is
uploaded and verified. Assets are uploaded one at a time, and an asset already
present on the draft with a matching size is skipped, so a re-run only transfers
what is actually missing. If an upload fails:

1. Inspect the release on GitHub.
2. Re-run the same command:

```bash
pnpm release:desktop -- --yes
```

3. Re-check the release asset list; do not trust a wrapper's success summary if
   `gh release view` shows missing assets.
4. Never repair a public release with an unsigned Windows installer or
   `SHA256SUMS.windows.txt`. If the script is unavailable, manually upload only
   the verified final assets to the existing **draft** with `--clobber`, then
   verify the exact set before publishing.

## Manual packaging smoke commands

These do not create a GitHub Release and cover the locally built macOS/Linux
package smoke targets. The Windows x64 NSIS installer is built and signed by the
GitHub Actions workflow; test the signed workflow or release artifact instead
of building a disposable local x64 installer.

```bash
pnpm --filter @open-pets/desktop build
node apps/desktop/scripts/clean-package-output.cjs
pnpm --dir apps/desktop exec electron-builder --mac dmg --x64 --publish never
pnpm --dir apps/desktop exec electron-builder --mac dmg --arm64 --publish never
pnpm --dir apps/desktop exec electron-builder --linux AppImage --x64 --publish never
pnpm --dir apps/desktop exec electron-builder --linux rpm --x64 --publish never
```

Artifacts are written to:

```txt
apps/desktop/dist-electron/
```

## Linux DEB/RPM fallback via VMware

Use this flow when the local macOS release host cannot produce valid Linux DEB
or RPM artifacts. A common macOS failure mode is RPM failing under
`fpm`/`rpmbuild`, or Electron Builder producing a tiny invalid DEB archive.
Building the Linux package targets inside the Ubuntu VMware guest should produce
valid x64 artifacts.

The DEB failure is silent: Electron Builder logs `building target=deb` and exits
successfully, but writes a ~96 byte file. That file is a macOS `ar` stub rather
than a Debian package, which you can confirm from its header:

```bash
xxd apps/desktop/dist-electron/OpenPets-<version>-linux-amd64.deb | head -4
# !<arch> ... __.SYMDEF SORTED   <- macOS static library, not a .deb
```

It happens because Apple's BSD `ar` is used when `dpkg`/`dpkg-deb`/`fpm` are not
installed on the host. The `build:linux-deb` stage now rejects any package under
1 MiB, so this stops the release at that stage instead of reaching artifact
validation. Do not try to fix it by installing packaging tools on macOS; use the
Ubuntu guest, which is the validated path.

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

Run the complete release flow with the staging directory. Do not precede it with
a dry run:

```bash
pnpm release:desktop -- --yes --linux-package-dir "$STAGING_DIR"
```

This is normally a resume: the macOS, AppImage, and tar.gz artifacts built before
the DEB/RPM failure are kept, and only the `stage:linux-packages` copy replaces
the failed local package builds. Keep the flag on every subsequent resume of the
same release, since dropping it puts the failing local DEB/RPM stages back into
the plan.

The option requires exactly these two files, rejects symlinks and packages
smaller than 1 MiB, skips only the local DEB/RPM builds, and copies the files under
`dist-electron` before strict artifact validation. This remains a full release:
do not publish a partial set or upload the staged files directly. If using
`--include-experimental-arm`, keep it on every run too; the unsigned Windows
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

Keep session-specific workaround paths and checksums in the release issue or PR
notes for that version, not in this evergreen guide.

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

## Important notes for future maintainers

- Do not publish from an uncommitted local state.
- Do not use `--skip-checks` with `--yes`; the script rejects this.
- Do not dry run before a release. It doubles the build time and the staged checkpoint already makes retries cheap.
- Recover from any failed release by re-running the same `--yes` command; reach for `--from <stage>` only when a completed stage must be redone.
- `--dry-run` is local only; it does not create tags, dispatch SignPath, or change GitHub.
- `--resume` is a legacy fallback for a tagged `HEAD` with no checkpoint; it refuses published releases.
- The checkpoint under `apps/desktop/.release-state/` is disposable local state. Delete it with `--reset` if a release is abandoned.
- Do not upload the entire `dist-electron` directory manually. Upload only final top-level artifacts and `SHA256SUMS`.
- Do not upload `SHA256SUMS.windows.txt` or a locally built unsigned Windows installer, including the optional ARM64 installer.
- Keep the tag format as `v<version>`.
- Keep `publish: null` in `electron-builder.yml`; GitHub release upload is handled by the local script.
- Windows icon is `apps/desktop/assets/app-icon.ico`.
- macOS icon is `apps/desktop/assets/app-icon.icns`.
- Windows artifacts are signed in the release handoff, but Windows SmartScreen reputation warnings may still appear on first run.
- macOS artifacts may still show Gatekeeper warnings until notarization is configured.
