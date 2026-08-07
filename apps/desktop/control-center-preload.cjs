const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getPetsState: () => ipcRenderer.invoke("openpets:get-pets-state"),
  getDashboardSnapshot: () => ipcRenderer.invoke("openpets:get-dashboard-snapshot"),
  getSettingsState: () => ipcRenderer.invoke("openpets:get-settings-state"),
  getLanStatus: () => ipcRenderer.invoke("openpets:get-lan-status"),
  getI18n: () => ipcRenderer.invoke("openpets:get-i18n"),
  updatePreferences: (patch) => ipcRenderer.invoke("openpets:update-preferences", patch),
  getReactionAnimationSettings: () => ipcRenderer.invoke("openpets:get-reaction-animation-settings"),
  getLaunchAtLogin: () => ipcRenderer.invoke("openpets:get-launch-at-login"),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("openpets:set-launch-at-login", enabled),
  getUpdateStatus: () => ipcRenderer.invoke("openpets:get-update-status"),
  checkForUpdates: () => ipcRenderer.invoke("openpets:check-for-updates"),
  openUpdateReleasePage: () => ipcRenderer.invoke("openpets:open-update-release-page"),
  resetDefaultPetPosition: () => ipcRenderer.invoke("openpets:reset-default-pet-position"),
  getPluginsSnapshot: () => ipcRenderer.invoke("openpets:plugins-snapshot"),
  getPluginCatalogSnapshot: (refresh) => ipcRenderer.invoke("openpets:plugins-catalog-snapshot", refresh),
  setPluginEnabled: (id, enabled) => ipcRenderer.invoke("openpets:plugins-set-enabled", id, enabled),
  savePluginConfig: (id, config) => ipcRenderer.invoke("openpets:plugins-save-config", id, config),
  pickPluginConfigSound: (id) => ipcRenderer.invoke("openpets:plugins-pick-config-sound", id),
  reloadPlugin: (id) => ipcRenderer.invoke("openpets:plugins-reload", id),
  refreshLocalPlugin: (id) => ipcRenderer.invoke("openpets:plugins-refresh-local", id),
  executePluginCommand: (id, commandId, args) => ipcRenderer.invoke("openpets:plugins-execute-command", id, commandId, args),
  loadLocalPlugin: () => ipcRenderer.invoke("openpets:plugins-load-local"),
  installCatalogPlugin: (id) => ipcRenderer.invoke("openpets:plugins-install-catalog", id),
  updateCatalogPlugin: (id) => ipcRenderer.invoke("openpets:plugins-update-catalog", id),
  uninstallPlugin: (id) => ipcRenderer.invoke("openpets:plugins-uninstall", id),
  getPluginInspector: (id) => ipcRenderer.invoke("openpets:plugins-inspector", id),
  getPluginPlatformSettings: () => ipcRenderer.invoke("openpets:plugin-platform-settings-get"),
  updatePluginPlatformSettings: (patch) => ipcRenderer.invoke("openpets:plugin-platform-settings-update", patch),
  setPluginAiApiKey: (key) => ipcRenderer.invoke("openpets:plugin-platform-ai-key-set", key),
  getPluginAiApiKeyStatus: () => ipcRenderer.invoke("openpets:plugin-platform-ai-key-status"),
  getCatalog: () => ipcRenderer.invoke("openpets:get-catalog"),
  getCatalogPage: (page) => ipcRenderer.invoke("openpets:get-catalog-page", page),
  getCatalogSearch: () => ipcRenderer.invoke("openpets:get-catalog-search"),
  getCodexPets: () => ipcRenderer.invoke("openpets:get-codex-pets"),
  setDefaultPet: (petId) => ipcRenderer.invoke("openpets:set-default-pet", petId),
  setPetPoolOrder: (ids) => ipcRenderer.invoke("openpets:set-pet-pool-order", ids),
  installPet: (petId) => ipcRenderer.invoke("openpets:install-pet", petId),
  installLocalPet: () => ipcRenderer.invoke("openpets:install-local-pet"),
  importCodexPet: (petId) => ipcRenderer.invoke("openpets:import-codex-pet", petId),
  openGallery: () => ipcRenderer.invoke("openpets:open-gallery"),
  removePet: (petId) => ipcRenderer.invoke("openpets:remove-pet", petId),
  onRouteChange: (callback) => {
    const listener = (_event, route) => callback(route);
    ipcRenderer.on("openpets:control-center-route", listener);
    return () => ipcRenderer.removeListener("openpets:control-center-route", listener);
  },
  onPluginsRefresh: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("openpets:plugins-refresh", listener);
    return () => ipcRenderer.removeListener("openpets:plugins-refresh", listener);
  },
  getIntegrationsState: (selectedPetId, commandMode) => ipcRenderer.invoke("openpets:agent-setup-snapshot", selectedPetId, commandMode),
  runIntegrationAction: (action, selectedPetId, commandMode) => ipcRenderer.invoke("openpets:agent-setup-action", action, selectedPetId, commandMode),
  updateIntegrationCommandPaths: (patch) => ipcRenderer.invoke("openpets:agent-setup-command-paths", patch),
  getRemoteSnapshot: () => ipcRenderer.invoke("openpets:remote-get-snapshot"),
  configureRemote: (input) => ipcRenderer.invoke("openpets:remote-configure", input),
  pairRemoteClient: (input) => ipcRenderer.invoke("openpets:remote-pair-client", input),
  rotateRemoteClient: (clientId) => ipcRenderer.invoke("openpets:remote-rotate-client", clientId),
  revokeRemoteClient: (clientId) => ipcRenderer.invoke("openpets:remote-revoke-client", clientId),
};

contextBridge.exposeInMainWorld("openPetsControlCenter", api);
