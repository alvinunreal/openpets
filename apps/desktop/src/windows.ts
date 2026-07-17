import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import sharp from "sharp";

import { app, BrowserWindow, dialog, ipcMain, protocol, shell, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";

import { getAgentSetupSnapshot, runAgentSetupAction, updateAgentSetupCommandPaths } from "./agent-setup.js";
import { refreshAgentPetContent } from "./agent-pet-controller.js";
import { getAppStateSnapshot, getDesktopAnalyticsConsentState, normalizePetPoolOrder, petScaleOptions, setDesktopAnalyticsConsent, setPetPoolOrder, updatePreferences } from "./app-state.js";
import { applyRoamingToAllPets } from "./pet-roaming-controller.js";
import { classifyAnalyticsError, trackDesktopAnalyticsConsentChanged, trackDesktopEvent } from "./analytics.js";
import { createAppIcon } from "./assets.js";
import { clearCompanionMemory, removeCompanionMemoryForPet } from "./companion-memory.js";
import { disableCompanion, enableCompanion, getCompanionSettings, removeCompanionPetSettings, updateCompanionPetSettings, updateCompanionSettings } from "./companion-settings.js";
import { companionTargetIds, type CompanionTargetId } from "./companion-types.js";
import { getCatalogPageUiState, getCatalogSearchUiState, getCatalogUiState } from "./catalog.js";
import { getCodexPetsUiState, importCodexPet, readCodexPetSpritesheet } from "./codex-pets.js";
import { setConfinementEnabled } from "./confinement-manager.js";
import { setCrossDisplayRoamingEnabled } from "./display.js";
import { getActiveLocale, getActiveMessages, LOCALE_LABELS, SUPPORTED_LOCALES, setLocaleFromPreference, t, type Locale, type LocalePreference } from "./i18n/index.js";
import { recoverDefaultPetMouseInterop, refreshDefaultPetContent, resetDefaultPetToInitialPosition } from "./default-pet-controller.js";
import { getLanStatusSnapshot } from "./lan-controller.js";
import { validatePreferencePatch } from "./preference-patch.js";
import { installPet, installPetFromFolder, installPetFromZipFile, removePet, setDefaultInstalledPet } from "./pet-installation.js";
import { assertSafePetId, getInstalledPetDir } from "./pet-paths.js";
import { debug, error as logError, warn } from "./logger.js";
import { getPluginService, type PluginConfigSoundPickResult, type PluginServiceResult } from "./plugin-service.js";
import { defaultPetSprite, reactionAnimationMetadata, selectableAnimationMetadata } from "./reaction-animation-mapping.js";
import { readSafePluginManifest } from "./plugin-manifest-reader.js";
import { registerPluginAssetProtocol } from "./plugin-asset-protocol.js";
import { checkForGitHubReleaseUpdate, getUpdateStatus, openUpdateReleasePage } from "./update-checker.js";
import { getVoicePlatform } from "./voice-platform.js";
import { getVoiceSecretStatus, setVoiceSecret, type VoiceSecretProviderId } from "./voice-secrets.js";
import { getVoiceSettings, getVoiceSettingsSnapshot, updateVoiceSettings, voiceProviderIds, type VoiceProviderId } from "./voice-settings.js";

type InternalUiWindowKind = "control-center";
export type ControlCenterRoute = "dashboard" | "pets" | "settings" | "plugins" | "integrations";
export type ControlCenterSection = "companion";
export type ControlCenterRouteRequest = {
  readonly route: ControlCenterRoute;
  readonly petId?: string;
  readonly section?: ControlCenterSection;
  readonly notice?: "pet-unavailable";
};

const controlCenterRoutes = new Set<ControlCenterRoute>(["dashboard", "pets", "settings", "plugins", "integrations"]);
let controlCenterWindow: BrowserWindow | null = null;
let internalUiHandlersInstalled = false;
let pendingControlCenterRoute: ControlCenterRouteRequest | null = null;
let pendingDockTimer: NodeJS.Timeout | null = null;
let lastDockHideAt = 0;
const dockHideShowCooldownMs = 1100;

function validateVoiceProviderId(value: unknown): VoiceProviderId {
  if (!voiceProviderIds.includes(value as VoiceProviderId)) throw new Error("Invalid voice provider.");
  return value as VoiceProviderId;
}

function validateCompanionTargetId(value: unknown): CompanionTargetId {
  if (!companionTargetIds.includes(value as CompanionTargetId)) throw new Error("Invalid companion target.");
  return value as CompanionTargetId;
}

function requireVoicePlatform() {
  const platform = getVoicePlatform();
  if (!platform) throw new Error("Voice platform is still starting.");
  return platform;
}

function hasOpenInternalUiWindows(): boolean {
  if (controlCenterWindow && !controlCenterWindow.isDestroyed()) return true;
  return false;
}

function syncDockVisibilityForInternalUi(): void {
  if (process.platform !== "darwin") return;
  const dock = app.dock;
  if (!dock) return;

  if (pendingDockTimer) {
    clearTimeout(pendingDockTimer);
    pendingDockTimer = null;
  }

  if (hasOpenInternalUiWindows()) {
    const elapsedSinceHide = Date.now() - lastDockHideAt;
    const delayMs = elapsedSinceHide < dockHideShowCooldownMs ? dockHideShowCooldownMs - elapsedSinceHide : 0;
    pendingDockTimer = setTimeout(() => {
      pendingDockTimer = null;
      dock.setIcon(createAppIcon());
      dock.show();
    }, delayMs);
  } else {
    dock.hide();
    lastDockHideAt = Date.now();
  }
}

function getPetsStateSnapshot(): { preferences: { defaultPetId: string }; pets: ReturnType<typeof getAppStateSnapshot>["pets"] } {
  const state = getAppStateSnapshot();
  return { preferences: { defaultPetId: state.preferences.defaultPetId }, pets: state.pets };
}

function getSettingsStateSnapshot(): {
  preferences: Pick<ReturnType<typeof getAppStateSnapshot>["preferences"], "openDefaultPetOnLaunch" | "readSpeechBubblesAloud" | "petScale" | "reactionAnimationOverrides" | "petPoolOrder" | "petPoolEnabled" | "petConfinementEnabled" | "petCrossDisplayEnabled" | "petGravityEnabled">;
  petScaleOptions: typeof petScaleOptions;
  analytics: ReturnType<typeof getDesktopAnalyticsConsentState>;
  /** Non-broken, non-built-in installed pets available for pool selection. */
  petPoolCandidates: ReadonlyArray<{ readonly id: string; readonly displayName: string }>;
} {
  const state = getAppStateSnapshot();
  return {
    preferences: {
      openDefaultPetOnLaunch: state.preferences.openDefaultPetOnLaunch,
      readSpeechBubblesAloud: state.preferences.readSpeechBubblesAloud,
      petScale: state.preferences.petScale,
      reactionAnimationOverrides: state.preferences.reactionAnimationOverrides,
      petPoolOrder: state.preferences.petPoolOrder,
      petPoolEnabled: state.preferences.petPoolEnabled,
      petConfinementEnabled: state.preferences.petConfinementEnabled,
      petCrossDisplayEnabled: state.preferences.petCrossDisplayEnabled,
      petGravityEnabled: state.preferences.petGravityEnabled,
    },
    petScaleOptions,
    analytics: getDesktopAnalyticsConsentState(),
    petPoolCandidates: state.pets.installed
      .filter((p) => !p.builtIn && !p.broken && p.id !== state.preferences.defaultPetId)
      .map(({ id, displayName }) => ({ id, displayName })),
  };
}

function getI18nSnapshot(): {
  locale: Locale;
  localePreference: LocalePreference;
  availableLocales: { value: Locale; label: string }[];
  messages: ReturnType<typeof getActiveMessages>;
} {
  return {
    locale: getActiveLocale(),
    localePreference: getAppStateSnapshot().preferences.locale,
    availableLocales: SUPPORTED_LOCALES.map((value) => ({ value, label: LOCALE_LABELS[value] })),
    messages: getActiveMessages(),
  };
}

async function getDashboardSnapshot(): Promise<{
  readonly defaultPet: { readonly id: string; readonly displayName: string; readonly previewSpriteUrl: string };
  readonly installedPetCount: number;
  readonly catalog: { readonly source: string; readonly total?: number; readonly page?: number; readonly pageCount?: number; readonly error?: string };
  readonly plugins: { readonly installed: number; readonly enabled: number; readonly broken: number };
  readonly updateStatus: ReturnType<typeof getUpdateStatus>;
  readonly activity: Pick<ReturnType<typeof getAppStateSnapshot>["analytics"], "messagesSent" | "reactionsSent" | "reactionCounts" | "perPetActivityCounts" | "lastActivityAt">;
}> {
  const state = getAppStateSnapshot();
  const defaultPet = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId && !pet.broken) ?? state.pets.installed[0];
  const preview = await getDefaultPetPreviewSpriteInfo();
  const catalog = await getCatalogUiState().catch((error: unknown) => ({ source: "error" as const, pets: [], total: undefined, page: undefined, pageCount: undefined, error: error instanceof Error ? error.message : "Catalog unavailable." }));
  const pluginSnapshot = await getPluginService().getSnapshot().catch((error: unknown) => {
    warn("ui", "dashboard plugin snapshot unavailable", { error: error instanceof Error ? error.message : String(error) });
    return { plugins: [] } as const;
  });
  const installedPlugins = pluginSnapshot.plugins.length;
  const brokenPlugins = pluginSnapshot.plugins.filter((plugin) => Boolean(plugin.brokenReason)).length;
  const enabledPlugins = pluginSnapshot.plugins.filter((plugin) => plugin.enabled && !plugin.brokenReason).length;

  return {
    defaultPet: {
      id: defaultPet?.id ?? state.preferences.defaultPetId,
      displayName: defaultPet?.displayName ?? "OpenPets",
      previewSpriteUrl: `openpets-pet-preview://spritesheet/default?v=${encodeURIComponent(preview.version)}`,
    },
    installedPetCount: state.pets.installed.length,
    catalog: {
      source: catalog.source,
      total: catalog.total,
      page: catalog.page,
      pageCount: catalog.pageCount,
      error: catalog.error,
    },
    plugins: {
      installed: installedPlugins,
      enabled: enabledPlugins,
      broken: brokenPlugins,
    },
    updateStatus: getUpdateStatus(),
    activity: {
      messagesSent: state.analytics.messagesSent,
      reactionsSent: state.analytics.reactionsSent,
      reactionCounts: state.analytics.reactionCounts,
      perPetActivityCounts: state.analytics.perPetActivityCounts,
      lastActivityAt: state.analytics.lastActivityAt,
    },
  };
}

export function installInternalUiHandlers(): void {
  if (internalUiHandlersInstalled) {
    return;
  }

  internalUiHandlersInstalled = true;

  // Apply the persisted petConfinementEnabled preference as the initial value
  // for the confinement-manager flag. This runs once after app-state is loaded.
  setConfinementEnabled(getAppStateSnapshot().preferences.petConfinementEnabled);
  setCrossDisplayRoamingEnabled(getAppStateSnapshot().preferences.petCrossDisplayEnabled);
  // Apply the persisted petGravityEnabled preference on startup.
  applyRoamingToAllPets();

  ipcMain.handle("openpets:get-pets-state", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getPetsStateSnapshot();
  });

  ipcMain.handle("openpets:get-settings-state", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getSettingsStateSnapshot();
  });

  ipcMain.handle("openpets:companion-settings-get", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getCompanionSettings();
  });

  ipcMain.handle("openpets:companion-enable", (event) => {
    assertAllowedSender(event, ["control-center"]);
    const settings = enableCompanion();
    trackDesktopEvent("desktop_companion_enabled", { frequency: settings.proactivity.frequency, target: settings.target });
    return settings;
  });

  ipcMain.handle("openpets:companion-disable", (event) => {
    assertAllowedSender(event, ["control-center"]);
    const settings = disableCompanion();
    getVoicePlatform()?.companion.cancelAll();
    trackDesktopEvent("desktop_companion_disabled");
    return settings;
  });

  ipcMain.handle("openpets:companion-settings-update", (event, patch: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const previousTarget = getCompanionSettings().target;
    const settings = updateCompanionSettings(patch);
    if (settings.target !== previousTarget) getVoicePlatform()?.companion.cancelAll();
    debug("companion", "settings updated", { enabled: settings.enabled, target: settings.target, memoryEnabled: settings.memory.enabled, proactivityEnabled: settings.proactivity.enabled, frequency: settings.proactivity.frequency, pluginContext: settings.context.pluginEnabled, sensitivePluginContext: settings.context.sensitivePluginEnabled, screenContext: settings.context.screenEnabled });
    return settings;
  });

  ipcMain.handle("openpets:companion-pet-settings-update", (event, petId: unknown, patch: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof petId !== "string" || !getAppStateSnapshot().pets.installed.some((pet) => pet.id === petId && !pet.broken && !pet.brokenReason)) throw new Error("The selected pet is unavailable.");
    return updateCompanionPetSettings(petId, patch);
  });

  ipcMain.handle("openpets:companion-memory-clear", (event, petId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (petId !== undefined && typeof petId !== "string") throw new Error("Invalid pet id.");
    clearCompanionMemory(petId);
    debug("companion", "recent memory cleared", { petId: typeof petId === "string" ? petId : undefined });
    return { ok: true } as const;
  });

  ipcMain.handle("openpets:companion-target-health", async (event, targetId: unknown, force: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const selected = targetId === undefined ? getCompanionSettings().target : validateCompanionTargetId(targetId);
    return requireVoicePlatform().companion.health(selected, force === true);
  });

  ipcMain.handle("openpets:companion-send", async (event, request: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (!isPlainObject(request) || typeof request.petId !== "string" || typeof request.text !== "string") throw new Error("Invalid companion message.");
    return requireVoicePlatform().companion.sendUserTurn({ petId: request.petId, text: request.text, kind: "typed", speak: request.speak === true });
  });

  ipcMain.handle("openpets:companion-cancel", (event, petId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof petId !== "string") throw new Error("Invalid pet id.");
    requireVoicePlatform().companion.cancel(petId);
    return { ok: true } as const;
  });

  ipcMain.handle("openpets:companion-display-ack", (event, petId: unknown, token: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof petId !== "string" || typeof token !== "string" || token.length > 300) throw new Error("Invalid companion display acknowledgement.");
    return { ok: requireVoicePlatform().companion.acknowledgeDisplay(petId, token) };
  });

  ipcMain.handle("openpets:get-lan-status", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getLanStatusSnapshot();
  });

  ipcMain.handle("openpets:set-desktop-analytics-consent", (event, consent: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (consent !== "granted" && consent !== "denied" && consent !== "unset") throw new Error("Invalid analytics consent value.");
    setDesktopAnalyticsConsent(consent);
    trackDesktopAnalyticsConsentChanged(consent);
    return getSettingsStateSnapshot();
  });

  ipcMain.handle("openpets:get-i18n", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getI18nSnapshot();
  });

  ipcMain.handle("openpets:get-dashboard-snapshot", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getDashboardSnapshot();
  });

  ipcMain.handle("openpets:get-reaction-animation-settings", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getReactionAnimationSettingsSnapshot();
  });

  ipcMain.handle("openpets:plugins-snapshot", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getPluginService().getSnapshot();
  });

  ipcMain.handle("openpets:plugins-set-enabled", async (event, id: unknown, enabled: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id) || typeof enabled !== "boolean") return pluginUiError("Invalid plugin enable request.");
    const result = await getPluginService().setEnabled(id, enabled);
    if (result.ok) trackDesktopEvent(enabled ? "desktop_plugin_enabled" : "desktop_plugin_disabled", pluginTelemetryForSnapshot(result.snapshot, id));
    return result;
  });

  ipcMain.handle("openpets:plugins-save-config", async (event, id: unknown, config: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id) || !isPlainObject(config)) return pluginUiError("Invalid plugin config request.");
    return getPluginService().saveConfig(id, config);
  });

  ipcMain.handle("openpets:plugins-pick-config-sound", async (event, id: unknown): Promise<PluginConfigSoundPickResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id)) {
      warn("ui", "Plugin sound pick invalid request.", { ok: false, reason: "invalid-plugin-id" });
      return pluginUiSoundError("Invalid plugin sound request.");
    }
    debug("ui", "Plugin sound pick requested.", { pluginId: id });
    try {
      const result = await getPluginService().pickConfigSound(id);
      if (result.ok && "sound" in result && result.sound.id) debug("ui", "Plugin sound pick succeeded.", { pluginId: id, ok: true, soundId: result.sound.id });
      else if (result.ok) debug("ui", "Plugin sound pick canceled.", { pluginId: id, ok: true, canceled: true });
      else warn("ui", "Plugin sound pick failed.", { pluginId: id, ok: false, reason: result.error });
      return result;
    } catch (error) {
      logError("ui", "Plugin sound pick errored.", { pluginId: id, ok: false, reason: error instanceof Error ? error.message : "unknown" });
      throw error;
    }
  });

  ipcMain.handle("openpets:plugins-reload", async (event, id: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id)) return pluginUiError("Invalid plugin reload request.");
    return getPluginService().reload(id);
  });

  ipcMain.handle("openpets:plugins-refresh-local", async (event, id: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id)) return pluginUiError("Invalid plugin refresh request.");
    return getPluginService().refreshLocal(id);
  });

  ipcMain.handle("openpets:plugins-execute-command", async (event, id: unknown, commandId: unknown, args: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id) || typeof commandId !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(commandId) || (args !== undefined && !isPlainObject(args))) return pluginUiError("Invalid plugin command request.");
    const result = await getPluginService().executeCommand(id, commandId, isPlainObject(args) ? args as Record<string, unknown> : undefined);
    if (result.ok) trackDesktopEvent("desktop_plugin_command_run", { ...pluginTelemetryForSnapshot(result.snapshot, id), command_known: true });
    return result;
  });

  ipcMain.handle("openpets:plugins-load-local", async (event): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    return getPluginService().loadLocal();
  });

  ipcMain.handle("openpets:plugins-catalog-snapshot", async (event, refresh: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    trackDesktopEvent("desktop_plugin_catalog_opened", { refresh: refresh === true });
    const snapshot = await getPluginService().getCatalogSnapshot(refresh === true);
    if (snapshot.error) trackDesktopEvent("desktop_catalog_fetch_failed", { catalog_kind: "plugin", error_code: classifyAnalyticsError(snapshot.error, "plugin_catalog_fetch_failed") });
    return snapshot;
  });

  ipcMain.handle("openpets:plugins-install-catalog", async (event, id: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id)) return pluginUiError("Invalid plugin install request.");
    trackDesktopEvent("desktop_plugin_install_started", { plugin_source: "catalog" });
    try {
      const result = await getPluginService().installCatalog(id);
      if (result.ok && isCatalogPluginInstalled(result.snapshot, id)) trackDesktopEvent("desktop_plugin_installed", { ...pluginTelemetryForSnapshot(result.snapshot, id), plugin_source: "catalog" });
      else if (!result.ok) trackDesktopEvent("desktop_plugin_install_failed", { plugin_source: "catalog", error_code: classifyAnalyticsError(result.error, "plugin_install_failed") });
      return result;
    } catch (error) {
      trackDesktopEvent("desktop_plugin_install_failed", { plugin_source: "catalog", error_code: classifyAnalyticsError(error, "plugin_install_failed") });
      throw error;
    }
  });

  ipcMain.handle("openpets:plugins-update-catalog", async (event, id: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id)) return pluginUiError("Invalid plugin update request.");
    return getPluginService().updateCatalog(id);
  });

  ipcMain.handle("openpets:plugins-uninstall", async (event, id: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id)) return pluginUiError("Invalid plugin uninstall request.");
    return getPluginService().uninstall(id);
  });

  ipcMain.handle("openpets:plugins-inspector", async (event, id: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id)) throw new Error("Invalid plugin inspector request.");
    return getPluginService().runtime.getInspectorState(id);
  });

  ipcMain.handle("openpets:plugin-platform-settings-get", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const { getPluginPlatformSettings } = await import("./plugin-platform-settings.js");
    return getPluginPlatformSettings();
  });

  ipcMain.handle("openpets:plugin-platform-settings-update", async (event, patch: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (!isPlainObject(patch)) throw new Error("Invalid plugin platform settings patch.");
    const { updatePluginPlatformSettings } = await import("./plugin-platform-settings.js");
    return updatePluginPlatformSettings(patch as never);
  });

  ipcMain.handle("openpets:plugin-platform-ai-key-set", async (event, key: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const { getPluginHostCapabilitiesForUi } = await import("./plugin-host-capabilities.js");
    const { hostSecretsOwner, hostAiApiKeySecret } = await import("./plugin-ai-gateway.js");
    const capabilities = getPluginHostCapabilitiesForUi();
    if (!capabilities) throw new Error("Plugin host capabilities are unavailable.");
    if (key === null || key === "") { await capabilities.secretsStore.delete(hostSecretsOwner, hostAiApiKeySecret); return { ok: true, hasKey: false }; }
    if (typeof key !== "string" || key.length > 4096) throw new Error("Invalid AI API key.");
    await capabilities.secretsStore.set(hostSecretsOwner, hostAiApiKeySecret, key);
    return { ok: true, hasKey: true };
  });

  ipcMain.handle("openpets:plugin-platform-ai-key-status", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const { getPluginHostCapabilitiesForUi } = await import("./plugin-host-capabilities.js");
    const { hostSecretsOwner, hostAiApiKeySecret } = await import("./plugin-ai-gateway.js");
    const capabilities = getPluginHostCapabilitiesForUi();
    if (!capabilities) return { hasKey: false };
    return { hasKey: await capabilities.secretsStore.has(hostSecretsOwner, hostAiApiKeySecret) };
  });

  ipcMain.handle("openpets:voice-settings-get", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getVoiceSettingsSnapshot(getAppStateSnapshot().pets.installed);
  });

  ipcMain.handle("openpets:voice-settings-update", async (event, patch: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (!isPlainObject(patch)) throw new Error("Invalid voice settings patch.");
    if (isPlainObject(patch.wake) && patch.wake.enabled === true && !requireVoicePlatform().wake.health().ready) {
      throw new Error(requireVoicePlatform().wake.health().reason);
    }
    if (isPlainObject(patch.conversation) && patch.conversation.target === "codex") {
      const health = await requireVoicePlatform().companion.health("codex");
      if (!health.ready) throw new Error(health.reason ?? "Codex CLI conversation is unavailable.");
    }
    const settings = updateVoiceSettings(patch);
    debug("ui", "voice settings updated", { providerId: settings.output.providerId, petOverrides: Object.keys(settings.petOverrides).length });
    return getVoiceSettingsSnapshot(getAppStateSnapshot().pets.installed);
  });

  ipcMain.handle("openpets:voice-secret-status", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const { getPluginHostCapabilitiesForUi } = await import("./plugin-host-capabilities.js");
    const capabilities = getPluginHostCapabilitiesForUi();
    return capabilities ? getVoiceSecretStatus(capabilities.secretsStore) : { "openai-compatible": { hasKey: false }, elevenlabs: { hasKey: false } };
  });

  ipcMain.handle("openpets:voice-secret-set", async (event, providerId: unknown, key: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (providerId !== "openai-compatible" && providerId !== "elevenlabs") throw new Error("Invalid voice secret provider.");
    if (key !== null && typeof key !== "string") throw new Error("Invalid voice API key.");
    const { getPluginHostCapabilitiesForUi } = await import("./plugin-host-capabilities.js");
    const capabilities = getPluginHostCapabilitiesForUi();
    if (!capabilities) throw new Error("Voice secret storage is unavailable.");
    await setVoiceSecret(capabilities.secretsStore, providerId as VoiceSecretProviderId, key as string | null);
    getVoicePlatform()?.providers.invalidate(providerId as VoiceProviderId);
    return getVoiceSecretStatus(capabilities.secretsStore);
  });

  ipcMain.handle("openpets:voice-provider-health", async (event, providerId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const provider = validateVoiceProviderId(providerId);
    const platform = requireVoicePlatform();
    return platform.providers.health(provider);
  });

  ipcMain.handle("openpets:voice-provider-voices", async (event, providerId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const provider = validateVoiceProviderId(providerId);
    return requireVoicePlatform().providers.listVoices(provider);
  });

  ipcMain.handle("openpets:voice-test-speech", async (event, request: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (!isPlainObject(request)) throw new Error("Invalid voice test request.");
    const text = typeof request.text === "string" ? request.text.trim() : "";
    if (!text || text.length > 300 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new Error("Voice test text must contain 1–300 printable characters.");
    const providerId = request.providerId === undefined ? undefined : validateVoiceProviderId(request.providerId);
    const petId = typeof request.petId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(request.petId) ? request.petId : getAppStateSnapshot().preferences.defaultPetId;
    const voiceId = typeof request.voiceId === "string" ? request.voiceId.trim().slice(0, 200) || undefined : undefined;
    const model = typeof request.model === "string" ? request.model.trim().slice(0, 200) || undefined : undefined;
    const result = await requireVoicePlatform().output.speak({ text, reason: "settings-test", target: { kind: "installed-pet", petId }, requestedProviderId: providerId, requestedVoiceId: voiceId, requestedModel: model, overlapPolicy: "interrupt" });
    debug("ui", "voice speech test finished", { ok: result.ok, providerId: providerId ?? "configured", petId, attempts: result.attempts.length });
    return result;
  });

  ipcMain.handle("openpets:voice-stop-speech", (event, petId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const id = typeof petId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(petId) ? petId : getAppStateSnapshot().preferences.defaultPetId;
    requireVoicePlatform().output.cancel({ kind: "installed-pet", petId: id });
    return { ok: true };
  });

  ipcMain.handle("openpets:voice-listening-state-get", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return requireVoicePlatform().listening.getSnapshot();
  });

  ipcMain.handle("openpets:voice-conversation-health", async (event, force: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    return requireVoicePlatform().companion.health("codex", force === true);
  });

  ipcMain.handle("openpets:voice-wake-health", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return requireVoicePlatform().wake.health();
  });

  ipcMain.handle("openpets:voice-ptt-start", async (event, petId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof petId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(petId)) throw new Error("Invalid push-to-talk pet.");
    if (!getVoiceSettings().listening.pushToTalkEnabled) throw new Error("Enable push-to-talk in Voice Settings first.");
    return requireVoicePlatform().listening.startPushToTalk(petId);
  });

  ipcMain.handle("openpets:voice-ptt-stop", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return requireVoicePlatform().listening.stopPushToTalk();
  });

  ipcMain.handle("openpets:voice-activity-cancel", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return requireVoicePlatform().listening.cancel("control-center");
  });

  ipcMain.handle("openpets:get-catalog", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    trackDesktopEvent("desktop_pet_catalog_opened", { source: "catalog" });
    try {
      const state = await getCatalogUiState();
      if (state.source !== "remote" || state.fallbackReason) trackDesktopEvent("desktop_catalog_fetch_failed", { catalog_kind: "pet", source: state.source, fallback_reason: state.fallbackReason, error_code: classifyAnalyticsError(state.error, "catalog_fetch_failed") });
      return state;
    } catch (error) {
      trackDesktopEvent("desktop_catalog_fetch_failed", { catalog_kind: "pet", source: "catalog", error_code: classifyAnalyticsError(error, "catalog_fetch_failed") });
      throw error;
    }
  });

  ipcMain.handle("openpets:get-catalog-page", async (event, page: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof page !== "number" || !Number.isInteger(page) || page < 0) throw new Error("Invalid catalog page.");
    trackDesktopEvent("desktop_pet_catalog_opened", { source: "catalog_page", page });
    try {
      const state = await getCatalogPageUiState(page);
      if (state.source !== "remote" || state.fallbackReason) trackDesktopEvent("desktop_catalog_fetch_failed", { catalog_kind: "pet", source: state.source, fallback_reason: state.fallbackReason, page, error_code: classifyAnalyticsError(state.error, "catalog_page_fetch_failed") });
      return state;
    } catch (error) {
      trackDesktopEvent("desktop_catalog_fetch_failed", { catalog_kind: "pet", source: "catalog_page", page, error_code: classifyAnalyticsError(error, "catalog_page_fetch_failed") });
      throw error;
    }
  });

  ipcMain.handle("openpets:get-catalog-search", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const state = await getCatalogSearchUiState();
    if (state.source === "error") trackDesktopEvent("desktop_catalog_fetch_failed", { catalog_kind: "pet", source: "search", error_code: classifyAnalyticsError(state.error, "catalog_search_fetch_failed") });
    return state;
  });

  ipcMain.handle("openpets:get-codex-pets", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getCodexPetsUiState();
  });

  ipcMain.handle("openpets:update-preferences", (event, patch: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const previousScale = getAppStateSnapshot().preferences.petScale;
    const previousOverrides = JSON.stringify(getAppStateSnapshot().preferences.reactionAnimationOverrides ?? {});
    const previousLocale = getActiveLocale();
    const previousPoolEnabled = getAppStateSnapshot().preferences.petPoolEnabled;
    const state = updatePreferences(validatePreferencePatch(patch));
    const nextOverrides = JSON.stringify(state.preferences.reactionAnimationOverrides ?? {});
    if (state.preferences.petScale !== previousScale || nextOverrides !== previousOverrides) {
      refreshDefaultPetContent();
      refreshAgentPetContent();
    }
    if (setLocaleFromPreference(state.preferences.locale) !== previousLocale) {
      // Tray labels are rendered eagerly, so rebuild the menu in the new language.
      void import("./tray.js").then(({ refreshTrayMenu }) => refreshTrayMenu());
      // Control Center plugin labels are resolved at display time; nudge it to re-fetch the
      // SafePluginRecords so manifest/config labels re-render in the new language.
      broadcastPluginRecordsRefresh();
    }
    // Propagate petConfinementEnabled into the confinement-manager flag on every pref update.
    setConfinementEnabled(state.preferences.petConfinementEnabled);
    // Propagate petCrossDisplayEnabled into the display-module flag on every pref update.
    setCrossDisplayRoamingEnabled(state.preferences.petCrossDisplayEnabled);
    // Propagate petGravityEnabled to all live pets on every pref update.
    applyRoamingToAllPets();
    // Propagate petPoolEnabled — despawn on disable, respawn on enable.
    if (state.preferences.petPoolEnabled !== previousPoolEnabled) {
      void import("./local-ipc.js").then(({ dispatchPoolToggle }) => dispatchPoolToggle(state.preferences.petPoolEnabled));
    }
    return getInternalUiWindowKindForWebContents(event.sender.id) === "control-center" ? getSettingsStateSnapshot() : state;
  });

  ipcMain.handle("openpets:get-launch-at-login", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getLaunchAtLoginState();
  });

  ipcMain.handle("openpets:set-launch-at-login", (event, enabled: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof enabled !== "boolean") throw new Error("Invalid launch-at-login value.");
    if (!isLaunchAtLoginSupported()) return getLaunchAtLoginState();
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    return getLaunchAtLoginState();
  });

  ipcMain.handle("openpets:get-update-status", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getUpdateStatus();
  });

  ipcMain.handle("openpets:check-for-updates", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const status = await checkForGitHubReleaseUpdate();
    const { refreshTrayMenu } = await import("./tray.js");
    refreshTrayMenu();
    return status;
  });

  ipcMain.handle("openpets:open-update-release-page", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    await openUpdateReleasePage();
  });

  ipcMain.handle("openpets:set-default-pet", async (event, petId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof petId !== "string") {
      throw new Error("Invalid pet id.");
    }

    const state = await setDefaultInstalledPet(petId);
    trackDesktopEvent("desktop_default_pet_changed", petTelemetryForId(petId));
    refreshDefaultPetContent();
    recoverDefaultPetMouseInterop("default-pet-changed");
    setTimeout(() => recoverDefaultPetMouseInterop("default-pet-changed+500ms"), 500).unref?.();
    return getInternalUiWindowKindForWebContents(event.sender.id) === "control-center" ? getPetsStateSnapshot() : state;
  });

  ipcMain.handle("openpets:set-pet-pool-order", (event, ids: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (!Array.isArray(ids)) throw new Error("Invalid pet pool order: expected an array.");
    const normalized = normalizePetPoolOrder(ids);
    setPetPoolOrder(normalized ?? []);
    return getSettingsStateSnapshot();
  });

  ipcMain.handle("openpets:install-pet", async (event, petId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof petId !== "string") {
      throw new Error("Invalid pet id.");
    }

    trackDesktopEvent("desktop_pet_install_started", { source: "catalog" });
    let state;
    try {
      state = await installPet(petId);
      trackDesktopEvent("desktop_pet_install_completed", { source: "catalog" });
    } catch (error) {
      trackDesktopEvent("desktop_pet_install_failed", { source: "catalog", error_code: classifyAnalyticsError(error, "pet_install_failed") });
      throw error;
    }
    return getInternalUiWindowKindForWebContents(event.sender.id) === "control-center" ? getPetsStateSnapshot() : state;
  });

  ipcMain.handle("openpets:install-local-pet", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const importKind = await chooseLocalPetImportKind(owner);
    if (!importKind) return getPetsStateSnapshot();
    const options: OpenDialogOptions = importKind === "zip" ? {
      title: "Install pet from ZIP",
      buttonLabel: "Install Pet",
      properties: ["openFile"],
      filters: [{ name: "OpenPets ZIP", extensions: ["zip"] }],
    } : {
      title: "Install pet from folder",
      buttonLabel: "Install Pet",
      properties: ["openDirectory"],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return getPetsStateSnapshot();
    const selectedPath = result.filePaths[0];
    let source: "local_folder" | "local_zip" = "local_zip";
    try {
      const selectedStats = await stat(selectedPath);
      source = selectedStats.isDirectory() ? "local_folder" : "local_zip";
      trackDesktopEvent("desktop_pet_local_import_started", { source });
      const state = selectedStats.isDirectory() ? await installPetFromFolder(selectedPath) : await installPetFromZipFile(selectedPath);
      trackDesktopEvent("desktop_pet_local_import_completed", { source });
      debug("ui", "local pet import succeeded", { kind: selectedStats.isDirectory() ? "folder" : "zip" });
      refreshDefaultPetContent();
      return getInternalUiWindowKindForWebContents(event.sender.id) === "control-center" ? getPetsStateSnapshot() : state;
    } catch (error) {
      trackDesktopEvent("desktop_pet_local_import_failed", { source, error_code: classifyAnalyticsError(error, "local_pet_import_failed") });
      logError("ui", "local pet import failed", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  ipcMain.handle("openpets:open-gallery", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    await shell.openExternal("https://openpets.dev/gallery");
  });

  ipcMain.handle("openpets:import-codex-pet", async (event, petId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof petId !== "string") {
      throw new Error("Invalid pet id.");
    }

    trackDesktopEvent("desktop_pet_local_import_started", { source: "codex" });
    let state;
    try {
      state = await importCodexPet(petId);
      trackDesktopEvent("desktop_pet_local_import_completed", { source: "codex" });
    } catch (error) {
      trackDesktopEvent("desktop_pet_local_import_failed", { source: "codex", error_code: classifyAnalyticsError(error, "codex_pet_import_failed") });
      throw error;
    }
    return getInternalUiWindowKindForWebContents(event.sender.id) === "control-center" ? getPetsStateSnapshot() : state;
  });

  ipcMain.handle("openpets:remove-pet", async (event, petId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof petId !== "string") {
      throw new Error("Invalid pet id.");
    }

    const state = await removePet(petId);
    removeCompanionPetSettings(petId);
    removeCompanionMemoryForPet(petId);
    getVoicePlatform()?.companion.cancel(petId);
    refreshDefaultPetContent();
    return getInternalUiWindowKindForWebContents(event.sender.id) === "control-center" ? getPetsStateSnapshot() : state;
  });

  ipcMain.handle("openpets:reset-default-pet-position", (event) => {
    assertAllowedSender(event, ["control-center"]);
    resetDefaultPetToInitialPosition();
    return getInternalUiWindowKindForWebContents(event.sender.id) === "control-center" ? getSettingsStateSnapshot() : getAppStateSnapshot();
  });

  ipcMain.handle("openpets:agent-setup-snapshot", async (event, selectedPetId: unknown, commandMode: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    return getAgentSetupSnapshot(selectedPetId, commandMode);
  });

  ipcMain.handle("openpets:agent-setup-action", async (event, action: unknown, selectedPetId: unknown, commandMode: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (action !== "configure" && action !== "replace" && action !== "remove" && action !== "install-memory" && action !== "doctor-hooks" && action !== "install-hooks" && action !== "uninstall-hooks" && action !== "opencode-install" && action !== "opencode-remove" && action !== "cursor-install" && action !== "cursor-replace" && action !== "cursor-remove") {
      throw new Error("Invalid agent setup action.");
    }

    trackDesktopEvent("desktop_agent_setup_started", { action, integration_type: integrationTypeForSetupAction(action), command_mode: typeof commandMode === "string" ? commandMode : undefined });
    const snapshot = await runAgentSetupAction(action, selectedPetId, commandMode);
    const eventName = snapshot.lastAction?.ok ? "desktop_agent_setup_completed" : "desktop_agent_setup_failed";
    trackDesktopEvent(eventName, { action, integration_type: integrationTypeForSetupAction(action), changed: snapshot.lastAction?.changed ?? false, command_mode: snapshot.commandMode });
    return snapshot;
  });

  ipcMain.handle("openpets:agent-setup-command-paths", (event, patch: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    return updateAgentSetupCommandPaths(patch);
  });
}

async function chooseLocalPetImportKind(owner: BrowserWindow | undefined): Promise<"zip" | "folder" | null> {
  const options = {
    type: "question" as const,
    title: "Install pet",
    message: "Install pet from ZIP or folder?",
    detail: "Choose the source type before selecting the pet package.",
    buttons: ["ZIP", "Folder", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  if (result.response === 0) return "zip";
  if (result.response === 1) return "folder";
  return null;
}

function integrationTypeForSetupAction(action: string): string {
  if (action.startsWith("opencode-")) return "opencode";
  if (action.startsWith("cursor-")) return "cursor";
  if (action.includes("hook") || action === "install-memory") return "claude";
  return "claude";
}

function pluginTelemetryForSnapshot(snapshot: PluginServiceResult["snapshot"], pluginId: string): Record<string, string | number | boolean | undefined> {
  const plugin = snapshot.plugins.find((candidate) => candidate.id === pluginId);
  return {
    plugin_source: plugin?.bundled ? "bundled" : plugin?.source,
    plugin_bundled: plugin?.bundled === true,
    plugin_runtime: plugin?.runtime,
    permission_count: plugin?.approvedPermissions.length,
  };
}

function isCatalogPluginInstalled(snapshot: PluginServiceResult["snapshot"], pluginId: string): boolean {
  const plugin = snapshot.plugins.find((candidate) => candidate.id === pluginId);
  return plugin?.source === "catalog" || plugin?.bundled === true;
}

function petTelemetryForId(petId: string): Record<string, string | boolean | undefined> {
  const pet = getAppStateSnapshot().pets.installed.find((candidate) => candidate.id === petId);
  return {
    pet_source: pet?.builtIn ? "built_in" : pet?.source?.kind === "catalog" ? "catalog" : pet?.source?.kind === "codex" ? "codex" : "local",
    pet_built_in: pet?.builtIn === true,
    pet_public_catalog: pet?.source?.kind === "catalog",
  };
}

export function installInternalUiProtocol(): void {
  registerPluginAssetProtocol(protocol, getPluginService);
  protocol.handle("openpets-codex", async (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const url = new URL(request.url);
      if (url.hostname !== "spritesheet" || url.search || url.hash) return new Response(null, { status: 404 });
      const petId = decodeURIComponent(url.pathname.replace(/^\//, ""));
      const spritesheet = await readCodexPetSpritesheet(petId);
      return new Response(spritesheet, {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "private, max-age=60",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  protocol.handle("openpets-installed", async (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const url = new URL(request.url);
      if (url.hostname !== "spritesheet" || url.search || url.hash) return new Response(null, { status: 404 });
      const petId = decodeURIComponent(url.pathname.replace(/^\//, ""));
      assertSafePetId(petId);
      const pet = getAppStateSnapshot().pets.installed.find((candidate) => candidate.id === petId && !candidate.broken);
      if (!pet) return new Response(null, { status: 404 });
      const spritesheetPath = join(getInstalledPetDir(petId), "spritesheet.webp");
      const spritesheet = await stat(spritesheetPath);
      if (!spritesheet.isFile() || spritesheet.size <= 0 || spritesheet.size > 100 * 1024 * 1024) return new Response(null, { status: 404 });
      return new Response(await readFile(spritesheetPath), {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "private, max-age=60",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  protocol.handle("openpets-pet-preview", async (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const url = new URL(request.url);
      if (url.hostname !== "spritesheet" || url.pathname !== "/default" || url.hash) return new Response(null, { status: 404 });
      const version = url.searchParams.get("v");
      if ([...url.searchParams.keys()].some((key) => key !== "v") || (version !== null && !/^[a-z0-9_-]+-\d+-\d+$/.test(version))) return new Response(null, { status: 404 });
      const { path } = await getDefaultPetPreviewSpriteInfo();
      const spritesheet = await stat(path);
      if (!spritesheet.isFile() || spritesheet.size <= 0 || spritesheet.size > 100 * 1024 * 1024) return new Response(null, { status: 404 });
      return new Response(await readFile(path), {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

export function openControlCenterWindow(route: ControlCenterRoute | ControlCenterRouteRequest = "dashboard"): void {
  const safeRoute = normalizeControlCenterRoute(route);
  if (controlCenterWindow && !controlCenterWindow.isDestroyed()) {
    trackDesktopEvent("desktop_control_center_opened", { route: safeRoute.route, section: safeRoute.section, entrypoint: "focus_existing" });
    syncDockVisibilityForInternalUi();
    if (controlCenterWindow.isMinimized()) controlCenterWindow.restore();
    controlCenterWindow.show();
    controlCenterWindow.focus();
    routeControlCenterWindow(controlCenterWindow, safeRoute);
    return;
  }

  trackDesktopEvent("desktop_control_center_opened", { route: safeRoute.route, section: safeRoute.section, entrypoint: "create_window" });

  const window = new BrowserWindow({
    title: "OpenPets — Control Center",
    width: 1180,
    height: 820,
    minWidth: 820,
    minHeight: 620,
    show: false,
    icon: createAppIcon(),
    backgroundColor: "#f8fbff",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: getControlCenterPreloadPath(),
    },
  });

  controlCenterWindow = window;
  syncDockVisibilityForInternalUi();
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    trackDesktopEvent("desktop_renderer_error", { surface_kind: "control_center", error_code: classifyRendererLoadError(errorCode) });
    console.error("Failed to load Control Center renderer.", { errorCode, errorDescription });
    logError("ui", "control center load failed", { errorCode, errorDescription });
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const fields = { level, line, sourceId, message };
    if (level >= 3) logError("ui", "control center console", fields);
    else if (level === 2) warn("ui", "control center console", fields);
    else debug("ui", "control center console", fields);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    trackDesktopEvent("desktop_renderer_error", { surface_kind: "control_center", error_code: classifyRendererGoneReason(details.reason) });
    console.error("Control Center renderer process gone.", details);
    logError("ui", "control center renderer gone", details);
  });
  window.on("closed", () => { controlCenterWindow = null; syncDockVisibilityForInternalUi(); });
  window.once("ready-to-show", () => { window.show(); window.focus(); });
  pendingControlCenterRoute = safeRoute;
  window.webContents.on("did-finish-load", () => flushPendingControlCenterRoute(window));

  const devUrl = getSafeControlCenterDevUrl();
  const load = devUrl ? window.loadURL(withControlCenterRoute(devUrl, safeRoute)) : window.loadFile(join(app.getAppPath(), "dist", "renderer", "index.html"), { query: controlCenterRouteQuery(safeRoute) });
  load.catch((error: unknown) => {
    trackDesktopEvent("desktop_renderer_error", { surface_kind: "control_center", error_code: classifyAnalyticsError(error, "renderer_load_failed") });
    console.error("Failed to load Control Center.", error);
  });
}

function classifyRendererLoadError(errorCode: number): string {
  if (errorCode === -3) return "load_aborted";
  if (errorCode === -6 || errorCode === -105 || errorCode === -106) return "network_error";
  if (errorCode === -102 || errorCode === -109) return "connection_error";
  if (errorCode === -300 || errorCode === -301 || errorCode === -302) return "file_load_error";
  return "renderer_load_failed";
}

function classifyRendererGoneReason(reason: string): string {
  if (reason === "crashed" || reason === "oom" || reason === "killed" || reason === "integrity-failure") return `renderer_${reason.replace(/-/g, "_")}`;
  return "renderer_gone";
}

export function focusOpenTaskWindows(): void {
  syncDockVisibilityForInternalUi();
  if (controlCenterWindow && !controlCenterWindow.isDestroyed()) {
    if (controlCenterWindow.isMinimized()) controlCenterWindow.restore();
    controlCenterWindow.show();
    controlCenterWindow.focus();
  }
}

export function normalizeControlCenterRoute(route: unknown): ControlCenterRouteRequest {
  const requested = typeof route === "string" ? { route } : isPlainObject(route) ? route : {};
  const safeRoute = typeof requested.route === "string" && controlCenterRoutes.has(requested.route as ControlCenterRoute)
    ? requested.route as ControlCenterRoute
    : "dashboard";
  if (safeRoute !== "pets") return { route: safeRoute };

  const wantsCompanion = requested.section === "companion";
  const hasRequestedPet = typeof requested.petId === "string";
  const petId = hasRequestedPet && /^[A-Za-z0-9._:-]{1,200}$/.test(requested.petId as string) ? requested.petId as string : undefined;
  if (hasRequestedPet && !petId) return { route: "pets", ...(wantsCompanion ? { section: "companion" as const } : {}), notice: "pet-unavailable" };
  if (!petId) return { route: "pets", ...(wantsCompanion ? { section: "companion" as const } : {}) };
  const available = getAppStateSnapshot().pets.installed.some((pet) => pet.id === petId && !pet.broken && !pet.brokenReason);
  if (!available) return { route: "pets", ...(wantsCompanion ? { section: "companion" as const } : {}), notice: "pet-unavailable" };
  return { route: "pets", petId, ...(wantsCompanion ? { section: "companion" as const } : {}) };
}

function sendControlCenterRoute(window: BrowserWindow, route: ControlCenterRouteRequest): void {
  if (window.isDestroyed()) return;
  window.webContents.send("openpets:control-center-route", route);
}

/** Tell the open Control Center to re-fetch the plugin snapshot (e.g. after a locale change). */
function broadcastPluginRecordsRefresh(): void {
  if (controlCenterWindow && !controlCenterWindow.isDestroyed()) {
    controlCenterWindow.webContents.send("openpets:plugins-refresh");
  }
}

function routeControlCenterWindow(window: BrowserWindow, route: ControlCenterRouteRequest): void {
  pendingControlCenterRoute = route;
  if (window.webContents.isLoading()) return;
  flushPendingControlCenterRoute(window);
}

function flushPendingControlCenterRoute(window: BrowserWindow): void {
  if (window.isDestroyed() || !pendingControlCenterRoute) return;
  const route = pendingControlCenterRoute;
  pendingControlCenterRoute = null;
  sendControlCenterRoute(window, route);
}

function withControlCenterRoute(rawUrl: string, route: ControlCenterRouteRequest): string {
  const url = new URL(rawUrl);
  for (const [key, value] of Object.entries(controlCenterRouteQuery(route))) url.searchParams.set(key, value);
  return url.toString();
}

function controlCenterRouteQuery(route: ControlCenterRouteRequest): Record<string, string> {
  return {
    route: route.route,
    ...(route.petId ? { petId: route.petId } : {}),
    ...(route.section ? { section: route.section } : {}),
    ...(route.notice ? { notice: route.notice } : {}),
  };
}

function pluginUiError(error: string): PluginServiceResult {
  return { ok: false, error, snapshot: { plugins: [] } };
}

function pluginUiSoundError(error: string): PluginConfigSoundPickResult {
  return { ok: false, error, snapshot: { plugins: [] } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function getControlCenterPreloadPath(): string {
  return join(app.getAppPath(), "control-center-preload.cjs");
}

function getSafeControlCenterDevUrl(): string | null {
  if (app.isPackaged) return null;
  const raw = process.env.OPENPETS_RENDERER_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol === "http:" || url.protocol === "https:") && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function assertAllowedSender(event: IpcMainInvokeEvent, allowedKinds: readonly InternalUiWindowKind[]): void {
  const actualKind = getInternalUiWindowKindForWebContents(event.sender.id);

  if (!actualKind || !allowedKinds.includes(actualKind)) {
    throw new Error("OpenPets internal UI request came from an unexpected window.");
  }
}

function getInternalUiWindowKindForWebContents(webContentsId: number): InternalUiWindowKind | null {
  if (controlCenterWindow && !controlCenterWindow.isDestroyed() && controlCenterWindow.webContents.id === webContentsId) {
    return "control-center";
  }
  return null;
}

async function getReactionAnimationSettingsSnapshot(): Promise<unknown> {
  const state = getAppStateSnapshot();
  const preview = await getDefaultPetPreviewSpriteInfo();
  return {
    reactions: reactionAnimationMetadata.map((reaction) => ({
      ...reaction,
      label: t(`settings.reaction.${reaction.id}.label`),
      description: t(`settings.reaction.${reaction.id}.description`),
    })),
    animations: selectableAnimationMetadata.map((animation) => ({
      ...animation,
      label: t(`settings.animation.${animation.id}.label`),
      description: t(`settings.animation.${animation.id}.description`),
    })),
    sprite: defaultPetSprite,
    overrides: state.preferences.reactionAnimationOverrides ?? {},
    previewSpriteUrl: `openpets-pet-preview://spritesheet/default?v=${encodeURIComponent(preview.version)}`,
  };
}

async function getDefaultPetPreviewSpriteInfo(): Promise<{ readonly path: string; readonly version: string }> {
  const state = getAppStateSnapshot();
  const selected = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId);
  const builtInPath = join(app.getAppPath(), "assets", defaultPetSprite.fileName);
  const candidatePath = selected && !selected.broken && !selected.builtIn
    ? join(getInstalledPetDir(selected.id), "spritesheet.webp")
    : builtInPath;
  try {
    const spritesheet = await stat(candidatePath);
    if (spritesheet.isFile() && spritesheet.size > 0 && spritesheet.size <= 100 * 1024 * 1024) {
      return { path: candidatePath, version: `${selected?.id ?? "builtin"}-${Math.round(spritesheet.mtimeMs)}-${spritesheet.size}` };
    }
  } catch {
    // Fall back to the bundled pet if an installed default disappears while Settings is open.
  }
  const fallback = await stat(builtInPath);
  return { path: builtInPath, version: `builtin-${Math.round(fallback.mtimeMs)}-${fallback.size}` };
}

function getLaunchAtLoginState(): { supported: boolean; enabled: boolean } {
  if (!isLaunchAtLoginSupported()) return { supported: false, enabled: false };
  return { supported: true, enabled: app.getLoginItemSettings().openAtLogin };
}

function isLaunchAtLoginSupported(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}
