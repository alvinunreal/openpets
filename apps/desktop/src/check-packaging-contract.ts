import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { allowedReactions } from "./local-ipc-protocol.js";
import { pickReactionMessage, reactionMessagePools } from "./reaction-messages.js";

const distDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(distDir);
const repoRoot = resolve(appDir, "../..");
const packageJson = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; description?: string; author?: string };
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
const workspaceConfig = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
const builderConfigPath = join(appDir, "electron-builder.yml");
const builderConfig = readFileSync(builderConfigPath, "utf8");

assert.equal(packageJson.description, "OpenPets tray-first desktop companion app.");
assert.equal(packageJson.author, "OpenPets");
assert.match(packageJson.scripts?.["dev:debug"] ?? "", /OPENPETS_LOG_LEVEL=debug OPENPETS_LOG_CONSOLE=1 pnpm dev/, "desktop debug dev script must enable verbose log mirroring.");
assert.match(packageJson.scripts?.package ?? "", /node scripts\/clean-package-output\.cjs && electron-builder/);
assert.match(packageJson.scripts?.["package:dir"] ?? "", /node scripts\/clean-package-output\.cjs && electron-builder --dir/);
assert.equal(rootPackageJson.scripts?.["package:desktop:dir"], "pnpm build && pnpm --filter @open-pets/desktop package:dir");
assert.equal(packageJson.dependencies?.["@open-pets/claude"], "workspace:*");
assert.equal(packageJson.dependencies?.["@open-pets/cli"], "workspace:*");
assert.equal(packageJson.dependencies?.["@open-pets/cursor"], "workspace:*");
assert.equal(packageJson.dependencies?.["@open-pets/mcp"], "workspace:*");
assert.equal(packageJson.dependencies?.["@open-pets/opencode"], "workspace:*");
assert.equal(packageJson.dependencies?.["@open-pets/agent-events"], "workspace:*");
assert.equal(packageJson.dependencies?.["@img/sharp-win32-x64"], undefined, "sharp platform binaries must stay optional transitive deps, not direct host-breaking dependencies.");
assert.match(workspaceConfig, /supportedArchitectures:[\s\S]*?os:[\s\S]*?- darwin[\s\S]*?- win32[\s\S]*?- linux/, "pnpm must install optional sharp binaries for desktop release OS targets.");
assert.match(workspaceConfig, /supportedArchitectures:[\s\S]*?cpu:[\s\S]*?- x64[\s\S]*?- arm64/, "pnpm must install optional sharp binaries for desktop release CPU targets.");
assert.match(workspaceConfig, /supportedArchitectures:[\s\S]*?libc:[\s\S]*?- glibc/, "pnpm must install optional sharp binaries for Linux glibc release targets.");
assert.match(packageJson.devDependencies?.["electron-builder"] ?? "", /^\^26\.(?:9|[1-9]\d)\./, "desktop AppImage packaging must use electron-builder 26.9+ for conditional Linux sandbox handling.");
assert.match(builderConfig, /appId:\s*dev\.openpets\.app/);
assert.match(builderConfig, /productName:\s*OpenPets/);
assert.match(builderConfig, /executableName:\s*openpets/, "desktop packages must use a safe executable name for the stricter AppImage toolset.");
assert.match(builderConfig, /output:\s*dist-electron/);
assert.match(builderConfig, /linux:[\s\S]*?target:[\s\S]*?- AppImage[\s\S]*?- deb[\s\S]*?- rpm[\s\S]*?- tar\.gz/, "desktop Linux packaging must include AppImage, deb, rpm, and tar.gz targets.");
assert.match(builderConfig, /publish:\s*null/);
assert.doesNotMatch(builderConfig, /no-sandbox/, "desktop packaging must not force --no-sandbox for every Linux AppImage launch.");
assert.match(builderConfig, /toolsets:\s*\n\s*appimage:\s*1\.0\.3/, "desktop AppImage packaging must use the AppImage 1.0.3 toolset so the launcher can conditionally fall back when Linux sandboxing is unavailable.");
assert.match(builderConfig, /asar:\s*true/);
assert.match(builderConfig, /asarUnpack:/);
assert.match(builderConfig, /node_modules\/\*\*/);
assert.match(builderConfig, /dist\/\*\*/);
assert.match(builderConfig, /control-center-preload\.cjs/);
assert.match(builderConfig, /pet-preload\.cjs/);
assert.match(builderConfig, /plugin-sdk-preload\.cjs/);
assert.match(builderConfig, /plugin-command-form-preload\.cjs/);
assert.match(builderConfig, /assets\/\*\*/);
assert.match(builderConfig, /extraResources:[\s\S]*from:\s*\.\.\/\.\.\/plugins\/official[\s\S]*to:\s*plugins\/official/, "desktop packages must include bundled official plugins as extra resources.");
assert.match(builderConfig, /icon:\s*assets\/app-icon\.icns/);

assert.ok(existsSync(join(appDir, "control-center-preload.cjs")), "control-center-preload.cjs must exist for Control Center IPC.");
assert.ok(existsSync(join(appDir, "pet-preload.cjs")), "pet-preload.cjs must exist for pet window motion state updates.");
assert.ok(existsSync(join(appDir, "plugin-sdk-preload.cjs")), "plugin-sdk-preload.cjs must exist for JavaScript plugin SDK hosting.");
assert.ok(existsSync(join(appDir, "plugin-command-form-preload.cjs")), "plugin-command-form-preload.cjs must exist for plugin command forms.");
assert.ok(existsSync(join(appDir, "assets", "tray-icon.png")), "tray icon must exist for packaging.");
assert.ok(existsSync(join(appDir, "assets", "app-icon.icns")), "app icon must exist for packaging.");
assert.ok(existsSync(join(appDir, "assets", "app-icon.ico")), "Windows app icon must exist for packaging.");
assertNonEmptyFile(join(appDir, "assets", "default-pet-spritesheet.webp"), "default pet spritesheet must exist for packaging.");
assertNonEmptyFile(join(appDir, "assets", "default-pet-thumbnail.png"), "default pet thumbnail must exist for Pet Manager preview.");
assertNonEmptyFile(join(appDir, "assets", "NotoColorEmoji.ttf"), "pet windows must bundle an emoji font so fresh Linux installs render plugin emoji icons.");
for (const icon of ["claude.svg", "cursor.svg", "opencode.svg", "pi.svg", "vscode.svg", "windsurf.svg", "zed.svg"]) {
  assertSafeBundledSvg(join(appDir, "assets", "integrations", icon), `integration icon must be safe and packaged: ${icon}`);
}
assert.match(readFileSync(join(appDir, "src", "assets.ts"), "utf8"), /assets["']?,\s*["']tray-icon\.png|join\("assets", "tray-icon\.png"\)/, "tray icon code must keep using assets/tray-icon.png.");
const petWindowSource = readFileSync(join(appDir, "src", "pet-window.ts"), "utf8");
const controlCenterPreloadSource = readFileSync(join(appDir, "control-center-preload.cjs"), "utf8");
const controlCenterRendererSource = readFileSync(join(appDir, "src", "renderer", "src", "main.tsx"), "utf8");
const petPreloadSource = readFileSync(join(appDir, "pet-preload.cjs"), "utf8");
const reactionMessagesSource = readFileSync(join(appDir, "src", "reaction-messages.ts"), "utf8");
const displaySource = readFileSync(join(appDir, "src", "display.ts"), "utf8");
const updateCheckerSource = readFileSync(join(appDir, "src", "update-checker.ts"), "utf8");
const traySource = readFileSync(join(appDir, "src", "tray.ts"), "utf8");
const enCatalogSource = readFileSync(join(appDir, "src", "i18n", "locales", "en.ts"), "utf8");
const windowsSource = readFileSync(join(appDir, "src", "windows.ts"), "utf8");
const lanControllerSource = readFileSync(join(appDir, "src", "lan-controller.ts"), "utf8");
const lanHttpControllerSource = readFileSync(join(appDir, "src", "lan-http-controller.ts"), "utf8");
const localeSources = new Map([
  ["es-419", readFileSync(join(appDir, "src", "i18n", "locales", "es-419.ts"), "utf8")],
  ["ja", readFileSync(join(appDir, "src", "i18n", "locales", "ja.ts"), "utf8")],
  ["ko", readFileSync(join(appDir, "src", "i18n", "locales", "ko.ts"), "utf8")],
  ["pt-BR", readFileSync(join(appDir, "src", "i18n", "locales", "pt-BR.ts"), "utf8")],
  ["zh-Hans", readFileSync(join(appDir, "src", "i18n", "locales", "zh-Hans.ts"), "utf8")],
  ["zh-Hant", readFileSync(join(appDir, "src", "i18n", "locales", "zh-Hant.ts"), "utf8")],
]);
const agentSetupSource = readFileSync(join(appDir, "src", "agent-setup.ts"), "utf8");
const loggerSource = readFileSync(join(appDir, "src", "logger.ts"), "utf8");
const mainSource = readFileSync(join(appDir, "src", "main.ts"), "utf8");
const appStateSource = readFileSync(join(appDir, "src", "app-state.ts"), "utf8");
const lifecycleSource = readFileSync(join(appDir, "src", "lifecycle.ts"), "utf8");
const localIpcSourceForLogging = readFileSync(join(appDir, "src", "local-ipc.ts"), "utf8");
const localIpcPathsSource = readFileSync(join(appDir, "src", "local-ipc-paths.ts"), "utf8");
const leaseManagerSource = readFileSync(join(appDir, "src", "lease-manager.ts"), "utf8");
const defaultPetControllerSource = readFileSync(join(appDir, "src", "default-pet-controller.ts"), "utf8");
const agentPetControllerSourceForLogging = readFileSync(join(appDir, "src", "agent-pet-controller.ts"), "utf8");
const mappingDoc = readFileSync(join(repoRoot, "docs", "pets.md"), "utf8");
assert.match(loggerSource, /openpets\.log/, "desktop logger must write a user-sendable openpets.log file.");
assert.match(loggerSource, /openpets\.previous\.log/, "desktop logger must retain a previous log file for bug reports.");
assert.match(loggerSource, /OPENPETS_LOG_LEVEL/, "desktop logger must support verbose dev logging via environment.");
assert.match(loggerSource, /normalizeLogLevel\(process\.env\.OPENPETS_LOG_LEVEL\) \?\? "debug"/, "desktop production logger must default to debug for user-sendable diagnostics.");
assert.match(loggerSource, /redacted-token/, "desktop logger must redact token-looking values.");
assert.match(mainSource, /initializeLogger\(\)/, "desktop startup must initialize logging before subsystem startup.");
assert.ok(!existsSync(join(appDir, "src", "analytics.ts")), "desktop PostHog analytics module must be removed.");
assert.doesNotMatch(mainSource + lifecycleSource + windowsSource + localIpcSourceForLogging + updateCheckerSource + appStateSource + controlCenterPreloadSource, /trackDesktopEvent|trackDesktopStartup|trackDesktopIntegrationActivity|initializeDesktopAnalytics|shutdownDesktopAnalytics|classifyAnalyticsError|setDesktopAnalyticsConsent|getDesktopAnalyticsConsentState|openpets:set-desktop-analytics-consent|PostHog|OPENPETS_POSTHOG/, "desktop runtime must not retain PostHog/analytics capture hooks.");
assert.match(appStateSource, /activity:\s*{[\s\S]*messagesSent/, "local dashboard activity counters must remain in app state without analytics identity fields.");
assert.doesNotMatch(appStateSource, /distinctId|OpenPetsAnalyticsState|DesktopAnalyticsConsentState|recordDesktopAppStarted|markFirstAgentReactionTracked/, "app state must not retain PostHog identity or consent fields.");
assert.match(mainSource, /isLinux && !allowWayland[\s\S]*?appendSwitch\("ozone-platform", "x11"\)/, "Linux desktop pets must force X11/Xwayland because native Wayland blocks always-on-top and programmatic window positioning.");
assert.match(mainSource, /if \(process\.platform === "linux"\) \{\n\s*app\.commandLine\.appendSwitch\("password-store", "gnome-libsecret"\);\n\s*\} else \{\n\s*app\.commandLine\.appendSwitch\("password-store", "basic"\);\n\s*\}/, "Linux desktop must gate password-store as gnome-libsecret on Linux with basic only in the non-Linux else branch; an unconditional switch would disable Electron safeStorage and break plugin secret saves with 'Secret storage encryption is unavailable on this system'.");
const passwordStoreValues = [...mainSource.matchAll(/appendSwitch\("password-store",\s*"([^"]+)"\)/g)].map((match) => match[1]);
assert.deepStrictEqual(passwordStoreValues, ["gnome-libsecret", "basic"], "desktop must set password-store exactly twice (gnome-libsecret on Linux, basic otherwise); any extra or unconditional switch would override the backend and re-break plugin secret saves.");
assert.match(mainSource, /OPENPETS_ALLOW_WAYLAND/, "Linux X11 override must support the OPENPETS_ALLOW_WAYLAND opt-out escape hatch.");
assert.match(traySource, /t\("tray\.openLogsFolder"\)/, "desktop tray must expose user-sendable logs for bug reports.");
assert.match(enCatalogSource, /Open Logs Folder/, "English catalog must keep the user-sendable logs label.");
assert.match(localIpcSourceForLogging, /request received/, "desktop IPC must log request methods for diagnostics.");
assert.match(localIpcPathsSource, /OPENPETS_IPC_BIND[\s\S]*?OPENPETS_IPC_ENDPOINT[\s\S]*?validateBindHost[\s\S]*?validateAdvertisedHost/, "WSL NAT IPC must separate bind and advertised endpoints with validation.");
assert.match(localIpcPathsSource, /OPENPETS_IPC_ENDPOINT only controls the advertised discovery endpoint[\s\S]*?OPENPETS_IPC_BIND to opt into TCP IPC listening/, "OPENPETS_IPC_ENDPOINT-only mode must not start TCP listening; OPENPETS_IPC_BIND is the explicit TCP opt-in.");
assert.match(localIpcPathsSource, /OPENPETS_IPC_ENDPOINT must use the same port as OPENPETS_IPC_BIND unless OPENPETS_IPC_BIND uses port 0/, "WSL NAT advertised endpoint must not silently override mismatched ports.");
for (const key of ["eyebrow", "title", "description", "refresh", "mode", "host", "server", "auth", "authToken", "authEnv", "authStored", "authGenerated", "authInsecure", "authNone", "tokenHint", "tokenHintValue", "currentOwner", "persistedOwner"]) {
  for (const [locale, source] of localeSources) {
    assert.match(source, new RegExp(`"settings\\.lan\\.${key}"\\s*:`), `LAN settings label must be translated for ${locale}: settings.lan.${key}`);
  }
}
assert.match(lanControllerSource, /maxLanResponseBodyBytes\s*=\s*16 \* 1024/, "LAN client responses must be capped before JSON parsing.");
assert.match(lanControllerSource, /size > maxLanResponseBodyBytes[\s\S]*?req\.destroy\(new Error\("response_too_large"\)\)/, "LAN client must stop reading oversized coordinator responses.");
assert.match(lanControllerSource, /generateIfMissing: false/, "LAN status snapshots must not generate or rotate auth tokens.");
assert.doesNotMatch(lanHttpControllerSource, /access-control-allow-origin/i, "LAN coordinator must not expose status or mutation responses through wildcard CORS.");
assert.match(leaseManagerSource, /acquired/, "lease manager must log lease acquisition details.");
assert.match(defaultPetControllerSource, /show requested/, "default pet controller must log show lifecycle events.");
assert.match(agentPetControllerSourceForLogging, /show requested/, "agent pet controller must log show lifecycle events.");
assert.ok(petWindowSource.includes("defaultPetSprite.frameWidth * defaultPetSprite.columns") && petWindowSource.includes("defaultPetSprite.frameHeight * defaultPetSprite.rows"), "pet renderer must derive universal spritesheet dimensions from frame size and row/column counts.");
for (const reaction of ["idle", "thinking", "working", "editing", "running", "testing", "waiting", "waving", "success", "error", "celebrating"]) {
  assert.match(reactionMessagesSource, new RegExp(`${reaction}:\\s*\\[`), `reaction messages must define a pool for: ${reaction}`);
}
assert.match(reactionMessagesSource, /satisfies Record<OpenPetsReaction, readonly string\[\]>/, "reaction-only bubble message pools must be exhaustive over OpenPetsReaction.");
assert.match(petWindowSource, /pickReactionMessage\(display\.reaction\b/, "reaction-only bubbles must render randomized messages instead of raw lowercase reaction ids.");
assert.match(petWindowSource, /function preparePetTransientDisplay/, "reaction-only bubbles must prepare a stable random message before rerenders.");
assert.match(petWindowSource, /function mergePetTransientDisplay/, "reaction-only events must not replace an active explicit message bubble.");
assert.match(petWindowSource, /return \{ \.\.\.current, reaction: next\.reaction, dismissToken: next\.dismissToken \?\? current\.dismissToken \}/, "reaction-only updates merged into an active message must carry the latest dismiss token.");
assert.match(petWindowSource, /function getTransientDisplayDurationMs[\s\S]*?12_000[\s\S]*?message\.length \* 70/, "speech bubbles must stay visible longer for longer messages without becoming permanent.");
assert.match(defaultPetControllerSource, /getTransientDisplayDurationMs\(transientDisplay\)/, "default pet speech bubble timeout must be length-aware.");
assert.match(agentPetControllerSourceForLogging, /getTransientDisplayDurationMs\(preparedDisplay\)/, "agent pet speech bubble timeout must be length-aware.");
assert.match(petWindowSource, /function getTransientReactionAnimationMs/, "finite reaction animations must expose their own shorter lifetime.");
assert.match(petWindowSource, /function clearTransientReaction/, "finite reaction animations must be clearable while the bubble remains visible.");
assert.match(petWindowSource, /webContents\.send\("openpets:pet-reaction-state"/, "finite reaction animations must clear sprite state without reloading the bubble.");
assert.match(petPreloadSource, /openpets:pet-reaction-state/, "pet preload must accept in-place reaction state updates.");
assert.match(petWindowSource, /const webContents = window\.webContents[\s\S]*?const removeListeners = \(\): void => \{[\s\S]*?if \(!webContents\.isDestroyed\(\)\)/, "pet window cleanup must capture webContents and avoid touching destroyed BrowserWindow objects.");
assert.match(petWindowSource, /window\.on\("close", removeListeners\);\s*window\.once\("closed", removeListeners\);/, "pet window cleanup must run before and after close so agent lease release and Cmd/Ctrl+W are idempotent.");
assert.match(displaySource, /width:\s*340/, "pet windows must fit the huge pet scale without clipping while staying bounded around pet and bubble.");
assert.match(displaySource, /height:\s*420/, "pet windows must be tall enough for adaptive long message bubbles at huge pet scale without becoming a huge click shield.");
assert.match(petWindowSource, /function getBubbleClassName/, "pet bubbles must classify explicit messages by length.");
assert.match(petWindowSource, /is-long-message/, "pet bubbles must have a long-message layout.");
assert.match(petWindowSource, /is-very-long-message/, "pet bubbles must have a very-long-message layout for 140-character say messages.");
assert.match(petWindowSource, /body \{ -webkit-app-region: no-drag; pointer-events: none; \}/, "transparent pet window background must not capture clicks or drags.");
assert.match(petWindowSource, /function installMousePassthroughAndDrag/, "pet windows must install real mouse passthrough and controlled drag behavior.");
assert.match(petWindowSource, /export function shouldUseWaylandNativePetDrag/, "Wayland sessions must use compositor-native pet dragging.");
assert.doesNotMatch(petWindowSource, /OPENPETS_WAYLAND_NATIVE_DRAG/, "Wayland native pet dragging must not depend on a debug experiment flag.");
assert.match(petWindowSource, /shouldUseWaylandNativePetDrag\(\) \? "drag" : "no-drag"/, "native pet drag regions must be scoped to actual Wayland sessions.");
assert.match(petWindowSource, /font-src file:/, "pet window CSP must allow the bundled emoji font file.");
assert.match(petWindowSource, /OpenPets Emoji/, "pet windows must use the bundled emoji font for host/plugin icon glyphs.");
assert.match(petWindowSource, /setIgnoreMouseEvents\(true, \{ forward: true \}\)/, "transparent pet window background must use OS-level mouse passthrough.");
assert.match(petWindowSource, /setIgnoreMouseEvents\(false\)/, "visible pet and bubble hit targets must re-enable mouse handling.");
assert.match(petWindowSource, /openpets:pet-ready/, "pet windows must resync passthrough after each renderer reload.");
assert.match(petWindowSource, /function installMousePassthroughAndDrag[\s\S]*?const rearmPassthrough[\s\S]*?process\.platform !== "win32"[\s\S]*?rearmWindowsMouseForwarding\(reason\)/, "Windows pet reloads must toggle forwarded mouse passthrough to re-register hover and drag tracking.");
assert.match(petWindowSource, /scheduleWindowsMouseForwardingRearm\(`\$\{reason\}\+75ms`, 75\);[\s\S]*?scheduleWindowsMouseForwardingRearm\(`\$\{reason\}\+175ms`, 175\);/, "Windows pet reloads must retry mouse forwarding rearm after load settles.");
assert.match(petWindowSource, /openpets:pet-probe-hit-test/, "Windows pet reloads must probe current cursor hit target when mousemove forwarding is stale.");
assert.match(petWindowSource, /export function recoverPetMouseInterop/, "pet windows must expose a controlled mouse interop recovery hook for OS display and resume events.");
assert.match(petWindowSource, /petMouseInteropRecovery\.set\(window, scheduleMouseInteropRecovery\)/, "pet windows must register their mouse interop recovery callback.");
assert.match(petWindowSource, /function installMousePassthroughAndDrag[\s\S]*?scheduleWindowsForwardingWatch[\s\S]*?rearmWindowsMouseForwarding\(reason, false\)[\s\S]*?scheduleWindowsForwardingWatch\(reason\)/, "Windows pet passthrough must keep rearming while idle so hover and drag recover after pet reloads without noisy logs.");
assert.match(petPreloadSource, /openpets:pet-probe-hit-test[\s\S]*?elementFromPoint\(clientX, clientY\)[\s\S]*?reportInteractiveHit/, "pet preload must answer main-process cursor hit-test probes.");
assert.match(petWindowSource, /did-finish-load", rearmAfterLoad/, "pet windows must re-arm mouse passthrough after every content load.");
assert.match(petWindowSource, /did-fail-load", handleLoadFailure/, "pet windows must restore passthrough after failed content loads.");
assert.match(petWindowSource, /window\.setIgnoreMouseEvents\(false\);[\s\S]*?await window\.loadFile/, "pet reloads must reset OS mouse passthrough before navigation.");
assert.match(petWindowSource, /function allocateWindowLoadSequence/, "pet content reloads must allocate request sequence before async rendering.");
assert.match(petWindowSource, /tryUpdateLoadedPetContent\(window, render, "default", sequence\)/, "default pet transient updates must avoid BrowserWindow reloads when the pet document is already loaded.");
assert.match(petPreloadSource, /openpets:pet-content-state[\s\S]*?document\.body\.innerHTML/, "pet preload must accept sanitized in-place content updates for transient bubbles and badges.");
assert.match(petWindowSource, /windowLoadChains\.set\(window, next\)/, "pet content reloads must serialize loadFile calls per BrowserWindow.");
assert.match(petWindowSource, /next\.catch\(\(\) => \{\}\)\.finally/, "pet content reload chain cleanup must not create unhandled rejections.");
assert.match(petWindowSource, /destroyed-after-write/, "pet content reloads must re-check destroyed windows after writing HTML.");
assert.match(petWindowSource, /process\.platform === "win32" \? "none" : "drop-shadow/, "Windows pet windows must avoid CSS drop-shadow on transparent layered windows.");
assert.match(petWindowSource, /process\.platform === "win32" \? "none" : "blur\(10px\)"/, "Windows pet windows must avoid backdrop-filter on transparent layered windows.");
assert.match(petWindowSource, /const petDragRegion = shouldUseWaylandNativePetDrag\(\) \? "drag" : "no-drag";/, "pet dragging must default away from Electron draggable regions so right-click context menus work.");
assert.match(petPreloadSource, /openpets:pet-hit-test/, "pet preload must report visible pet and bubble hit testing for passthrough.");
assert.match(petPreloadSource, /openpets:pet-ready/, "pet preload must report readiness after installing mouse handlers.");
assert.match(petPreloadSource, /openpets:pet-drag-start/, "pet preload must start controlled pet dragging from the sprite.");
assert.match(defaultPetControllerSource, /powerMonitor\.on\("resume", recoverDefaultPetWindowAfterResume\)/, "default pet must recover mouse interop after Windows sleep or resume.");
assert.match(defaultPetControllerSource, /recoverDefaultPetMouseInterop\("display-change"\)/, "default pet must recover mouse interop after monitor topology changes.");
assert.match(windowsSource, /recoverDefaultPetMouseInterop\("default-pet-changed"\)/, "changing default pet must recover mouse interop for dragging without app restart.");
assert.match(petWindowSource, /function installPetContextMenu/, "pet windows must install a native right-click context menu.");
assert.match(petWindowSource, /webContents\.on\("context-menu"/, "pet context menu must be handled in the Electron main process.");
assert.match(petWindowSource, /Menu\.buildFromTemplate/, "pet context menu must use a small native Electron menu.");
assert.doesNotMatch(petPreloadSource, /setIgnoreMouseEvents/, "pet preload must not call Electron window APIs directly.");
const agentPetControllerSource = readFileSync(join(appDir, "src", "agent-pet-controller.ts"), "utf8");
const localIpcSource = readFileSync(join(appDir, "src", "local-ipc.ts"), "utf8");
assert.match(agentPetControllerSource, /dismissedAgentPets = new Set<string>/, "agent pets must remember manual close while leases remain active.");
assert.match(agentPetControllerSource, /dismissAgentPetForActiveLease/, "agent pet context-menu close must dismiss the pet for the active lease.");
assert.match(agentPetControllerSource, /dismissedAgentPets\.has\(petId\)/, "dismissed agent pets must not reopen on later same-lease reactions.");
assert.match(agentPetControllerSource, /function clearAgentPetLeaseState/, "agent pet lease cleanup must clear dismissal, timers, and hidden transient state.");
assert.match(localIpcSource, /handleLastExplicitLease/, "agent pet dismissal must clear when the explicit lease group ends.");
assert.match(localIpcSource, /clearAgentPetLeaseState\(petId\)/, "last explicit lease cleanup must reset dismissed agent pet state.");
assert.match(localIpcSource, /reason: applied\.reason/, "IPC responses must report dismissed explicit pet events as not shown.");
assert.match(updateCheckerSource, /alvinunreal\/openpets/, "GitHub release notice must check the public OpenPets repository.");
assert.match(updateCheckerSource, /api\.github\.com\/repos\/\$\{githubRepository\}\/releases\/latest/, "update checker must use GitHub latest release API.");
assert.match(updateCheckerSource, /shell\.openExternal\(url\)/, "update action must open the GitHub release page externally.");
assert.match(traySource, /t\("tray\.updateAvailable"/, "tray menu must surface available updates.");
assert.match(enCatalogSource, /Update available:/, "English catalog must keep the update-available label.");
assert.match(windowsSource, /openpets:check-for-updates/, "settings window must be able to trigger update checks.");
assert.match(windowsSource, /openpets:get-reaction-animation-settings/, "settings window must be able to load reaction animation metadata.");
assert.match(windowsSource, /reactionAnimationOverrides/, "settings window must be able to persist reaction animation overrides.");
assert.match(windowsSource, /openpets-pet-preview/, "settings reaction preview must use a scoped internal pet preview protocol.");
assert.match(windowsSource, /openpets:open-update-release-page/, "settings window must be able to open the release page.");
assert.doesNotMatch(windowsSource, /openpets:set-desktop-analytics-consent/, "settings window must not expose desktop analytics consent IPC.");
assert.match(controlCenterPreloadSource, /checkForUpdates/, "Control Center preload must expose update checks.");
assert.doesNotMatch(controlCenterPreloadSource, /setDesktopAnalyticsConsent/, "Control Center preload must not expose desktop analytics consent updates.");
assert.match(controlCenterPreloadSource, /getReactionAnimationSettings/, "Control Center preload must expose reaction animation settings metadata.");
assert.match(controlCenterRendererSource, /function SettingsView\(\)/, "Control Center must include the settings page.");
assert.match(controlCenterRendererSource, /getPetsState/, "Control Center must include the pets page data bridge.");
assert.match(controlCenterRendererSource, /function IntegrationsView\(\)/, "Control Center must include the integrations page.");
assert.match(petWindowSource, /max-width:\s*min\(220px/, "very long message bubbles must stay capped within the tight pet window.");
assert.match(petWindowSource, /-webkit-line-clamp:\s*8/, "very long message bubbles must allow enough visible lines.");
assert.match(petWindowSource, /createSpriteStateCss\("\.sprite"\)/, "built-in sprite CSS must react to reaction state.");
assert.match(petWindowSource, /createSpriteStateCss\("\.installed-sprite"\)/, "installed sprite CSS must react to reaction state.");
assert.match(petWindowSource, /html\[data-motion-state=\"\$\{motion\}\"\] \$\{selector\}/, "sprite CSS must let drag motion override reaction state.");
assert.match(petWindowSource, /\.sprite, \.installed-sprite, \.bubble/, "reduced-motion CSS must include built-in and installed sprites.");
assert.match(petWindowSource, /function createAgentPetWindow[\s\S]*?installMotionStatePublisher\(window\)/, "agent pet windows must publish motion state so dragged non-default pets run.");
assert.match(petWindowSource, /loadExplicitPetContent[\s\S]*?state\.preferences\.petScale/, "explicit agent pet windows must use the saved pet scale preference.");
assert.match(petWindowSource, /interface AgentPetWindowOptions[\s\S]*?readonly scale: PetScaleValue/, "new agent pet windows must receive the current pet scale explicitly for their first render.");
assert.match(petWindowSource, /loadExplicitPetContent\(window, options\.petId, options\.display, options\.badge, dismissToken, options\.scale\)/, "agent pet first render must not fall back to the medium default scale.");
assert.match(agentPetControllerSourceForLogging, /function getPreferredPetScale\(\): PetScaleValue/, "agent pet reloads must share one explicit saved scale helper.");
assert.match(agentPetControllerSourceForLogging, /loadExplicitPetContent\(window, petId, display, badge, getCurrentDismissToken\(petId, display, badge\), scale\)/, "agent pet refreshes must pass the saved pet scale explicitly.");
assert.match(agentPetControllerSourceForLogging, /loadExplicitPetContent\(window, petId, preparedDisplay, statusBadges\.get\(petId\) \?\? null, preparedDisplay\.dismissToken, getPreferredPetScale\(\)\)/, "agent pet transient updates must pass the saved pet scale explicitly.");
assert.match(mappingDoc, /waving/i, "pet docs must describe waving animation behavior.");
assert.match(mappingDoc, /reaction-animation-mapping\.ts/, "mapping docs must reference the shared reaction animation mapping source of truth.");
assert.match(mappingDoc, /overrid/i, "mapping docs must mention that reaction animation defaults can be overridden in Settings.");
assert.doesNotMatch(mappingDoc, /bubble-only|currently \*\*bubble states\*\*/i, "mapping docs must not describe reactions as bubble-only.");
for (const reaction of allowedReactions) {
  const pool = reactionMessagePools[reaction];
  assert.ok(pool.length >= 8, `reaction message pool must include clear variants for: ${reaction}`);
  for (const message of pool) {
    assert.match(message, /^[A-Z]/, `reaction message must start uppercase: ${message}`);
    assert.doesNotMatch(message, /[\r\n]/, `reaction message must be single-line: ${message}`);
    assert.ok(message.length <= 36, `reaction message must stay bubble-friendly: ${message}`);
  }
}
assert.equal(pickReactionMessage("success", () => 0), reactionMessagePools.success[0], "reaction message picking must be deterministic when random is injected.");
assert.doesNotMatch(controlCenterRendererSource, /OnboardingView|getOnboardingSnapshot|completeOnboarding/, "Control Center must not include the removed onboarding route.");
assert.match(controlCenterRendererSource, /function IntegrationsView\(\)/, "Control Center must include integrations.");
assert.match(enCatalogSource, /Claude Code/, "Control Center integrations must include Claude Code.");
assert.match(enCatalogSource, /OpenCode/, "Control Center integrations must include OpenCode.");
assert.match(enCatalogSource, /Cursor/, "Control Center integrations must include Cursor.");
assert.match(enCatalogSource, /Pi/, "Control Center integrations must include Pi.");
assert.doesNotMatch(agentSetupSource, /JSON\.parse\(prepared\.configWrite\.content\)/, "OpenCode desktop preview must parse JSONC planned config safely, not JSON.parse.");
assert.match(windowsSource, /refreshDefaultPetContent\(\);\s*refreshAgentPetContent\(\);/, "pet scale preference changes must refresh default and agent pet windows.");
assert.ok(existsSync(join(appDir, "scripts", "clean-package-output.cjs")), "package output cleanup helper must exist.");
assert.ok(existsSync(join(appDir, "scripts", "check-windows-symlink-privilege.cjs")), "Windows package symlink preflight helper must exist.");
assert.ok(existsSync(join(distDir, "main.js")), "desktop main build output must exist before packaging checks run.");
assert.ok(existsSync(join(repoRoot, "packages", "claude", "dist", "index.js")), "@open-pets/claude must be built before packaging.");
assert.ok(existsSync(join(repoRoot, "packages", "client", "dist", "index.js")), "@open-pets/client must be built before packaging.");
assert.ok(existsSync(join(repoRoot, "packages", "mcp", "dist", "index.js")), "@open-pets/mcp must be built before packaging.");
assert.ok(existsSync(join(repoRoot, "packages", "cli", "dist", "index.js")), "@open-pets/cli must be built before packaging.");
assert.ok(existsSync(join(repoRoot, "packages", "opencode", "dist", "plugin.js")), "@open-pets/opencode plugin must be built before packaging.");
assert.ok(existsSync(join(repoRoot, "packages", "agent-events", "dist", "index.js")), "@open-pets/agent-events must be built before packaging.");

if (process.argv.includes("--output")) {
  checkPackageOutput();
} else {
  checkCleanupHelper();
}

console.error("Packaging contract validation passed.");

function checkPackageOutput(): void {
  const outputDir = join(appDir, "dist-electron");
  assert.ok(existsSync(outputDir), "dist-electron output must exist after packaging.");
  assertNoForbiddenOutput(outputDir);
  assertNoEscapingSymlinks(outputDir);

  const appResourceDir = findPackagedAppResourceDir(outputDir);
  assert.ok(appResourceDir, "packaged app resources directory was not found.");
  assert.ok(existsSync(join(appResourceDir, "app.asar")), "packaged app.asar is missing.");
  assertBundledOfficialPlugins(appResourceDir);
  const appContents = join(appResourceDir, "app.asar.unpacked");
  assert.ok(existsSync(appContents), "packaged app.asar.unpacked resources are missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "claude", "dist", "index.js")), "packaged @open-pets/claude runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "claude", "dist", "cli.js")), "packaged @open-pets/claude CLI runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "claude", "package.json")), "packaged @open-pets/claude package metadata is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "client", "dist", "index.js")), "packaged @open-pets/client runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "client", "package.json")), "packaged @open-pets/client package metadata is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "mcp", "dist", "index.js")), "packaged @open-pets/mcp runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "mcp", "package.json")), "packaged @open-pets/mcp package metadata is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "cli", "dist", "index.js")), "packaged @open-pets/cli runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "opencode", "dist", "plugin.js")), "packaged @open-pets/opencode plugin runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "opencode", "package.json")), "packaged @open-pets/opencode package metadata is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "cursor", "dist", "index.js")), "packaged @open-pets/cursor runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "cursor", "package.json")), "packaged @open-pets/cursor package metadata is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "agent-events", "dist", "index.js")), "packaged @open-pets/agent-events runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@modelcontextprotocol", "sdk")), "packaged MCP SDK runtime dependency is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "zod", "index.cjs")), "packaged zod runtime dependency is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "yauzl", "index.js")), "packaged yauzl runtime dependency is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "yauzl", "fd-slicer.js")), "packaged yauzl fd-slicer helper is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "buffer-crc32", "index.js")), "packaged yauzl transitive dependency buffer-crc32 is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "pend", "index.js")), "packaged yauzl transitive dependency pend is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "sharp", "lib", "index.js")), "packaged sharp runtime is missing.");
  assertPackagedHostSharpNative(appContents);
  assertRegularNonSymlink(join(appContents, "node_modules", "@open-pets", "mcp", "dist", "index.js"));
  assertRegularNonSymlink(join(appContents, "node_modules", "@open-pets", "cli", "dist", "index.js"));
  assertRegularNonSymlink(join(appContents, "node_modules", "@open-pets", "opencode", "dist", "plugin.js"));
  assertRegularNonSymlink(join(appContents, "node_modules", "@open-pets", "claude", "dist", "cli.js"));
  assertCommandSmoke(appContents);
}

function findPackagedAppResourceDir(outputDir: string): string | null {
  const candidates: string[] = [];
  collectDirectories(outputDir, candidates, 4);

  for (const dir of candidates) {
    if (existsSync(join(dir, "app.asar")) || existsSync(join(dir, "app", "dist", "main.js"))) {
      return dir;
    }
  }

  return null;
}

function collectDirectories(dir: string, result: string[], depth: number): void {
  if (depth < 0 || !existsSync(dir)) return;
  result.push(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) collectDirectories(join(dir, entry.name), result, depth - 1);
  }
}

function assertNoForbiddenOutput(outputDir: string): void {
  const forbiddenSegments = new Set(["v1", "web", ".env", ".claude"]);
  for (const path of walk(outputDir)) {
    const rel = relative(outputDir, path);
    const segments = rel.split(/[\\/]/g);
    assert.ok(!segments.includes("docs") || !segments.includes("phases"), `package output must not include phase docs: ${rel}`);
    for (const segment of segments) {
      assert.ok(!forbiddenSegments.has(segment) && !segment.startsWith(".env"), `package output contains forbidden path segment: ${rel}`);
    }
  }
}

function assertNoEscapingSymlinks(outputDir: string): void {
  const outputReal = realpathSync(outputDir);
  for (const path of walk(outputDir)) {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) continue;
    const target = realpathSync(path);
    assert.ok(isInside(outputReal, target), `package output symlink escapes package directory: ${relative(outputDir, path)} -> ${target}`);
  }
}

function walk(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    result.push(path);
    if (entry.isDirectory()) {
      result.push(...walk(path));
    }
  }
  return result;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function checkCleanupHelper(): void {
  const sentinel = join(appDir, "dist-electron", ".openpets-clean-sentinel");
  mkdirSync(dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, "stale", "utf8");
  const result = spawnSync(process.execPath, [join(appDir, "scripts", "clean-package-output.cjs")], { cwd: appDir, encoding: "utf8" });
  assert.equal(result.status, 0, `cleanup helper failed: ${result.stderr || result.stdout}`);
  assert.ok(!existsSync(sentinel), "cleanup helper did not remove stale package output sentinel.");
}

function assertRegularNonSymlink(path: string): void {
  assert.ok(!lstatSync(path).isSymbolicLink(), `packaged command file must not be a symlink: ${path}`);
  assert.ok(lstatSync(path).isFile(), `packaged command file must be regular: ${path}`);
}

function assertNonEmptyFile(path: string, message: string): void {
  assert.ok(existsSync(path), message);
  const stat = lstatSync(path);
  assert.ok(stat.isFile(), message);
  assert.ok(stat.size > 0, message);
}

function assertBundledOfficialPlugins(resourceDir: string): void {
  for (const id of ["openpets.reminders"]) {
    const dir = join(resourceDir, "plugins", "official", id);
    const manifestPath = join(dir, "openpets.plugin.json");
    assertNonEmptyFile(manifestPath, `packaged bundled plugin manifest is missing: ${id}`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { entry?: string };
    if (manifest.entry) assertNonEmptyFile(join(dir, manifest.entry), `packaged bundled plugin entry is missing: ${id}`);
  }
}

function assertSafeBundledSvg(path: string, message: string): void {
  assertNonEmptyFile(path, message);
  const source = readFileSync(path, "utf8");
  assert.doesNotMatch(source, /<script\b/i, `${message}: script tags are not allowed.`);
  assert.doesNotMatch(source, /\son[a-z]+\s*=/i, `${message}: event attributes are not allowed.`);
  assert.doesNotMatch(source, /(?:href|xlink:href)\s*=\s*["'](?:https?:|file:|javascript:)/i, `${message}: external or script hrefs are not allowed.`);
  assert.doesNotMatch(source.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/gi, ""), /https?:\/\//i, `${message}: remote references are not allowed.`);
}

function assertPackagedHostSharpNative(appContents: string): void {
  const sharpPackage = getHostSharpPackageName();
  assert.ok(existsSync(join(appContents, "node_modules", "@img", sharpPackage, "lib", `${sharpPackage}.node`)), `packaged host sharp native binary is missing: ${sharpPackage}`);
}

function getHostSharpPackageName(): string {
  if (process.platform === "win32" && process.arch === "x64") return "sharp-win32-x64";
  if (process.platform === "win32" && process.arch === "arm64") return "sharp-win32-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "sharp-darwin-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "sharp-darwin-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "sharp-linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "sharp-linux-arm64";
  throw new Error(`Unsupported packaging platform for sharp native check: ${process.platform}/${process.arch}`);
}

function assertCommandSmoke(appContents: string): void {
  const mcpEntry = join(appContents, "node_modules", "@open-pets", "mcp", "dist", "index.js");
  const mcp = spawnSync(process.execPath, [mcpEntry, "--version"], { encoding: "utf8" });
  assert.equal(mcp.status, 0, `packaged MCP command smoke failed: ${mcp.stderr || mcp.stdout}`);

  const hookEntry = join(appContents, "node_modules", "@open-pets", "claude", "dist", "cli.js");
  const hook = spawnSync(process.execPath, [hookEntry, "hook", "--openpets-managed"], {
    input: JSON.stringify({ hook_event_name: "Notification", message: "safe" }),
    encoding: "utf8",
    env: { ...process.env, OPENPETS_DISCOVERY_FILE: join(appContents, "missing-ipc.json") },
  });
  assert.equal(hook.status, 0, `packaged Claude hook command smoke failed: ${hook.stderr || hook.stdout}`);
  assert.equal(hook.stdout, "");

  const opencodePlugin = join(appContents, "node_modules", "@open-pets", "opencode", "dist", "plugin.js");
  const plugin = spawnSync(process.execPath, ["--input-type=module", "--eval", `const mod = await import(${JSON.stringify(`file://${opencodePlugin}`)}); if (!mod.default?.server || !mod.default?.id) process.exit(2);`], { encoding: "utf8" });
  assert.equal(plugin.status, 0, `packaged OpenCode plugin smoke failed: ${plugin.stderr || plugin.stdout}`);
}
