import { app, powerMonitor } from "electron";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import { getAppStateSnapshot, initializeAppState, releaseStartupInstallLock } from "./app-state.js";
import { initializeDesktopAnalytics, trackDesktopEvent, trackDesktopStartup } from "./analytics.js";
import { createAppIcon } from "./assets.js";
import { CompanionContributionStore } from "./companion-contributions.js";
import { initializeCompanionMemory } from "./companion-memory.js";
import { getCompanionSettings, initializeCompanionSettings } from "./companion-settings.js";
import { setLocaleFromPreference } from "./i18n/index.js";
import { installDefaultPetDisplayHandlers, shouldOpenDefaultPetOnLaunch, showDefaultPet } from "./default-pet-controller.js";
import { installAppLifecycle } from "./lifecycle.js";
import { startLanController } from "./lan-controller.js";
import { debug, error as logError, getLogFilePath, info, initializeLogger, warn } from "./logger.js";
import { startLocalIpcServer } from "./local-ipc.js";
import { startDevPluginWatcher } from "./plugin-dev-watcher.js";
import { createElectronPluginHostCapabilities } from "./plugin-host-capabilities.js";
import { defaultPluginPetApi } from "./plugin-pet-api.js";
import { initializePluginPlatformSettings } from "./plugin-platform-settings.js";
import { ElectronPluginJsHost } from "./plugin-js-host.js";
import { getPluginService, initializePluginService } from "./plugin-service.js";
import { createAppTray, refreshTrayMenu } from "./tray.js";
import { checkForGitHubReleaseUpdate } from "./update-checker.js";
import { installInternalUiHandlers, installInternalUiProtocol } from "./windows.js";
import { initializeVoicePlatform } from "./voice-platform.js";
import { initializeVoiceSettings } from "./voice-settings.js";

// OpenPets does not store browser passwords, cookies, or encrypted app secrets.
// Keep Chromium/Electron from prompting for macOS Keychain or Linux keyring access
// during startup/profile initialization.
app.commandLine.appendSwitch("use-mock-keychain");
app.commandLine.appendSwitch("password-store", "basic");

// Chromium's native window occlusion tracker treats every window on a display
// as occluded while a fullscreen app is active there and stops painting it.
// For transparent always-on-top pet windows that means the pet goes blank
// during any fullscreen video or game even when its z-order is intact.
// Occlusion-based paint throttling saves next to nothing for windows this
// small, so trade it away to keep the pet drawn.
if (process.platform === "win32") {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

// OpenPets requires programmatic window positioning and z-ordering, which
// native Wayland compositors disallow for XDG-shell toplevels. To ensure
// gravity, drag, and always-on-top work correctly on all KDE/GNOME Linux
// desktops, we force the x11/XWayland backend. Users who explicitly need
// native Wayland can set OPENPETS_ALLOW_WAYLAND=1, but gravity, walkabout,
// and manual drag will not function under native Wayland.
const isLinux = process.platform === "linux";
const allowWayland = process.env.OPENPETS_ALLOW_WAYLAND === "1";
const hasExplicitOzonePlatformArg = process.argv.some(
  (arg) => arg === "--ozone-platform" || arg.startsWith("--ozone-platform="),
);
// When OPENPETS_ALLOW_WAYLAND=1 we deliberately do NOT append an ozone-platform
// switch: Electron honours the system default (typically wayland on a Wayland
// session, or any explicit --ozone-platform the user passed) and we warn at
// startup that positioning/gravity/walkabout/drag are unsupported there.
if (isLinux && !allowWayland) {
  // Force x11 even if the user passed --ozone-platform=wayland or auto;
  // we overwrite any pre-existing switch so nothing silently slips through.
  app.commandLine.appendSwitch("ozone-platform", "x11");
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  installAppLifecycle();

  app.whenReady().then(async () => {
    initializeLogger();
    app.setName("OpenPets");
    if (process.platform === "win32") {
      app.setAppUserModelId("dev.openpets.app");
    }
    info("app", "startup begin", { version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged, pid: process.pid, ozonePlatform: app.commandLine.getSwitchValue("ozone-platform") || null, explicitOzonePlatformArg: hasExplicitOzonePlatformArg });
    if (isLinux && allowWayland) {
      const effectiveOzone = app.commandLine.getSwitchValue("ozone-platform") || "(auto/system)";
      warn("app", "native Wayland mode active — pet positioning, gravity, walkabout, and drag are unsupported under native Wayland; remove OPENPETS_ALLOW_WAYLAND=1 to restore full functionality", { effectiveOzone });
    }

    if (process.platform === "darwin") {
      app.dock?.setIcon(createAppIcon());
      app.dock?.hide();
    }

    initializeAppState();
    initializeVoiceSettings(app.getPath("userData"));
    initializeCompanionSettings(app.getPath("userData"));
    initializeCompanionMemory(app.getPath("userData"));
    initializePluginPlatformSettings(app.getPath("userData"));
    initializeDesktopAnalytics();
    trackDesktopStartup();
    // Resolve the UI language before any window or the tray is built.
    setLocaleFromPreference(getAppStateSnapshot().preferences.locale);
    installInternalUiProtocol();
    installInternalUiHandlers();
    createAppTray();
    installDefaultPetDisplayHandlers();
    await startLocalIpcServer();
    trackDesktopEvent("desktop_ipc_server_started");
    releaseStartupInstallLock();
    const roots = parseDevPluginEnv(process.env.OPENPETS_DEV_PLUGIN_ROOTS);
    const paths = parseDevPluginEnv(process.env.OPENPETS_DEV_PLUGIN_PATHS);
    const devPluginMode = roots.length > 0 || paths.length > 0;
    const companionContributions = new CompanionContributionStore({
      canContribute: ({ sensitivity }) => {
        const companion = getCompanionSettings();
        return companion.enabled
          && companion.context.pluginEnabled
          && (sensitivity === "normal" || companion.context.sensitivePluginEnabled);
      },
      isPluginEnabled: (pluginId) => {
        try { return getPluginService().stateStore.getRecord(pluginId)?.enabled === true; }
        catch { return false; }
      },
    });
    const pluginCapabilities = createElectronPluginHostCapabilities(app.getPath("userData"), { companionContributions });
    initializeVoicePlatform(pluginCapabilities);
    let devPluginWatcher: ReturnType<typeof startDevPluginWatcher> | undefined;
    const pluginService = initializePluginService(app.getPath("userData"), defaultPluginPetApi, app.getVersion(), new ElectronPluginJsHost(), writePluginRuntimeLog, process.env.OPENPETS_DISABLE_PLUGIN_CATALOG === "1" || devPluginMode, resolveBundledOfficialPluginRoots(), !devPluginMode, pluginCapabilities, (properties) => {
      trackDesktopEvent("desktop_plugin_runtime_error", properties);
    }, (sourcePath) => devPluginWatcher?.addPaths([sourcePath]), (sourcePath) => devPluginWatcher?.removePath(sourcePath));
    // Wall-clock schedules (daily/cron/at) re-arm deterministically after sleep.
    powerMonitor.on("resume", () => pluginService.runtime.resyncSchedules());
    if (shouldOpenDefaultPetOnLaunch()) {
      showDefaultPet();
      trackDesktopEvent("desktop_default_pet_shown", { reason: "launch" });
    }
    startLanController();
    refreshTrayMenu();
    void (async () => {
      const service = pluginService;
      await service.start();
      const persistedPaths = service.getLocalSourcePaths();
      for (const path of paths) {
        const result = await service.loadLocalPath(path, { autoApprove: true });
        if (!result.ok) logError("app", "dev plugin path load failed", new Error(result.error));
      }
      for (const path of persistedPaths.filter((path) => !paths.includes(path))) {
        const result = await service.loadLocalPath(path, { autoApprove: true });
        if (!result.ok) logError("app", "persisted local plugin load failed", new Error(result.error));
      }
      if (roots.length > 0) {
        const results = await service.loadLocalRoots(roots, { autoApprove: true, pruneStale: true });
        for (const result of results) if (!result.ok) logError("app", "dev plugin root load failed", new Error(`${result.path}: ${result.error}`));
      }
      const watchPaths = Array.from(new Set([...paths, ...service.getLocalSourcePaths()]));
      if (devPluginMode || watchPaths.length > 0) devPluginWatcher = startDevPluginWatcher(service, roots, watchPaths);
    })().catch((error) => logError("app", "plugin service startup failed", error));
    void checkForGitHubReleaseUpdate().then(() => refreshTrayMenu());
    info("app", "startup complete", { logFile: getLogFilePath(), openDefaultPetOnLaunch: shouldOpenDefaultPetOnLaunch() });
    console.log("OpenPets desktop shell ready.");
  }).catch((error: unknown) => {
    releaseStartupInstallLock();
    logError("app", "startup failed", error);
    console.error("Failed to start OpenPets desktop shell.", error);
    app.quit();
  });
}

function parseDevPluginEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(delimiter).map((item) => item.trim()).filter(Boolean).map((item) => resolve(item));
}

function resolveBundledOfficialPluginRoots(): string[] {
  const candidates = [join(process.resourcesPath, "plugins", "official"), resolve(process.cwd(), "plugins", "official"), resolve(app.getAppPath(), "..", "..", "plugins", "official")];
  return Array.from(new Set(candidates.filter((candidate) => existsSync(candidate))));
}

function writePluginRuntimeLog(level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void {
  if (level === "error") logError("plugin", message, fields);
  else if (level === "info") info("plugin", message, fields);
  else if (level === "warn") warn("plugin", message, fields);
  else debug("plugin", message, fields);
}
