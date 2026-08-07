import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, useI18n, type I18nSnapshot } from "./i18n";
import "./styles.css";
import openPetsLogoUrl from "../../../assets/openpets.webp";
import defaultThumbUrl from "../../../assets/default-pet-thumbnail.png";

import claudeLogoUrl from "../../../assets/integrations/claude.svg";
import opencodeLogoUrl from "../../../assets/integrations/opencode.svg";
import cursorLogoUrl from "../../../assets/integrations/cursor.svg";
import piLogoUrl from "../../../assets/integrations/pi.svg";
import vscodeLogoUrl from "../../../assets/integrations/vscode.svg";
import windsurfLogoUrl from "../../../assets/integrations/windsurf.svg";
import zedLogoUrl from "../../../assets/integrations/zed.svg";

type Filter = "all" | "installed" | "featured" | "originals" | "codex";
type InstalledPet = { id: string; displayName: string; description?: string; builtIn: boolean; protected: boolean; installed: boolean; broken?: boolean; brokenReason?: string; source?: { kind?: "catalog"; preview?: string } | { kind: "codex"; path: string } };
type PetEntry = { id: string; displayName: string; description?: string; searchText?: string; preview?: string; thumbnail?: string; spritesheet?: string; category?: "western" | "asian"; original?: boolean; featured?: boolean; catalogPage?: number; sourceKind?: "installed" | "catalog" | "codex"; installed?: boolean; builtIn?: boolean; protected?: boolean; broken?: boolean; brokenReason?: string };
type SearchPetEntry = Pick<PetEntry, "id" | "displayName" | "category" | "original" | "featured"> & { searchText?: string; catalogPage?: number };
type StateSnapshot = { preferences: { defaultPetId: string }; pets: { installed: InstalledPet[] } };
type CatalogState = { pets: PetEntry[]; source: string; error?: string; page?: number; pageCount?: number; total?: number; categories?: { id: "western" | "asian"; label: string; count: number }[]; originalsCount?: number; featuredCount?: number };
type CodexState = { pets: PetEntry[]; error?: string };
type PetScaleOption = { label: string; value: number };
type UserSelectableAnimationState = "idle" | "review" | "running" | "waiting" | "waving" | "jumping" | "failed";
type ReactionAnimationOverrides = Record<string, UserSelectableAnimationState>;
type PetPoolCandidate = { id: string; displayName: string };
type SettingsState = { preferences: { openDefaultPetOnLaunch: boolean; locale?: "system" | string; petScale: number; waitingAnimationDurationMs: number; reactionAnimationOverrides?: ReactionAnimationOverrides; petPoolEnabled: boolean; petPoolOrder?: readonly string[]; petConfinementEnabled: boolean; petCrossDisplayEnabled: boolean; petGravityEnabled: boolean }; petScaleOptions: PetScaleOption[]; petPoolCandidates: ReadonlyArray<PetPoolCandidate> };
type LaunchAtLoginState = { supported: boolean; enabled: boolean };
type LanTopologyIssue = { code: "self_reference" | "missing_reverse"; host: string; edge: "left" | "right" | "up" | "down"; neighbor: string };
type LanStatusSnapshot = { mode: "off" | "server" | "client"; localHost: string; serverUrl: string; port: number; auth: "token" | "none"; authSource: "env" | "stored" | "generated" | "none"; authInsecure: boolean; tokenHint: string | null; topologyHosts: number; topologyLinks: number; topologyIssues: LanTopologyIssue[]; currentHost: string | null; clients: Array<{ host: string; lastSeen: number; position?: { x: number; y: number } }>; updatedAt: number; persistedCurrentHost: string | null; persistedUpdatedAt: number | null };
type UpdateStatus = { state: "idle" | "checking" | "available" | "current" | "error"; currentVersion: string; latestVersion?: string; releaseUrl?: string; checkedAt?: number; error?: string };
type DashboardActivity = { messagesSent: number; reactionsSent: number; reactionCounts: Record<string, number>; perPetActivityCounts: Record<string, number>; lastActivityAt?: number };
type DashboardSnapshot = { defaultPet: { id: string; displayName: string; previewSpriteUrl: string }; installedPetCount: number; catalog: { source: string; total?: number; page?: number; pageCount?: number; error?: string }; plugins: { installed: number; enabled: number; broken: number }; updateStatus: UpdateStatus; activity: DashboardActivity };
type ReactionAnimationSettings = { reactions: { id: string; label: string; description: string; defaultAnimation: UserSelectableAnimationState }[]; animations: { id: UserSelectableAnimationState; label: string; description: string }[]; sprite: { frameWidth: number; frameHeight: number; columns: number; rows: number; states: Record<UserSelectableAnimationState, { row: number; frames: number; durationMs: number; iterations?: number | "infinite" }> }; overrides: ReactionAnimationOverrides; previewSpriteUrl: string; waitingAnimationDurationMs: number; waitingAnimationDurationOptions: { value: number; label: string }[] };
type PluginFilter = "all" | "installed" | "catalog" | "local" | "broken";
type PluginPermission =
  | "pet:speak" | "pet:reaction" | "pet:move" | "timer" | "schedule" | "storage" | "status" | "commands" | "network"
  | "pet:interact" | "pet:pin" | "pet:animate" | "pet:speak:dynamic" | "pet:drop" | "pets:read" | "pets:manage"
  | "audio" | "events" | "ui:toast" | "ui:panel" | "ui:delivery" | "notify" | "bus" | "ai" | "secrets" | "voice:speak" | "voice:listen"
  | "auth" | "files" | "system:openExternal" | "system:metrics" | "clipboard" | "network:write" | "network:local";
type PluginPlatformSettings = {
  allowPluginAudio: boolean;
  allowDynamicSpeech: boolean;
  allowPluginVoice: boolean;
  allowMicrophone: boolean;
  quietHours: { enabled: boolean; start: string; end: string };
  ai: { provider: "none" | "anthropic" | "openai" | "ollama" | "minimax"; model: string; baseUrl?: string };
};
type PluginInspectorState = { schedules: Array<{ id: string; type: string; nextRunMs: number }>; commands: PluginCommand[]; menuItems: Array<{ id: string; title: string }>; status?: PluginStatus; activeBubbles: number; activePanels: number; eventSubscriptions: number; lastError?: string; quotaCounters: Record<string, number> };
type PluginIconName = "plugin" | "bell" | "timer" | "github" | "heart" | "sparkles" | "coffee" | "focus" | "droplet";
type PluginConfigField = { type: "text" | "textarea" | "number" | "boolean" | "select" | "time" | "date" | "multiSelect" | "list" | "secret" | "sound"; label?: string; description?: string; default?: string | number | boolean | string[] | Array<Record<string, unknown>>; options?: Array<{ label: string; value: string; previewSprite?: string }>; presentation?: "sprite-grid" | string; min?: number; max?: number; step?: number; maxLength?: number; maxItems?: number; itemSchema?: Record<string, PluginConfigField> };
type PluginConfigSchema = Record<string, PluginConfigField>;
type PluginConfig = Record<string, unknown>;
type PluginCommandFormField = { id: string; type: "text" | "textarea" | "number" | "boolean" | "select" | "multiSelect" | "time" | "date" | "list"; label: string; default?: string | number | boolean | string[]; options?: Array<{ label: string; value: string }>; min?: number; max?: number; maxLength?: number; required?: boolean };
type PluginCommandForm = { fields: PluginCommandFormField[]; submitLabel?: string };
type PluginCommand = { id: string; title: string; description?: string; form?: PluginCommandForm };
type PluginStatus = { text: string; tone?: "info" | "success" | "warning" | "error" };
type PluginConfigError = { path?: string; code?: string; message?: string };
type PluginCategory = "Companion" | "Wellness" | "Focus" | "Developer" | "Advanced";
type SafePluginRecord = { id: string; name?: string; description?: string; version: string; icon?: PluginIconName; iconDataUrl?: string; source: "catalog" | "local"; sourcePath?: string; bundled?: boolean; category?: PluginCategory; enabled: boolean; brokenReason?: string; approvedPermissions: PluginPermission[]; runtime?: "declarative" | "javascript"; sdkVersion?: string; catalogDisabled?: boolean; catalogDeprecated?: boolean; catalogStatusReason?: string; configSchema?: PluginConfigSchema; effectiveConfig?: PluginConfig; configErrors?: PluginConfigError[]; spritePreviews?: Record<string, { url: string; frameWidth: number; frameHeight: number; frames: number; durationMs: number }>; commands?: PluginCommand[]; status?: PluginStatus };
type SafeCatalogPluginRecord = { id: string; name: string; version: string; description: string; runtime: "declarative" | "javascript"; icon?: PluginIconName; iconDataUrl?: string; sdkVersion?: string; permissions: PluginPermission[]; installed: boolean; bundled?: boolean; category?: PluginCategory; deprecated?: boolean; statusReason?: string; publisherType?: "official" | "community" };
type PluginServiceSnapshot = { plugins: SafePluginRecord[] };
type PluginCatalogSnapshot = { plugins: SafeCatalogPluginRecord[] };
type PluginServiceResult = { ok: true; snapshot: PluginServiceSnapshot } | { ok: false; error: string; snapshot: PluginServiceSnapshot };
type PluginConfigSoundPickResult = { ok: true; sound: { kind: "user-sound"; id: string; name?: string }; snapshot: PluginServiceSnapshot } | { ok: false; error: string; snapshot: PluginServiceSnapshot };
type PluginEntry = { id: string; installed?: SafePluginRecord; catalog?: SafeCatalogPluginRecord };
type RemoteControlScope = "status" | "react" | "say";
type RemoteControlConfigSnapshot = { enabled: boolean; address?: string; port?: number; listening: boolean };
type RemoteControlClientSummary = { id: string; name: string; scopes: RemoteControlScope[]; createdAt: number; updatedAt: number; lastActivityAt?: number; revoked: boolean; revokedAt?: number };
type RemoteControlSnapshot = { config: RemoteControlConfigSnapshot; clients: RemoteControlClientSummary[] };
type RemotePairingResult = { clientId: string; token: string };

type ControlCenterApi = {
  getPetsState(): Promise<StateSnapshot>;
  getDashboardSnapshot(): Promise<DashboardSnapshot>;
  getSettingsState(): Promise<SettingsState>;
  getLanStatus(): Promise<LanStatusSnapshot>;
  getI18n(): Promise<I18nSnapshot>;
  updatePreferences(patch: Partial<SettingsState["preferences"]>): Promise<SettingsState>;
  getReactionAnimationSettings(): Promise<ReactionAnimationSettings>;
  getLaunchAtLogin(): Promise<LaunchAtLoginState>;
  setLaunchAtLogin(enabled: boolean): Promise<LaunchAtLoginState>;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  openUpdateReleasePage(): Promise<void>;
  resetDefaultPetPosition(): Promise<SettingsState>;
  setPetPoolOrder(ids: string[]): Promise<SettingsState>;
  getPluginsSnapshot(): Promise<PluginServiceSnapshot>;
  getPluginCatalogSnapshot(refresh?: boolean): Promise<PluginCatalogSnapshot>;
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginServiceResult>;
  savePluginConfig(id: string, config: PluginConfig): Promise<PluginServiceResult>;
  pickPluginConfigSound(id: string): Promise<PluginConfigSoundPickResult>;
  reloadPlugin(id: string): Promise<PluginServiceResult>;
  refreshLocalPlugin(id: string): Promise<PluginServiceResult>;
  executePluginCommand(id: string, commandId: string, args?: Record<string, unknown>): Promise<PluginServiceResult>;
  loadLocalPlugin(): Promise<PluginServiceResult>;
  installCatalogPlugin(id: string): Promise<PluginServiceResult>;
  updateCatalogPlugin(id: string): Promise<PluginServiceResult>;
  uninstallPlugin(id: string): Promise<PluginServiceResult>;
  getPluginInspector(id: string): Promise<PluginInspectorState>;
  getPluginPlatformSettings(): Promise<PluginPlatformSettings>;
  updatePluginPlatformSettings(patch: Partial<PluginPlatformSettings>): Promise<PluginPlatformSettings>;
  setPluginAiApiKey(key: string | null): Promise<{ ok: boolean; hasKey: boolean }>;
  getPluginAiApiKeyStatus(): Promise<{ hasKey: boolean }>;
  getCatalog(): Promise<CatalogState>;
  getCatalogPage(page: number): Promise<CatalogState>;
  getCatalogSearch(): Promise<{ pets: SearchPetEntry[]; error?: string }>;
  getCodexPets(): Promise<CodexState>;
  setDefaultPet(petId: string): Promise<StateSnapshot>;
  installPet(petId: string): Promise<unknown>;
  installLocalPet(): Promise<unknown>;
  importCodexPet(petId: string): Promise<unknown>;
  openGallery(): Promise<void>;
  removePet(petId: string): Promise<StateSnapshot>;
  onRouteChange(callback: (route: Route) => void): () => void;
  onPluginsRefresh(callback: () => void): () => void;
  getIntegrationsState(selectedPetId?: string, commandMode?: "published" | "local" | "bundled"): Promise<AgentSetupSnapshot>;
  runIntegrationAction(action: AgentSetupAction, selectedPetId?: string, commandMode?: "published" | "local" | "bundled"): Promise<AgentSetupSnapshot>;
  updateIntegrationCommandPaths(patch: Partial<AgentSetupCommandPaths>): Promise<AgentSetupCommandPaths>;
  getRemoteSnapshot(): Promise<RemoteControlSnapshot>;
  configureRemote(input: { enabled: boolean; address?: string; port?: number }): Promise<RemoteControlSnapshot>;
  pairRemoteClient(input: { name: string; scopes: RemoteControlScope[] }): Promise<RemotePairingResult>;
  rotateRemoteClient(clientId: string): Promise<RemotePairingResult>;
  revokeRemoteClient(clientId: string): Promise<{ revoked: boolean }>;
};


type AgentSetupAction = "configure" | "replace" | "remove" | "install-memory" | "doctor-hooks" | "install-hooks" | "uninstall-hooks" | "opencode-install" | "opencode-remove" | "cursor-install" | "cursor-replace" | "cursor-remove";
type AgentSetupPetOption = { id: string; displayName: string; default: boolean };
type ClaudeCodeStatus = { state: "detected" | "not_detected" | "configured" | "needs_setup" | "error"; label: string; details: string; claudeCommand?: string; version?: string; mcpListWorks: boolean; openPetsEntry: { present: boolean; verified: boolean; matchesExpected: boolean }; canConfigure: boolean; canReplace: boolean; canRemove: boolean };
type ClaudeHookDoctorResult = { status: "installed" | "needs_setup" | "error" | "custom" | "conflict"; settingsPath: string; exists: boolean; valid: boolean; message: string; preview: Record<string, unknown>; asyncSupported: boolean; backupPath?: string };
type ClaudeOpenPetsMemoryStatus = { state: "installed" | "needs_setup" | "error"; label: string; details: string; claudeMdPath: string; openPetsMemoryPath: string; canInstall: boolean };
type OpenCodeSetupStatus = { state: "configured" | "needs_setup" | "not_detected" | "error"; label: string; details: string; configDir: string; canInstall: boolean; canRemove: boolean };
type OpenCodeSetupPreview = { global: true; configDir: string; configPath: string; cleanupConfigPaths: string[]; mcpCommand: string[]; plugin: unknown[] | string; instructionPath: string; configPreview: Record<string, unknown> };
type CursorSetupStatus = { state: "configured" | "needs_setup" | "not_detected" | "error" | "conflict" | "needs_update"; label: string; details: string; configPath: string; canInstall: boolean; canReplace: boolean; canRemove: boolean };
type CursorSetupPreview = { global: true; configPath: string; mcpEntry: Record<string, unknown>; rulesPath: string; rulesContent: string; commandMode: "published" | "local" | "bundled" };
type AgentSetupCommandPaths = { claude: string; node: string; opencode: string };
type AgentSetupActionResult = { ok: boolean; action: AgentSetupAction; message: string; changed: boolean };
type AgentSetupSnapshot = { selectedPetId?: string; commandMode: "published" | "local" | "bundled"; localDevAvailable: boolean; petOptions: AgentSetupPetOption[]; preview: { displayCommand: string; mcpJson: Record<string, unknown> }; status: ClaudeCodeStatus; hookStatus: ClaudeHookDoctorResult; memoryStatus: ClaudeOpenPetsMemoryStatus; opencodeStatus: OpenCodeSetupStatus; opencodePreview: OpenCodeSetupPreview; cursorStatus: CursorSetupStatus; cursorPreview: CursorSetupPreview; commandPaths: AgentSetupCommandPaths; busy: boolean; lastAction?: AgentSetupActionResult };
type StatusTone = keyof typeof statusPillToneClass;

const api = (window as unknown as { openPetsControlCenter: ControlCenterApi }).openPetsControlCenter;


// Inline SVG Icons for actions, pagination, and filters
const InstallIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const ImportIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M12 18v-6" />
    <path d="m9 15 3 3 3-3" />
  </svg>
);

const SetDefaultIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

const ReplaceIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
    <path d="M21 21v-5h-5" />
  </svg>
);

const HookIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m18 15-6-6-6 6" />
  </svg>
);

const MemoryIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 10v6" />
    <path d="M9 13h6" />
    <rect width="18" height="18" x="3" y="3" rx="2" />
  </svg>
);

const RemoveIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

const RefreshIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
);

const ConfigureIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="21" x2="14" y1="4" y2="4" />
    <line x1="10" x2="3" y1="4" y2="4" />
    <line x1="21" x2="12" y1="12" y2="12" />
    <line x1="8" x2="3" y1="12" y2="12" />
    <line x1="21" x2="16" y1="20" y2="20" />
    <line x1="12" x2="3" y1="20" y2="20" />
    <line x1="14" x2="14" y1="2" y2="6" />
    <line x1="8" x2="8" y1="10" y2="14" />
    <line x1="16" x2="16" y1="18" y2="22" />
  </svg>
);

const EyeIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const FolderPlusIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 10v6" />
    <path d="M9 13h6" />
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

const SaveIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8A2 2 0 0 1 21 8.8V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
    <path d="M17 21v-7H7v7" />
    <path d="M7 3v5h8" />
  </svg>
);

const CloseIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

const KeyIcon = () => (
  <svg className="settings-nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
    <path d="m21 2-9.6 9.6" />
    <circle cx="7.5" cy="16.5" r="4.5" />
  </svg>
);

const PrevIcon = () => (
  <svg className="btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

const NextIcon = () => (
  <svg className="btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <path d="m9 18 6-6-6-6" />
  </svg>
);

const FilterAllIcon = () => (
  <svg className="filter-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <rect width="7" height="7" x="3" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="14" rx="1" />
    <rect width="7" height="7" x="3" y="14" rx="1" />
  </svg>
);

const FilterInstalledIcon = () => (
  <svg className="filter-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

const FilterFeaturedIcon = () => (
  <svg className="filter-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3q1 4 4 6.5t3 5.5a7 7 0 0 1-14 0 5 5 0 0 1 1-3 3 3 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4" />
  </svg>
);

const FilterOriginalIcon = () => (
  <svg className="filter-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275Z" />
  </svg>
);

const FilterWesternIcon = () => (
  <svg className="filter-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
    <path d="M2 12h20" />
  </svg>
);

const FilterAsianIcon = () => (
  <svg className="filter-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </svg>
);

const FilterCodexIcon = () => (
  <svg className="filter-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </svg>
);

const MessageIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const HeartIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
  </svg>
);

const StarIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

const ZapIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

const ActivityIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
);

const BoxIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </svg>
);

const ShieldIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1Z" />
  </svg>
);

// Navigation Shell Types and Icons
type Route = "dashboard" | "pets" | "settings" | "plugins" | "integrations";

const DashboardIcon = () => (
  <svg className="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect fill="currentColor" width="7" height="9" x="3" y="3" rx="1" />
    <rect fill="currentColor" width="7" height="5" x="14" y="3" rx="1" />
    <rect fill="currentColor" width="7" height="9" x="14" y="12" rx="1" />
    <rect fill="currentColor" width="7" height="5" x="3" y="16" rx="1" />
  </svg>
);

const PetsIcon = () => (
  <svg className="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle fill="currentColor" cx="11" cy="4" r="2" />
    <circle fill="currentColor" cx="18" cy="8" r="2" />
    <circle fill="currentColor" cx="20" cy="16" r="2" />
    <path fill="currentColor" d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045q-.64-2.065-2.7-2.705A3.5 3.5 0 0 1 5.5 10Z" />
  </svg>
);

const SettingsIcon = () => (
  <svg className="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="21" x2="14" y1="4" y2="4" />
    <line x1="10" x2="3" y1="4" y2="4" />
    <line x1="21" x2="12" y1="12" y2="12" />
    <line x1="8" x2="3" y1="12" y2="12" />
    <line x1="21" x2="16" y1="20" y2="20" />
    <line x1="12" x2="3" y1="20" y2="20" />
    <line x1="14" x2="14" y1="2" y2="6" />
    <line x1="8" x2="8" y1="10" y2="14" />
    <line x1="16" x2="16" y1="18" y2="22" />
  </svg>
);

const PluginsIcon = () => (
  <svg className="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path fill="currentColor" d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2" />
    <rect fill="currentColor" width="8" height="8" x="14" y="2" rx="1" />
  </svg>
);

const IntegrationsIcon = () => (
  <svg className="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="12" cy="18" r="3" />
    <path d="M8.6 7.5 10.8 15" />
    <path d="M15.4 7.5 13.2 15" />
    <path d="M9 6h6" />
  </svg>
);

const navTabs = [
  { id: "dashboard" as const, labelKey: "nav.dashboard", icon: <DashboardIcon /> },
  { id: "pets" as const, labelKey: "nav.pets", icon: <PetsIcon /> },
  { id: "settings" as const, labelKey: "nav.settings", icon: <SettingsIcon /> },
  { id: "plugins" as const, labelKey: "nav.plugins", icon: <PluginsIcon /> },
  { id: "integrations" as const, labelKey: "nav.integrations", icon: <IntegrationsIcon /> },
];

const routeMetadata: Record<Route, { titleKey: string; descKey: string }> = {
  dashboard: {
    titleKey: "route.dashboard.title",
    descKey: "route.dashboard.description",
  },
  pets: {
    titleKey: "route.pets.title",
    descKey: "route.pets.description",
  },
  settings: {
    titleKey: "route.settings.title",
    descKey: "route.settings.description",
  },
  plugins: {
    titleKey: "route.plugins.title",
    descKey: "route.plugins.description",
  },
  integrations: {
    titleKey: "route.integrations.title",
    descKey: "route.integrations.description",
  },
};

function DashboardView({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const next = await api.getDashboardSnapshot();
      setSnapshot(next);
      setError("");
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  };

  useEffect(() => { void load(); }, []);

  if (!snapshot) {
    return (
      <div className="flex flex-col gap-6 h-full">
        <GlassCard className="flex h-full flex-col items-center justify-center gap-4 text-center py-16">
          <p className="text-sm font-semibold text-slatecopy">{error || t("dashboard.loading")}</p>
          {error && <Button variant="secondary" size="compact" icon={<RefreshIcon />} onClick={() => void load()}>{t("common.retry")}</Button>}
        </GlassCard>
      </div>
    );
  }

  const { activity, defaultPet, plugins, installedPetCount, updateStatus, catalog } = snapshot;

  // Find top pet by activity or fallback to default
  const topPetId = Object.entries(activity.perPetActivityCounts).sort(([, a], [, b]) => b - a)[0]?.[0];
  const topPetName = topPetId === defaultPet.id ? defaultPet.displayName : (topPetId || defaultPet.displayName);

  // Find top reaction
  const reactionEntries = Object.entries(activity.reactionCounts)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a);
  const reactionTotal = reactionEntries.reduce((total, [, count]) => total + count, 0);
  const reactionColors = ["#3b82f6", "#a855f7", "#f97316", "#14b8a6"];
  const reactionDonutSegments = reactionEntries.slice(0, 4).map(([label, count], index) => ({
    label,
    count,
    color: reactionColors[index] ?? "#64748b",
  }));
  const topCompanionEntries = Object.entries(activity.perPetActivityCounts)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4);
  const maxCompanionActivity = Math.max(...topCompanionEntries.map(([, count]) => count), 1);
  const lastActiveLabel = activity.lastActivityAt ? new Date(activity.lastActivityAt).toLocaleString() : t("dashboard.lastActive.none");
  const updateLabel = updateStatus.state === "available" ? t("dashboard.update.available") : updateStatus.state === "error" ? t("dashboard.update.error") : updateStatus.state === "checking" ? t("dashboard.update.checking") : updateStatus.state === "current" ? t("dashboard.update.current") : t("dashboard.update.notChecked");

  return (
    <div className="dashboard-layout">
      {error && <div className="error">{error}</div>}

      <section className="dashboard-hero">
        <div className="dashboard-hero-content">
          <p className="eyebrow !text-blue-100 opacity-80">{t("dashboard.hero.eyebrow")}</p>
          <h2 className="dashboard-hero-title">{defaultPet.displayName}</h2>
          <p className="dashboard-hero-desc">
            {t("dashboard.hero.desc")}
          </p>
          <div className="flex gap-3 mt-3">
            <Button variant="secondary" size="compact" onClick={() => onNavigate("pets")}>{t("dashboard.hero.changePet")}</Button>
          </div>
        </div>
        <div className="dashboard-hero-pet">
          <SpriteFrame src={defaultPet.previewSpriteUrl} label={defaultPet.displayName} state="idle" size="detail" />
        </div>
      </section>

      <div className="dashboard-grid">
        <article className="dashboard-stat-card">
          <div className="dashboard-stat-header">
            <div className="dashboard-stat-icon"><MessageIcon /></div>
            <span className="dashboard-stat-label">{t("dashboard.stat.messages")}</span>
          </div>
          <div className="dashboard-stat-value">{activity.messagesSent.toLocaleString()}</div>
          <div className="dashboard-stat-footer">{t("dashboard.stat.messages.footer")}</div>
        </article>

        <article className="dashboard-stat-card">
          <div className="dashboard-stat-header">
            <div className="dashboard-stat-icon"><HeartIcon /></div>
            <span className="dashboard-stat-label">{t("dashboard.stat.reactions")}</span>
          </div>
          <div className="dashboard-stat-value">{activity.reactionsSent.toLocaleString()}</div>
          <div className="dashboard-stat-footer">{t("dashboard.stat.reactions.footer")}</div>
        </article>

        <article className="dashboard-stat-card">
          <div className="dashboard-stat-header">
            <div className="dashboard-stat-icon"><StarIcon /></div>
            <span className="dashboard-stat-label">{t("dashboard.stat.topCompanion")}</span>
          </div>
          <div className="dashboard-stat-value truncate text-2xl">{topPetName}</div>
          <div className="dashboard-stat-footer">{t("dashboard.stat.topCompanion.footer")}</div>
        </article>
      </div>

      <div className="dashboard-row">
        <GlassCard className="dashboard-activity-card">
          <div className="dashboard-section-title"><ActivityIcon /> {t("dashboard.activity.title")}</div>
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <span className="text-[10px] font-bold text-slatecopy uppercase tracking-wider">{t("dashboard.activity.topReactions")}</span>
              <div className="dashboard-reaction-list">
                {reactionEntries.length > 0 ? (
                  reactionEntries.slice(0, 6)
                    .map(([label, count]) => (
                      <div key={label} className="dashboard-reaction-item">
                        <span className="dashboard-reaction-count">{count}</span>
                        <span className="dashboard-reaction-label">{label}</span>
                      </div>
                    ))
                ) : (
                  <div className="text-xs text-slatecopy italic py-2">{t("dashboard.activity.noReactions")}</div>
                )}
              </div>
            </div>

            <div className="dashboard-activity-charts">
              <section className="dashboard-chart-panel dashboard-reaction-mix">
                <div className="dashboard-chart-heading">
                  <span>{t("dashboard.reactionMix.title")}</span>
                  <small>{reactionTotal ? t("dashboard.reactionMix.total", { count: reactionTotal.toLocaleString() }) : t("dashboard.reactionMix.waiting")}</small>
                </div>
                <div className="dashboard-donut-row">
                  <div className="dashboard-donut" aria-label={t("dashboard.reactionMix.chartLabel")}>
                    <svg viewBox="0 0 100 100" role="img">
                      <circle className="dashboard-donut-track" cx="50" cy="50" r="40" />
                      {reactionTotal > 0 && reactionDonutSegments.map((segment, index) => {
                        const circumference = 251.327;
                        const previousTotal = reactionDonutSegments.slice(0, index).reduce((total, item) => total + item.count, 0);
                        const dash = (segment.count / reactionTotal) * circumference;
                        const offset = -(previousTotal / reactionTotal) * circumference;
                        return <circle key={segment.label} className="dashboard-donut-segment" cx="50" cy="50" r="40" stroke={segment.color} strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={offset} />;
                      })}
                    </svg>
                    <div className="dashboard-donut-center">
                      <strong>{reactionTotal.toLocaleString()}</strong>
                      <span>{t("dashboard.reactionMix.reactions")}</span>
                    </div>
                  </div>
                  <div className="dashboard-donut-legend">
                    {reactionDonutSegments.length ? reactionDonutSegments.map((segment) => (
                      <div key={segment.label} className="dashboard-donut-legend-item">
                        <span className="dashboard-donut-dot" style={{ background: segment.color }} />
                        <span>{segment.label}</span>
                        <strong>{segment.count}</strong>
                      </div>
                    )) : <p>{t("dashboard.reactionMix.empty")}</p>}
                  </div>
                </div>
              </section>

              <section className="dashboard-chart-panel dashboard-companion-bars">
                <div className="dashboard-chart-heading">
                  <span>{t("dashboard.companions.title")}</span>
                  <small>{t("dashboard.companions.subtitle")}</small>
                </div>
                <div className="dashboard-bars-list">
                  {topCompanionEntries.length ? topCompanionEntries.map(([petId, count]) => {
                    const label = petId === defaultPet.id ? defaultPet.displayName : petId.replace(/[-_]/g, " ");
                    return (
                      <div key={petId} className="dashboard-bar-item">
                        <div className="dashboard-bar-labels">
                          <span>{label}</span>
                          <strong>{count}</strong>
                        </div>
                        <div className="dashboard-bar-track"><span style={{ width: `${Math.max(8, Math.round((count / maxCompanionActivity) * 100))}%` }} /></div>
                      </div>
                    );
                  }) : <p className="dashboard-empty-note">{t("dashboard.companions.empty")}</p>}
                </div>
              </section>

              <div className="dashboard-last-active-pill">{t("dashboard.lastActive.label")}<strong>{lastActiveLabel}</strong></div>
            </div>
          </div>
        </GlassCard>

        <GlassCard className="dashboard-system-card">
          <div className="dashboard-section-title"><ZapIcon /> {t("dashboard.system.title")}</div>
          <div className="dashboard-system-list">
            <div className="dashboard-system-item">
              <div className="dashboard-system-info">
                <div className="dashboard-system-icon"><BoxIcon /></div>
                <span className="dashboard-system-label">{t("dashboard.system.pets")}</span>
              </div>
              <span className="dashboard-system-value">{t("dashboard.system.pets.value", { count: installedPetCount })}</span>
            </div>

            <div className="dashboard-system-item">
              <div className="dashboard-system-info">
                <div className="dashboard-system-icon"><PluginGlyph className="w-4 h-4" /></div>
                <span className="dashboard-system-label">{t("dashboard.system.plugins")}</span>
              </div>
              <div className="flex gap-1.5">
                <StatusPill tone="green">{t("dashboard.system.plugins.enabled", { count: plugins.enabled })}</StatusPill>
                {plugins.broken > 0 && <StatusPill tone="red">{plugins.broken}</StatusPill>}
              </div>
            </div>

            <div className="dashboard-system-item">
              <div className="dashboard-system-info">
                <div className="dashboard-system-icon"><StarIcon /></div>
                <span className="dashboard-system-label">{t("dashboard.system.catalog")}</span>
              </div>
              <span className="dashboard-system-value">{catalog.error ? t("dashboard.system.catalog.offline") : catalog.total ? t("dashboard.system.catalog.pets", { count: catalog.total }) : t("dashboard.system.catalog.ready")}</span>
            </div>

            <div className="dashboard-system-item">
              <div className="dashboard-system-info">
                <div className="dashboard-system-icon"><ShieldIcon /></div>
                <span className="dashboard-system-label">{t("dashboard.system.updates")}</span>
              </div>
              <StatusPill tone={updateStatus.state === "available" ? "orange" : "blue"}>
                {updateLabel}
              </StatusPill>
            </div>
          </div>

          <div className="mt-auto pt-4 border-t border-blue-100/30">
             <div className="flex items-center justify-between text-[10px] font-bold text-slatecopy uppercase tracking-wider">
               <span>{t("dashboard.system.version")}</span>
               <span className="font-mono">{updateStatus.currentVersion}</span>
             </div>
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

function PlaceholderView({ route }: { route: "dashboard" }) {
  const { t } = useI18n();
  const meta = routeMetadata[route];
  return (
    <div className="grid grid-cols-1 w-full">
      <GlassCard className="flex flex-col items-center justify-center text-center py-16 px-8 h-full min-h-[420px]">
        <div className="p-4 rounded-3xl bg-blue-50/80 border border-blue-100/50 mb-6 text-brand">
          {route === "dashboard" && <DashboardIcon />}
        </div>
        <h2 className="font-monoDisplay text-2xl font-black mb-2 text-navy">{t(meta.titleKey)}</h2>
        <p className="text-sm text-slatecopy max-w-md mb-6">{t(meta.descKey)}</p>
        <span className="inline-flex items-center rounded-full bg-blue-50/80 px-4 py-1.5 text-xs font-bold text-brand border border-blue-200/50">
          {t("placeholder.comingSoon")}
        </span>
      </GlassCard>
    </div>
  );
}

const filterIcons: Record<Filter, React.ReactNode> = {
  all: <FilterAllIcon />,
  installed: <FilterInstalledIcon />,
  featured: <FilterFeaturedIcon />,
  originals: <FilterOriginalIcon />,
  codex: <FilterCodexIcon />,
};

const filterLabelKeys: Record<Filter, string> = {
  all: "pets.filter.all",
  installed: "pets.filter.installed",
  featured: "pets.filter.featured",
  originals: "pets.filter.originals",
  codex: "pets.filter.codex",
};

const buttonVariantClass = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  danger: "btn-danger",
  success: "btn-success",
  warning: "btn-warning",
} as const;

const statusPillToneClass = {
  blue: "pill-blue",
  green: "pill-green",
  orange: "pill-orange",
  purple: "pill-purple",
  yellow: "pill-yellow",
  red: "pill-red",
  slate: "pill-slate",
} as const;

function isRoute(value: string | null | undefined): value is Route {
  return value === "dashboard" || value === "pets" || value === "settings" || value === "plugins" || value === "integrations";
}

function initialControlCenterRoute(): Route {
  try {
    const params = new URLSearchParams(window.location.search);
    const route = params.get("route");
    return isRoute(route) ? route : "dashboard";
  } catch {
    return "dashboard";
  }
}

const commandModeLabelKeys: Record<AgentSetupSnapshot["commandMode"], string> = {
  published: "integrations.commandMode.published",
  bundled: "integrations.commandMode.bundled",
  local: "integrations.commandMode.local",
};

function Button({
  children,
  variant = "primary",
  size = "normal",
  onClick,
  disabled,
  icon,
  iconPosition = "left",
  fullWidth,
  ariaLabel,
  type = "button",
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger" | "success" | "warning";
  size?: "normal" | "compact";
  onClick?: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  iconPosition?: "left" | "right";
  fullWidth?: boolean;
  ariaLabel?: string;
  type?: "button" | "submit" | "reset";
}) {
  return (
    <button
      type={type}
      className={`btn ${buttonVariantClass[variant]} ${size === "compact" ? "btn-compact" : ""} ${fullWidth ? "w-full" : ""} ${icon ? "has-icon" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {icon && iconPosition === "left" && <span className="btn-icon-wrapper mr-1.5 inline-flex items-center justify-center">{icon}</span>}
      <span className="btn-text">{children}</span>
      {icon && iconPosition === "right" && <span className="btn-icon-wrapper ml-1.5 inline-flex items-center justify-center">{icon}</span>}
    </button>
  );
}
function GlassCard({ children, className = "" }: { children: React.ReactNode; className?: string }) { return <section className={`glass ${className}`}>{children}</section>; }
function StatusPill({ children, tone = "blue" }: { children: React.ReactNode; tone?: keyof typeof statusPillToneClass }) { return <span className={`pill ${statusPillToneClass[tone]}`}>{children}</span>; }
function SearchInput(props: React.InputHTMLAttributes<HTMLInputElement>) { const { t } = useI18n(); return <input className="search" placeholder={t("pets.search.placeholder")} {...props} />; }

function isAllowedCatalogPreview(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "openpets.dev" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname.startsWith("/pets/") &&
      url.pathname.endsWith(".webp");
  } catch {
    return false;
  }
}

function isAllowedCodexPreview(value: string | undefined): value is string {
  return typeof value === "string" && /^openpets-codex:\/\/spritesheet\/[a-zA-Z0-9%][a-zA-Z0-9%_-]{0,128}$/u.test(value);
}

function isAllowedInstalledPetPreview(value: string | undefined): value is string {
  return typeof value === "string" && /^openpets-installed:\/\/spritesheet\/[a-zA-Z0-9%][a-zA-Z0-9%_-]{0,128}$/u.test(value);
}

function isAllowedDefaultPetPreview(value: string | undefined): value is string {
  return typeof value === "string" && /^openpets-pet-preview:\/\/spritesheet\/default\?v=[a-z0-9_-]+-\d+-\d+$/u.test(value);
}

function isAllowedDataUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^data:image\/(?:png|webp|jpeg|jpg);base64,[a-z0-9+/=]+$/iu.test(value);
}

function safePetImage(value: string | undefined): string | undefined {
  return isAllowedCatalogPreview(value) || isAllowedCodexPreview(value) || isAllowedInstalledPetPreview(value) || isAllowedDefaultPetPreview(value) || isAllowedDataUrl(value) ? value : undefined;
}

function installedPetSpritesheetUrl(petId: string): string {
  return `openpets-installed://spritesheet/${encodeURIComponent(petId)}`;
}

function imageDebug(value: string | undefined): string {
  if (!value) return "missing";
  if (value.startsWith("data:image/")) return `data:${value.slice(5, 16)}`;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

function logPetsEvent(event: string, fields: Record<string, unknown>): void {
  console.info(`[ControlCenterPets] ${JSON.stringify({ event, ...fields })}`);
}

function logPetsError(event: string, fields: Record<string, unknown>): void {
  console.error(`[ControlCenterPets] ${JSON.stringify({ event, ...fields })}`);
}

const spriteFrameSizes = {
  thumb: { width: 54, height: 58 },
  detail: { width: 144, height: 156 },
  mini: { width: 56, height: 61 },
} as const;

const spriteStates = {
  idle: { row: 0, frames: 6, duration: "1.65s" },
  thinking: { row: 8, frames: 6, duration: "1.55s" },
  wave: { row: 3, frames: 4, duration: "1.25s" },
  happy: { row: 4, frames: 5, duration: "1.35s" },
} as const;

function SpriteFrame({ src, label, state = "idle", size = "detail" }: { src?: string; label: string; state?: "idle" | "thinking" | "happy" | "wave"; size?: "thumb" | "detail" | "mini" }) {
  const safeSrc = safePetImage(src);
  if (!safeSrc) return <img src={defaultThumbUrl} alt="" />;
  const frame = spriteFrameSizes[size];
  const sprite = spriteStates[state];
  const xValues = Array.from({ length: sprite.frames }, (_, index) => String(-index * frame.width)).join(";");
  const y = -sprite.row * frame.height;
  return <svg className={`sprite-frame sprite-${state} sprite-${size}`} width={frame.width} height={frame.height} viewBox={`0 0 ${frame.width} ${frame.height}`} role="img" aria-label={label}>
    <image href={safeSrc} x="0" y={y} width={frame.width * 8} height={frame.height * 9} preserveAspectRatio="none" onError={() => logPetsError("sprite-failed", { label, state, size, src: imageDebug(safeSrc) })}>
      <animate attributeName="x" values={xValues} dur={sprite.duration} repeatCount="indefinite" calcMode="discrete" />
    </image>
  </svg>;
}

function PetImage({ src, alt = "", debugLabel }: { src?: string; alt?: string; debugLabel: string }) {
  const safeSrc = safePetImage(src) || defaultThumbUrl;
  return <img src={safeSrc} alt={alt} draggable="false" onError={() => logPetsError("image-failed", { label: debugLabel, src: imageDebug(safeSrc) })} />;
}

function PetPoolOrderList({
  order,
  candidates,
  disabled,
  onChangeOrder,
}: {
  order: readonly string[];
  candidates: ReadonlyArray<PetPoolCandidate>;
  disabled: boolean;
  onChangeOrder: (newOrder: string[]) => void;
}) {
  const [addValue, setAddValue] = useState("");
  const nameFor = (id: string) => candidates.find((c) => c.id === id)?.displayName ?? id;
  const available = candidates.filter((c) => !order.includes(c.id));

  function handleAdd() {
    const val = addValue || available[0]?.id;
    if (!val) return;
    onChangeOrder([...order, val]);
    setAddValue("");
  }

  function handleRemove(idx: number) {
    onChangeOrder([...order.slice(0, idx), ...order.slice(idx + 1)]);
  }

  function handleMoveUp(idx: number) {
    if (idx === 0) return;
    const next = [...order];
    const above = next[idx - 1] as string;
    const current = next[idx] as string;
    next[idx - 1] = current;
    next[idx] = above;
    onChangeOrder(next);
  }

  function handleMoveDown(idx: number) {
    if (idx === order.length - 1) return;
    const next = [...order];
    const below = next[idx + 1] as string;
    const current = next[idx] as string;
    next[idx + 1] = current;
    next[idx] = below;
    onChangeOrder(next);
  }

  return (
    <div className="flex flex-col border-t border-blue-50">
      {order.length === 0 && (
        <p className="px-5 py-4 text-xs text-slatecopy">No pets in the pool yet. Add one below.</p>
      )}
      {order.map((id, idx) => (
        <div
          key={id}
          className="flex items-center gap-3 border-b border-blue-50 px-5 py-3 transition-colors hover:bg-white/80 last:border-b-0"
        >
          <span className="w-14 shrink-0 font-mono text-xs font-bold text-slatecopy">
            {`Slot ${idx + 1}`}
          </span>
          <span className="flex-1 truncate text-sm font-semibold text-navy">{nameFor(id)}</span>
          <div className="flex shrink-0 items-center gap-1">
            <button
              className="btn btn-compact btn-secondary"
              disabled={disabled || idx === 0}
              onClick={() => handleMoveUp(idx)}
              aria-label="Move up"
            >
              ↑
            </button>
            <button
              className="btn btn-compact btn-secondary"
              disabled={disabled || idx === order.length - 1}
              onClick={() => handleMoveDown(idx)}
              aria-label="Move down"
            >
              ↓
            </button>
            <button
              className="btn btn-compact btn-danger"
              disabled={disabled}
              onClick={() => handleRemove(idx)}
              aria-label="Remove from pool"
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <div className="flex items-center gap-3 px-5 py-3">
        {candidates.length === 0 ? (
          <p className="text-xs text-slatecopy">No additional pets installed. Install pets from the catalog to add them here.</p>
        ) : available.length === 0 ? (
          <p className="text-xs text-slatecopy">All installed pets are already in the pool.</p>
        ) : (
          <>
            <select
              className="settings-select flex-1"
              value={addValue || (available[0]?.id ?? "")}
              disabled={disabled}
              onChange={(e) => setAddValue(e.target.value)}
            >
              {available.map((c) => (
                <option key={c.id} value={c.id}>{c.displayName}</option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="compact"
              disabled={disabled || available.length === 0}
              onClick={handleAdd}
            >
              Add to pool
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function ToggleRow({ title, description, checked, disabled, onChange, testId }: { title: string; description: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; testId?: string }) {
  return <label className={`settings-row ${disabled ? "opacity-60" : ""}`}>
    <div className="settings-row-info"><strong>{title}</strong><small>{description}</small></div>
    <input className="settings-toggle" type="checkbox" checked={checked} disabled={disabled} data-testid={testId} onChange={(event) => { const next = event.target.checked; onChange(next); }} />
  </label>;
}

function formatUpdateStatus(status: UpdateStatus | null, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (!status) return t("settings.update.notLoaded");
  if (status.state === "checking") return t("settings.update.checking");
  if (status.state === "available") return t("settings.update.available", { version: status.latestVersion ?? t("common.latest") });
  if (status.state === "current") return t("settings.update.current");
  if (status.state === "error") return status.error || t("settings.update.failed");
  return t("settings.update.version", { version: status.currentVersion });
}

function ReactionPreviewSprite({ settings, state }: { settings: ReactionAnimationSettings; state: UserSelectableAnimationState }) {
  const { t } = useI18n();
  const frame = { width: settings.sprite.frameWidth, height: settings.sprite.frameHeight };
  const sprite = settings.sprite.states[state] ?? settings.sprite.states.idle;
  const xValues = Array.from({ length: sprite.frames }, (_, index) => String(-index * frame.width)).join(";");
  const y = -sprite.row * frame.height;

  return (
    <div className="reaction-preview-sprite-shell">
      <svg className="reaction-preview-sprite" width={frame.width} height={frame.height} viewBox={`0 0 ${frame.width} ${frame.height}`} role="img" aria-label={t("settings.reactions.previewAria", { state })}>
        <image href={settings.previewSpriteUrl} x="0" y={y} width={frame.width * settings.sprite.columns} height={frame.height * settings.sprite.rows} preserveAspectRatio="none">
          <animate attributeName="x" values={xValues} dur={`${sprite.durationMs}ms`} repeatCount="indefinite" calcMode="discrete" />
        </image>
      </svg>
    </div>
  );
}

function SettingsView({ onTokenHandoff }: { onTokenHandoff: (result: RemotePairingResult, endpoint: string | null) => void }) {
  const { t, localePreference, availableLocales, reload: reloadI18n } = useI18n();
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [reactionSettings, setReactionSettings] = useState<ReactionAnimationSettings | null>(null);
  const [launchAtLogin, setLaunchAtLogin] = useState<LaunchAtLoginState | null>(null);
  const [lanStatus, setLanStatus] = useState<LanStatusSnapshot | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [activeTab, setActiveTab] = useState<"general" | "reactions" | "plugins" | "lan" | "remote">("general");
  const [pluginsSnapshot, setPluginsSnapshot] = useState<PluginServiceSnapshot | null>(null);
  const [platformSettings, setPlatformSettings] = useState<PluginPlatformSettings | null>(null);
  const [aiKeyStatus, setAiKeyStatus] = useState<{ hasKey: boolean }>({ hasKey: false });
  const [aiKeyDraft, setAiKeyDraft] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const reactionSaveQueue = useRef(Promise.resolve());

  async function loadSettings() {
    setError("");
    const [nextSettings, nextReactions, nextLaunch, nextUpdate, nextPlatform, nextAiKey, nextLanStatus, nextPluginsSnapshot] = await Promise.all([
      api.getSettingsState(),
      api.getReactionAnimationSettings(),
      api.getLaunchAtLogin(),
      api.getUpdateStatus(),
      api.getPluginPlatformSettings().catch(() => null),
      api.getPluginAiApiKeyStatus().catch(() => ({ hasKey: false })),
      api.getLanStatus().catch(() => null),
      api.getPluginsSnapshot().catch(() => null),
    ]);
    setSettings(nextSettings);
    setReactionSettings(nextReactions);
    setLaunchAtLogin(nextLaunch);
    setUpdateStatus(nextUpdate);
    setPlatformSettings(nextPlatform);
    setAiKeyStatus(nextAiKey);
    setLanStatus(nextLanStatus);
    setPluginsSnapshot(nextPluginsSnapshot);
    if (nextUpdate.state === "checking") {
      void api.checkForUpdates().then(setUpdateStatus).catch((err) => setError(String(err?.message ?? err)));
    }
  }

  useEffect(() => { void loadSettings().catch((err) => setError(String(err?.message ?? err))); }, []);

  useEffect(() => api.onPluginsRefresh(() => {
    void api.getPluginsSnapshot().then(setPluginsSnapshot).catch((err) => setError(String(err?.message ?? err)));
  }), []);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [message]);

  async function run(label: string, fn: () => Promise<void>) {
    try { setBusy(label); setError(""); setMessage(""); await fn(); }
    catch (err) { setError(String((err as Error)?.message ?? err)); }
    finally { setBusy(""); }
  }

  function patchPreferences(patch: Partial<SettingsState["preferences"]>, success: string) {
    void run(t("settings.busy.saving"), async () => {
      const next = await api.updatePreferences(patch);
      setSettings(next);
      if ("reactionAnimationOverrides" in patch) {
        setReactionSettings((current) => current ? { ...current, overrides: next.preferences.reactionAnimationOverrides ?? {} } : current);
      }
      if ("waitingAnimationDurationMs" in patch) {
        setReactionSettings(await api.getReactionAnimationSettings());
      }
      setMessage(success);
    });
  }

  function changeLocale(value: string) {
    void run(t("settings.busy.saving"), async () => {
      await api.updatePreferences({ locale: value });
      reloadI18n();
      setMessage(t("settings.language.title"));
    });
  }

  function updateReactionOverride(reaction: ReactionAnimationSettings["reactions"][number], value: UserSelectableAnimationState) {
    const queuedSave = reactionSaveQueue.current.catch(() => undefined).then(() => run(t("settings.busy.saving"), async () => {
      const latestReactions = await api.getReactionAnimationSettings();
      const nextOverrides = { ...(latestReactions.overrides ?? {}) };
      if (value === reaction.defaultAnimation) delete nextOverrides[reaction.id];
      else nextOverrides[reaction.id] = value;
      const nextSettings = await api.updatePreferences({ reactionAnimationOverrides: nextOverrides });
      setSettings(nextSettings);
      setReactionSettings({ ...latestReactions, overrides: nextSettings.preferences.reactionAnimationOverrides ?? {} });
      setMessage(t("settings.toast.reactionSaved"));
    }));
    reactionSaveQueue.current = queuedSave;
    void queuedSave;
  }

  const overrides = settings?.preferences.reactionAnimationOverrides ?? {};

  function patchPlatformSettings(patch: Partial<PluginPlatformSettings>, success: string) {
    void run(t("settings.busy.saving"), async () => {
      setPlatformSettings(await api.updatePluginPlatformSettings(patch));
      setMessage(success);
    });
  }

  function updatePetPoolOrder(ids: string[]) {
    void run(t("settings.busy.saving"), async () => {
      const next = await api.setPetPoolOrder(ids);
      setSettings(next);
      setMessage("Saved");
    });
  }

  const isMoverActive = (pluginsSnapshot?.plugins ?? []).some(
    (p) => p.enabled && p.approvedPermissions.includes("pet:move")
  );

  return <div className="settings-layout">
    {error && <div className="error settings-message">{error}</div>}
    {message && <div className="settings-success settings-message">{message}</div>}

    <div className="settings-container">
      <aside className="settings-sidebar">
        <button className={`settings-nav-item ${activeTab === "general" ? "active" : ""}`} onClick={() => setActiveTab("general")}>
          <SettingsIcon />
          <span>{t("settings.nav.general")}</span>
        </button>
        <button className={`settings-nav-item ${activeTab === "reactions" ? "active" : ""}`} onClick={() => setActiveTab("reactions")}>
          <PetsIcon />
          <span>{t("settings.nav.reactions")}</span>
        </button>
        <button className={`settings-nav-item ${activeTab === "plugins" ? "active" : ""}`} onClick={() => setActiveTab("plugins")}>
          <PluginsIcon />
          <span>{t("settings.nav.plugins")}</span>
        </button>
        <button className={`settings-nav-item ${activeTab === "lan" ? "active" : ""}`} onClick={() => setActiveTab("lan")}>
          <IntegrationsIcon />
          <span>{t("settings.nav.lan")}</span>
        </button>
        <button className={`settings-nav-item ${activeTab === "remote" ? "active" : ""}`} onClick={() => setActiveTab("remote")}>
          <KeyIcon />
          <span>{t("settings.nav.remote")}</span>
        </button>
      </aside>

      <main className="settings-content">
        {activeTab === "general" && (
          <>
            <div className="settings-section">
              <p className="eyebrow">{t("settings.general.eyebrow")}</p>
              <h2 className="settings-section-title">{t("settings.general.title")}</h2>

              <div className="settings-group">
                <ToggleRow
                  title={t("settings.general.showOnLaunch.title")}
                  description={t("settings.general.showOnLaunch.description")}
                  checked={settings?.preferences.openDefaultPetOnLaunch ?? false}
                  disabled={!settings || !!busy}
                  onChange={(checked) => patchPreferences({ openDefaultPetOnLaunch: checked }, t("settings.toast.startupSaved"))}
                />
                <ToggleRow
                  title={t("settings.general.launchAtLogin.title")}
                  description={launchAtLogin?.supported ? t("settings.general.launchAtLogin.supported") : t("settings.general.launchAtLogin.unsupported")}
                  checked={launchAtLogin?.enabled ?? false}
                  disabled={!launchAtLogin?.supported || !!busy}
                  onChange={(checked) => void run(t("settings.busy.saving"), async () => { setLaunchAtLogin(await api.setLaunchAtLogin(checked)); setMessage(t("settings.toast.loginStartupSaved")); })}
                />
                <div className="settings-row">
                  <div className="settings-row-info">
                    <strong>{t("settings.general.petScale.title")}</strong>
                    <small>{t("settings.general.petScale.description")}</small>
                  </div>
                  <select className="settings-select" value={settings?.preferences.petScale ?? ""} disabled={!settings || !!busy} onChange={(event) => patchPreferences({ petScale: Number(event.target.value) }, t("settings.toast.petScaleSaved"))}>
                    {(settings?.petScaleOptions ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <strong>{t("settings.language.title")}</strong>
                    <small>{t("settings.language.description")}</small>
                  </div>
                  <select className="settings-select" value={localePreference} disabled={!!busy} onChange={(event) => changeLocale(event.target.value)}>
                    <option value="system">{t("settings.language.system")}</option>
                    {availableLocales.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
              </div>

              <div className="settings-group">
                <ToggleRow
                  title={t("settings.petPool.label")}
                  description={t("settings.petPool.description")}
                  checked={settings?.preferences.petPoolEnabled ?? false}
                  disabled={!settings || !!busy}
                  onChange={(checked) => patchPreferences({ petPoolEnabled: checked }, t("settings.toast.petPoolSaved"))}
                />
                <div className={settings?.preferences.petPoolEnabled ? "" : "opacity-50 pointer-events-none"}>
                  <PetPoolOrderList
                    order={settings?.preferences.petPoolOrder ?? []}
                    candidates={settings?.petPoolCandidates ?? []}
                    disabled={!settings || !!busy || !(settings?.preferences.petPoolEnabled)}
                    onChangeOrder={updatePetPoolOrder}
                  />
                </div>
              </div>

              <div className="settings-actions">
                <Button variant="secondary" size="compact" disabled={!!busy} onClick={() => void run(t("settings.busy.resetting"), async () => { setSettings(await api.resetDefaultPetPosition()); setMessage(t("settings.toast.positionReset")); })}>{t("settings.general.resetPosition")}</Button>
              </div>

              <div className="settings-system-footer">
                <div className="settings-system-info">
                  <RefreshIcon />
                  <span>{t("settings.general.systemStatus")}</span>
                  <span className="settings-system-version">{updateStatus?.currentVersion}</span>
                  <span className="opacity-60">{formatUpdateStatus(updateStatus, t)}</span>
                </div>
                <div className="flex gap-2">
                  {updateStatus?.state === "available" && (
                    <Button variant="primary" size="compact" disabled={!!busy} onClick={() => void run(t("settings.busy.opening"), async () => { await api.openUpdateReleasePage(); })}>{t("settings.general.updateAvailable")}</Button>
                  )}
                  <Button variant="secondary" size="compact" disabled={!!busy || updateStatus?.state === "checking"} onClick={() => void run(t("settings.busy.checking"), async () => { setUpdateStatus(await api.checkForUpdates()); })}>
                    {busy === t("settings.busy.checking") ? t("settings.general.checking") : t("settings.general.checkForUpdates")}
                  </Button>
                </div>
              </div>
            </div>

            <div className="settings-section">
              <h2 className="settings-section-title">{t("settings.movement.title")}</h2>

              <div className="settings-group">
                <ToggleRow
                  title={t("settings.petConfinement.label")}
                  description={t("settings.petConfinement.description")}
                  checked={settings?.preferences.petConfinementEnabled ?? false}
                  disabled={!settings || !!busy}
                  testId="setting-pet-confinement-toggle"
                  onChange={(checked) => patchPreferences({ petConfinementEnabled: checked }, t("settings.toast.confinementSaved"))}
                />
                <ToggleRow
                  title={t("settings.petCrossDisplay.label")}
                  description={isMoverActive ? t("settings.petCrossDisplay.description") : t("settings.petCrossDisplay.helperNoMover")}
                  checked={settings?.preferences.petCrossDisplayEnabled ?? false}
                  disabled={!settings || !!busy || !isMoverActive}
                  testId="setting-pet-cross-display-toggle"
                  onChange={(checked) => patchPreferences({ petCrossDisplayEnabled: checked }, t("settings.toast.crossDisplaySaved"))}
                />
                <ToggleRow
                  title={t("settings.petGravity.label")}
                  description={t("settings.petGravity.description")}
                  checked={settings?.preferences.petGravityEnabled ?? false}
                  disabled={!settings || !!busy}
                  testId="setting-pet-gravity-toggle"
                  onChange={(checked) => patchPreferences({ petGravityEnabled: checked }, t("settings.toast.gravitySaved"))}
                />
              </div>
            </div>
          </>
        )}

        {activeTab === "reactions" && (
          <div className="settings-section">
            <div className="flex items-center justify-between">
              <div>
                <p className="eyebrow">{t("settings.reactions.eyebrow")}</p>
                <h2 className="settings-section-title">{t("settings.reactions.title")}</h2>
              </div>
              <Button variant="secondary" size="compact" disabled={!settings || !!busy || !Object.keys(overrides).length} onClick={() => patchPreferences({ reactionAnimationOverrides: {} }, t("settings.toast.reactionsReset"))}>{t("settings.reactions.resetDefaults")}</Button>
            </div>
            <p className="text-sm text-slatecopy -mt-2 mb-2">{t("settings.reactions.description")}</p>

            <div className="settings-group">
              <div className="settings-row">
                <div className="settings-row-info">
                  <strong>{t("settings.waitingAnimationDuration.title")}</strong>
                  <small>{t("settings.waitingAnimationDuration.description")}</small>
                </div>
                <select
                  className="settings-select"
                  value={settings?.preferences.waitingAnimationDurationMs ?? ""}
                  disabled={!reactionSettings || !settings || !!busy}
                  data-testid="setting-waiting-animation-duration"
                  onChange={(event) => patchPreferences({ waitingAnimationDurationMs: Number(event.target.value) }, t("settings.toast.waitingAnimationSaved"))}
                >
                  {(reactionSettings?.waitingAnimationDurationOptions ?? []).map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div className="reaction-grid">
                {(reactionSettings?.reactions ?? []).map((reaction) => {
                  const currentAnimation = overrides[reaction.id] ?? reaction.defaultAnimation;
                  return (
                    <div className="reaction-row" key={reaction.id}>
                      <div className="reaction-preview-box">
                        {reactionSettings?.previewSpriteUrl && (
                          <ReactionPreviewSprite settings={reactionSettings} state={currentAnimation} />
                        )}
                      </div>
                      <div className="reaction-info">
                        <strong>{reaction.label}</strong>
                        <small>{reaction.description}</small>
                      </div>
                      <select
                        className="settings-select"
                        value={currentAnimation}
                        disabled={!reactionSettings || !settings || !!busy}
                        onChange={(event) => {
                          const value = event.target.value as UserSelectableAnimationState;
                          updateReactionOverride(reaction, value);
                        }}
                      >
                        {(reactionSettings?.animations ?? []).map((animation) => (
                          <option key={animation.id} value={animation.id}>{animation.label}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}


        {activeTab === "lan" && (
          <LanSettingsPanel status={lanStatus} onRefresh={() => void run(t("settings.busy.checking"), async () => { setLanStatus(await api.getLanStatus()); })} busy={!!busy} />
        )}

        {activeTab === "remote" && (
          <RemoteControlSettingsPanel busy={!!busy} onSetMessage={setMessage} onSetError={setError} onTokenHandoff={onTokenHandoff} />
        )}

        {activeTab === "plugins" && (
          <div className="settings-section">
            <p className="eyebrow">{t("settings.plugins.eyebrow")}</p>
            <h2 className="settings-section-title">{t("settings.plugins.title")}</h2>
            <p className="text-sm text-slatecopy -mt-2 mb-2">{t("settings.plugins.description")}</p>

            <div className="settings-group">
              <ToggleRow
                title={t("settings.plugins.audio.title")}
                description={t("settings.plugins.audio.description")}
                checked={platformSettings?.allowPluginAudio ?? true}
                disabled={!platformSettings || !!busy}
                onChange={(checked) => patchPlatformSettings({ allowPluginAudio: checked }, t("settings.toast.audioSaved"))}
              />
              <ToggleRow
                title={t("settings.plugins.voice.title")}
                description={t("settings.plugins.voice.description")}
                checked={platformSettings?.allowPluginVoice ?? true}
                disabled={!platformSettings || !!busy}
                onChange={(checked) => patchPlatformSettings({ allowPluginVoice: checked }, t("settings.toast.voiceSaved"))}
              />
              <ToggleRow
                title={t("settings.plugins.dynamicSpeech.title")}
                description={t("settings.plugins.dynamicSpeech.description")}
                checked={platformSettings?.allowDynamicSpeech ?? false}
                disabled={!platformSettings || !!busy}
                onChange={(checked) => patchPlatformSettings({ allowDynamicSpeech: checked }, t("settings.toast.dynamicSpeechSaved"))}
              />
              <ToggleRow
                title={t("settings.plugins.microphone.title")}
                description={t("settings.plugins.microphone.description")}
                checked={platformSettings?.allowMicrophone ?? false}
                disabled={!platformSettings || !!busy}
                onChange={(checked) => patchPlatformSettings({ allowMicrophone: checked }, t("settings.toast.microphoneSaved"))}
              />
            </div>

            <div className="settings-group">
              <ToggleRow
                title={t("settings.plugins.quietHours.title")}
                description={t("settings.plugins.quietHours.description")}
                checked={platformSettings?.quietHours.enabled ?? false}
                disabled={!platformSettings || !!busy}
                onChange={(checked) => patchPlatformSettings({ quietHours: { ...(platformSettings?.quietHours ?? { start: "22:00", end: "08:00" }), enabled: checked } }, t("settings.toast.quietHoursSaved"))}
              />
              <div className="settings-row">
                <div className="settings-row-info">
                  <strong>{t("settings.plugins.quietWindow.title")}</strong>
                  <small>{t("settings.plugins.quietWindow.description")}</small>
                </div>
                <div className="flex gap-2 items-center">
                  <input type="time" className="settings-select" value={platformSettings?.quietHours.start ?? "22:00"} disabled={!platformSettings || !!busy} onChange={(event) => patchPlatformSettings({ quietHours: { ...(platformSettings?.quietHours ?? { enabled: false, end: "08:00" }), start: event.target.value } as PluginPlatformSettings["quietHours"] }, t("settings.toast.quietHoursSaved"))} />
                  <span className="opacity-60">{t("common.to")}</span>
                  <input type="time" className="settings-select" value={platformSettings?.quietHours.end ?? "08:00"} disabled={!platformSettings || !!busy} onChange={(event) => patchPlatformSettings({ quietHours: { ...(platformSettings?.quietHours ?? { enabled: false, start: "22:00" }), end: event.target.value } as PluginPlatformSettings["quietHours"] }, t("settings.toast.quietHoursSaved"))} />
                </div>
              </div>
            </div>

            <div className="settings-group">
              <div className="settings-row">
                <div className="settings-row-info">
                  <strong>{t("settings.plugins.aiProvider.title")}</strong>
                  <small>{t("settings.plugins.aiProvider.description")}</small>
                </div>
                <select className="settings-select" value={platformSettings?.ai.provider ?? "none"} disabled={!platformSettings || !!busy} onChange={(event) => patchPlatformSettings({ ai: { ...(platformSettings?.ai ?? { model: "" }), provider: event.target.value as PluginPlatformSettings["ai"]["provider"] } }, t("settings.toast.aiProviderSaved"))}>
                  <option value="none">{t("settings.plugins.aiProvider.disabled")}</option>
                  <option value="anthropic">{t("settings.plugins.aiProvider.anthropic")}</option>
                  <option value="openai">{t("settings.plugins.aiProvider.openai")}</option>
                  <option value="ollama">{t("settings.plugins.aiProvider.ollama")}</option>
                  <option value="minimax">{t("settings.plugins.aiProvider.minimax")}</option>
                </select>
              </div>
              <div className="settings-row">
                <div className="settings-row-info">
                  <strong>{t("settings.plugins.model.title")}</strong>
                  <small>{t("settings.plugins.model.description")}</small>
                </div>
                <input type="text" className="settings-select" placeholder={t("settings.plugins.model.placeholder")} defaultValue={platformSettings?.ai.model ?? ""} disabled={!platformSettings || !!busy} onBlur={(event) => { if (event.target.value !== (platformSettings?.ai.model ?? "")) patchPlatformSettings({ ai: { ...(platformSettings?.ai ?? { provider: "none" }), model: event.target.value } as PluginPlatformSettings["ai"] }, t("settings.toast.aiModelSaved")); }} />
              </div>
              <div className="settings-row">
                <div className="settings-row-info">
                  <strong>{t("settings.plugins.apiKey.title")}</strong>
                  <small>{aiKeyStatus.hasKey ? t("settings.plugins.apiKey.stored") : t("settings.plugins.apiKey.none")}</small>
                </div>
                <div className="flex gap-2 items-center">
                  <input type="password" className="settings-select" placeholder={aiKeyStatus.hasKey ? t("settings.plugins.apiKey.placeholderStored") : t("settings.plugins.apiKey.placeholderEmpty")} value={aiKeyDraft} disabled={!!busy} onChange={(event) => setAiKeyDraft(event.target.value)} />
                  <Button variant="secondary" size="compact" disabled={!!busy || !aiKeyDraft} onClick={() => void run(t("settings.busy.saving"), async () => { setAiKeyStatus(await api.setPluginAiApiKey(aiKeyDraft)); setAiKeyDraft(""); setMessage(t("settings.toast.aiKeySaved")); })}>{t("settings.plugins.apiKey.save")}</Button>
                  {aiKeyStatus.hasKey && <Button variant="secondary" size="compact" disabled={!!busy} onClick={() => void run(t("settings.busy.saving"), async () => { setAiKeyStatus(await api.setPluginAiApiKey(null)); setMessage(t("settings.toast.aiKeyRemoved")); })}>{t("settings.plugins.apiKey.remove")}</Button>}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  </div>;
}


function LanSettingsPanel({ status, onRefresh, busy }: { status: LanStatusSnapshot | null; onRefresh: () => void; busy: boolean }) {
  const { t } = useI18n();
  const clients = status?.clients ?? [];
  const authLabel = getLanAuthLabel(status, t);
  const topologyIssues = status?.topologyIssues ?? [];
  return (
    <div className="settings-section">
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow">{t("settings.lan.eyebrow")}</p>
          <h2 className="settings-section-title">{t("settings.lan.title")}</h2>
        </div>
        <Button variant="secondary" size="compact" disabled={busy} onClick={onRefresh}>
          <RefreshIcon />
          {t("settings.lan.refresh")}
        </Button>
      </div>
      <p className="text-sm text-slatecopy -mt-2 mb-2">{t("settings.lan.description")}</p>

      <div className="settings-group">
        <div className="lan-status-grid">
          <LanStatusMetric label={t("settings.lan.mode")} value={status?.mode ?? "off"} />
          <LanStatusMetric label={t("settings.lan.host")} value={status?.localHost ?? "-"} />
          <LanStatusMetric label={t("settings.lan.server")} value={status?.serverUrl ?? "-"} />
          <LanStatusMetric label={t("settings.lan.auth")} value={authLabel} tone={status?.auth === "token" ? "ok" : "warn"} />
          <LanStatusMetric label={t("settings.lan.tokenHint")} value={status?.tokenHint ? t("settings.lan.tokenHintValue", { hint: status.tokenHint }) : t("settings.lan.none")} />
          <LanStatusMetric label={t("settings.lan.currentOwner")} value={status?.currentHost ?? t("settings.lan.none")} />
          <LanStatusMetric label={t("settings.lan.persistedOwner")} value={status?.persistedCurrentHost ?? t("settings.lan.none")} />
          <LanStatusMetric label={t("settings.lan.clients")} value={String(clients.length)} />
          <LanStatusMetric label={t("settings.lan.topology")} value={status?.topologyHosts ? t("settings.lan.topologyConfigured", { hosts: status.topologyHosts, links: status.topologyLinks }) : t("settings.lan.topologyFallback")} />
          <LanStatusMetric label={t("settings.lan.topologyWarnings")} value={String(topologyIssues.length)} tone={topologyIssues.length ? "warn" : "ok"} />
        </div>
      </div>

      {topologyIssues.length ? (
        <div className="settings-group">
          <div className="settings-row">
            <div className="settings-row-info">
              <strong>{t("settings.lan.topologyWarnings")}</strong>
              <small>{t("settings.lan.topologyWarningsDescription")}</small>
            </div>
          </div>
          {topologyIssues.map((issue) => (
            <div className="settings-row" key={`${issue.host}-${issue.edge}-${issue.neighbor}-${issue.code}`}>
              <div className="settings-row-info">
                <strong>{issue.host} {issue.edge} {issue.neighbor}</strong>
                <small>{getLanTopologyIssueLabel(issue, t)}</small>
              </div>
              <span className="pill pill-orange">{t("settings.lan.warning")}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="settings-group">
        <div className="settings-row">
          <div className="settings-row-info">
            <strong>{t("settings.lan.connectedHosts")}</strong>
            <small>{t("settings.lan.connectedHostsDescription")}</small>
          </div>
        </div>
        {clients.length ? clients.map((client) => (
          <div className="settings-row" key={client.host}>
            <div className="settings-row-info">
              <strong>{client.host}</strong>
              <small>{client.position ? [client.position.x, client.position.y].join(", ") : t("settings.lan.noPosition")}</small>
            </div>
            <span className={client.host === status?.currentHost ? "pill pill-green" : "pill pill-slate"}>{client.host === status?.currentHost ? t("settings.lan.owner") : t("settings.lan.connected")}</span>
          </div>
        )) : (
          <div className="settings-row">
            <div className="settings-row-info">
              <strong>{t("settings.lan.noClients")}</strong>
              <small>{t("settings.lan.noClientsDescription")}</small>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function getLanAuthLabel(status: LanStatusSnapshot | null, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (!status) return t("settings.lan.authNone");
  if (status.authInsecure) return t("settings.lan.authInsecure");
  if (status.authSource === "env") return t("settings.lan.authEnv");
  if (status.authSource === "stored") return t("settings.lan.authStored");
  if (status.authSource === "generated") return t("settings.lan.authGenerated");
  return t("settings.lan.authNone");
}

function formatRemoteDate(timestampMs: number, locale: string): string {
  try {
    return new Date(timestampMs).toLocaleString(locale, {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return new Date(timestampMs).toLocaleString();
  }
}

function AccessibleDialog({
  isOpen,
  onClose,
  titleId,
  descriptionId,
  ariaLabel,
  closeOnBackdropClick = true,
  preventEscapeClose = false,
  isBusy = false,
  children,
  className = "max-w-md",
  role = "dialog",
}: {
  isOpen: boolean;
  onClose?: () => void;
  titleId?: string;
  descriptionId?: string;
  ariaLabel?: string;
  closeOnBackdropClick?: boolean;
  preventEscapeClose?: boolean;
  isBusy?: boolean;
  children: React.ReactNode;
  className?: string;
  role?: "dialog" | "alertdialog";
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    previouslyFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

    requestAnimationFrame(() => {
      const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(focusableSelector);
      if (firstFocusable) {
        firstFocusable.focus();
      } else if (dialogRef.current) {
        dialogRef.current.focus();
      }
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!preventEscapeClose && !isBusy && onClose) {
          event.preventDefault();
          onClose();
        }
        return;
      }

      if (event.key !== "Tab") return;
      const dialogNode = dialogRef.current;
      if (!dialogNode) return;

      const focusable = Array.from(dialogNode.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocusedElementRef.current?.focus();
    };
  }, [isOpen, preventEscapeClose, isBusy, onClose]);

  if (!isOpen) return null;

  return (
    <div className="plugin-config-overlay">
      <div
        className="plugin-config-backdrop"
        onClick={() => {
          if (closeOnBackdropClick && !isBusy && onClose) {
            onClose();
          }
        }}
      />
      <div
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`plugin-inspector bg-white p-6 rounded-[24px] border border-blue-200 shadow-2xl relative z-10 flex flex-col gap-4 focus:outline-none ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

type RemoteTokenHandoffState = {
  result: RemotePairingResult;
  endpoint: string | null;
} | null;

function RemoteTokenHandoffModal({
  handoff,
  onDismiss,
}: {
  handoff: RemoteTokenHandoffState;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedPosix, setCopiedPosix] = useState(false);
  const [copiedPowerShell, setCopiedPowerShell] = useState(false);
  const [copiedCliCheck, setCopiedCliCheck] = useState(false);

  const result = handoff?.result;
  const endpoint = handoff?.endpoint;

  const posixSnippet = endpoint && result ? `export OPENPETS_REMOTE_ENDPOINT="${endpoint}"
export OPENPETS_REMOTE_CLIENT_ID="${result.clientId}"
export OPENPETS_REMOTE_TOKEN="${result.token}"` : "";

  const powerShellSnippet = endpoint && result ? `$env:OPENPETS_REMOTE_ENDPOINT="${endpoint}"
$env:OPENPETS_REMOTE_CLIENT_ID="${result.clientId}"
$env:OPENPETS_REMOTE_TOKEN="${result.token}"` : "";

  const cliCheckSnippet = "npx -y @open-pets/cli@latest status";

  async function handleCopyToken() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.token);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
    } catch {}
  }

  async function handleCopyPosix() {
    if (!posixSnippet) return;
    try {
      await navigator.clipboard.writeText(posixSnippet);
      setCopiedPosix(true);
      setTimeout(() => setCopiedPosix(false), 2000);
    } catch {}
  }

  async function handleCopyPowerShell() {
    if (!powerShellSnippet) return;
    try {
      await navigator.clipboard.writeText(powerShellSnippet);
      setCopiedPowerShell(true);
      setTimeout(() => setCopiedPowerShell(false), 2000);
    } catch {}
  }

  async function handleCopyCliCheck() {
    try {
      await navigator.clipboard.writeText(cliCheckSnippet);
      setCopiedCliCheck(true);
      setTimeout(() => setCopiedCliCheck(false), 2000);
    } catch {}
  }

  function handleDone() {
    setCopiedToken(false);
    setCopiedPosix(false);
    setCopiedPowerShell(false);
    setCopiedCliCheck(false);
    onDismiss();
  }

  return (
    <AccessibleDialog
      isOpen={Boolean(handoff)}
      onClose={handleDone}
      titleId="remote-token-title"
      descriptionId="remote-token-warning"
      closeOnBackdropClick={false}
      preventEscapeClose={true}
      className="max-w-lg"
    >
      {result && (
        <>
          <div className="flex items-center gap-2 text-emerald-600">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="m9 12 2 2 4-4" />
            </svg>
            <h3 id="remote-token-title" className="m-0 font-monoDisplay text-xl font-black text-navy">{t("settings.remote.tokenModal.title")}</h3>
          </div>
          <p id="remote-token-warning" className="text-xs font-semibold text-amber-800 bg-amber-50 p-3 rounded-xl border border-amber-200 m-0">
            {t("settings.remote.tokenModal.warning")}
          </p>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-bold text-slatecopy uppercase tracking-wider">{t("settings.remote.tokenModal.clientIdLabel")}</span>
              <code className="bg-slate-100 p-2 rounded-xl text-xs font-mono text-navy select-all break-all border border-slate-200">
                {result.clientId}
              </code>
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-slatecopy uppercase tracking-wider">{t("settings.remote.tokenModal.tokenLabel")}</span>
                <Button variant="secondary" size="compact" onClick={() => void handleCopyToken()}>
                  {copiedToken ? t("settings.remote.tokenModal.copied") : t("settings.remote.tokenModal.copyToken")}
                </Button>
              </div>
              <code className="bg-blue-50/70 p-3 rounded-xl text-xs font-mono text-brand select-all break-all border border-blue-200/80 font-bold">
                {result.token}
              </code>
            </div>

            <div className="flex flex-col gap-2 p-3 rounded-xl bg-slate-50 border border-slate-200">
              <span className="text-[10px] font-bold text-slatecopy uppercase tracking-wider">{t("settings.remote.tokenModal.guidanceTitle")}</span>
              {endpoint ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-slatecopy uppercase">{t("settings.remote.tokenModal.posixLabel")}</span>
                      <Button variant="secondary" size="compact" onClick={() => void handleCopyPosix()}>
                        {copiedPosix ? t("settings.remote.tokenModal.copied") : t("settings.remote.tokenModal.copyToken")}
                      </Button>
                    </div>
                    <pre className="m-0 p-2 bg-white rounded border border-slate-200 text-[11px] font-mono text-navy overflow-x-auto leading-relaxed select-all">
{posixSnippet}
                    </pre>
                  </div>

                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-slatecopy uppercase">{t("settings.remote.tokenModal.powerShellLabel")}</span>
                      <Button variant="secondary" size="compact" onClick={() => void handleCopyPowerShell()}>
                        {copiedPowerShell ? t("settings.remote.tokenModal.copied") : t("settings.remote.tokenModal.copyToken")}
                      </Button>
                    </div>
                    <pre className="m-0 p-2 bg-white rounded border border-slate-200 text-[11px] font-mono text-navy overflow-x-auto leading-relaxed select-all">
{powerShellSnippet}
                    </pre>
                  </div>

                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-slatecopy uppercase">{t("settings.remote.tokenModal.cliCheckLabel")}</span>
                      <Button variant="secondary" size="compact" onClick={() => void handleCopyCliCheck()}>
                        {copiedCliCheck ? t("settings.remote.tokenModal.copied") : t("settings.remote.tokenModal.copyToken")}
                      </Button>
                    </div>
                    <pre className="m-0 p-2 bg-white rounded border border-slate-200 text-[11px] font-mono text-navy overflow-x-auto leading-relaxed select-all">
{cliCheckSnippet}
                    </pre>
                    <small className="text-[11px] text-slatecopy mt-0.5">{t("settings.remote.tokenModal.cliCheckExplanation")}</small>
                  </div>
                </div>
              ) : (
                <p className="m-0 text-xs text-amber-800 bg-amber-50 p-2 rounded border border-amber-200 font-semibold">
                  {t("settings.remote.tokenModal.noEndpointGuidance")}
                </p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-2">
            <Button variant="primary" size="compact" onClick={handleDone}>
              {t("settings.remote.tokenModal.done")}
            </Button>
          </div>
        </>
      )}
    </AccessibleDialog>
  );
}

function RemoteControlSettingsPanel({
  busy,
  onSetMessage,
  onSetError,
  onTokenHandoff,
}: {
  busy: boolean;
  onSetMessage: (msg: string) => void;
  onSetError: (err: string) => void;
  onTokenHandoff: (result: RemotePairingResult, endpoint: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const [snapshot, setSnapshot] = useState<RemoteControlSnapshot | null>(null);
  const [addressDraft, setAddressDraft] = useState("");
  const [portDraft, setPortDraft] = useState("");
  const [showWarningModal, setShowWarningModal] = useState(false);
  const [warningAck, setWarningAck] = useState(false);
  const [showPairModal, setShowPairModal] = useState(false);
  const [pairNameDraft, setPairNameDraft] = useState("");
  const [pairSayScope, setPairSayScope] = useState(false);
  const [confirmRotateClient, setConfirmRotateClient] = useState<RemoteControlClientSummary | null>(null);
  const [confirmRevokeClient, setConfirmRevokeClient] = useState<RemoteControlClientSummary | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const isBusy = busy || actionBusy;

  async function loadSnapshot() {
    try {
      const snap = await api.getRemoteSnapshot();
      setSnapshot(snap);
      setAddressDraft(snap.config.address || "");
      setPortDraft(snap.config.port ? String(snap.config.port) : "");
    } catch (err) {
      onSetError(String((err as Error)?.message ?? err));
    }
  }

  useEffect(() => {
    void loadSnapshot();
  }, []);

  const isEnabled = snapshot?.config.enabled ?? false;
  const isListening = snapshot?.config.listening === true;
  const clients = snapshot?.clients ?? [];

  // Pairing readiness and setup guidance MUST require config.listening === true
  const activeEndpoint = isListening && snapshot?.config.address && snapshot?.config.port
    ? `tcp://${snapshot.config.address}:${snapshot.config.port}`
    : null;

  async function handleToggleEnable(nextEnabled: boolean) {
    if (nextEnabled) {
      setWarningAck(false);
      setShowWarningModal(true);
    } else {
      try {
        setActionBusy(true);
        onSetError("");
        const nextSnap = await api.configureRemote({ enabled: false });
        setSnapshot(nextSnap);
        onSetMessage(t("settings.toast.remoteConfigSaved"));
      } catch {
        onSetError(t("settings.remote.error.configInvalid"));
      } finally {
        setActionBusy(false);
      }
    }
  }

  async function confirmEnableRemote() {
    if (!warningAck) return;
    setShowWarningModal(false);
    try {
      setActionBusy(true);
      onSetError("");
      const portNum = Number(portDraft);
      const nextSnap = await api.configureRemote({
        enabled: true,
        address: addressDraft.trim(),
        port: portNum,
      });
      setSnapshot(nextSnap);
      onSetMessage(t("settings.toast.remoteConfigSaved"));
    } catch {
      onSetError(t("settings.remote.error.configInvalid"));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleSaveConfig() {
    try {
      setActionBusy(true);
      onSetError("");
      const portNum = Number(portDraft);
      const nextSnap = await api.configureRemote({
        enabled: true,
        address: addressDraft.trim(),
        port: portNum,
      });
      setSnapshot(nextSnap);
      onSetMessage(t("settings.toast.remoteConfigSaved"));
    } catch {
      onSetError(t("settings.remote.error.configInvalid"));
    } finally {
      setActionBusy(false);
    }
  }

  async function handlePairSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pairNameDraft.trim()) return;
    try {
      setActionBusy(true);
      onSetError("");
      const scopes: RemoteControlScope[] = pairSayScope
        ? ["status", "react", "say"]
        : ["status", "react"];
      const result = await api.pairRemoteClient({
        name: pairNameDraft.trim(),
        scopes,
      });
      setShowPairModal(false);
      setPairNameDraft("");
      setPairSayScope(false);
      onTokenHandoff(result, activeEndpoint);
      await loadSnapshot();
      onSetMessage(t("settings.toast.remoteClientPaired"));
    } catch {
      onSetError(t("settings.remote.error.pairFailed"));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleConfirmRotate() {
    if (!confirmRotateClient) return;
    const clientId = confirmRotateClient.id;
    setConfirmRotateClient(null);
    try {
      setActionBusy(true);
      onSetError("");
      const result = await api.rotateRemoteClient(clientId);
      onTokenHandoff(result, activeEndpoint);
      await loadSnapshot();
      onSetMessage(t("settings.toast.remoteClientRotated"));
    } catch {
      onSetError(t("settings.remote.error.rotateFailed"));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleConfirmRevoke() {
    if (!confirmRevokeClient) return;
    const clientId = confirmRevokeClient.id;
    setConfirmRevokeClient(null);
    try {
      setActionBusy(true);
      onSetError("");
      await api.revokeRemoteClient(clientId);
      await loadSnapshot();
      onSetMessage(t("settings.toast.remoteClientRevoked"));
    } catch {
      onSetError(t("settings.remote.error.revokeFailed"));
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className="settings-section">
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow">{t("settings.remote.eyebrow")}</p>
          <h2 className="settings-section-title">{t("settings.remote.title")}</h2>
        </div>
        <Button variant="secondary" size="compact" disabled={isBusy} onClick={() => void loadSnapshot()}>
          <RefreshIcon />
          {t("settings.lan.refresh")}
        </Button>
      </div>
      <p className="text-sm text-slatecopy -mt-2 mb-2">{t("settings.remote.description")}</p>

      {/* Scope & Safety Boundary Notice */}
      <div className="p-4 rounded-2xl bg-blue-50/60 border border-blue-100/70 flex flex-col gap-1.5">
        <span className="text-[10px] font-bold text-brand uppercase tracking-wider">{t("settings.remote.notice.eyebrow")}</span>
        <p className="text-xs text-slatecopy leading-relaxed m-0">{t("settings.remote.notice.body")}</p>
      </div>

      {/* Listener Status & Configuration Group */}
      <div className="settings-group">
        <div className="settings-row">
          <div className="settings-row-info">
            <label htmlFor="remote-enable-toggle" className="font-bold text-navy text-sm cursor-pointer">
              {t("settings.remote.status.label")}
            </label>
            <small>{t("settings.remote.enable.description")}</small>
          </div>
          <div className="flex items-center gap-3">
            {isListening ? (
              <StatusPill tone="green">{t("settings.remote.status.listening", { address: snapshot?.config.address ?? "127.0.0.1", port: snapshot?.config.port ?? 18420 })}</StatusPill>
            ) : isEnabled ? (
              <StatusPill tone="red">{t("settings.remote.status.error")}</StatusPill>
            ) : (
              <StatusPill tone="slate">{t("settings.remote.status.disabled")}</StatusPill>
            )}
            <input
              id="remote-enable-toggle"
              type="checkbox"
              className="settings-toggle"
              checked={isEnabled}
              disabled={isBusy}
              onChange={(e) => void handleToggleEnable(e.target.checked)}
            />
          </div>
        </div>

        {/* Concrete IPv4 Bind Address Input */}
        <div className="settings-row">
          <div className="settings-row-info">
            <label htmlFor="remote-bind-address" className="font-bold text-navy text-sm cursor-pointer">
              {t("settings.remote.bindAddress.label")}
            </label>
            <small id="remote-bind-address-desc">{t("settings.remote.bindAddress.description")}</small>
          </div>
          <input
            id="remote-bind-address"
            type="text"
            aria-describedby="remote-bind-address-desc"
            className="settings-select w-56 font-mono text-xs"
            placeholder={t("settings.remote.bindAddress.placeholder")}
            value={addressDraft}
            disabled={isBusy}
            onChange={(e) => setAddressDraft(e.target.value)}
          />
        </div>

        {/* Port Input */}
        <div className="settings-row">
          <div className="settings-row-info">
            <label htmlFor="remote-port" className="font-bold text-navy text-sm cursor-pointer">
              {t("settings.remote.port.label")}
            </label>
            <small id="remote-port-desc">{t("settings.remote.port.description")}</small>
          </div>
          <div className="flex items-center gap-3">
            <input
              id="remote-port"
              type="number"
              aria-describedby="remote-port-desc"
              className="settings-select w-32 font-mono text-xs"
              placeholder={t("settings.remote.port.placeholder")}
              value={portDraft}
              disabled={isBusy}
              onChange={(e) => setPortDraft(e.target.value)}
            />
            <Button
              variant="secondary"
              size="compact"
              disabled={isBusy || !isEnabled || !addressDraft || !portDraft}
              onClick={() => void handleSaveConfig()}
            >
              {t("settings.remote.saveConfig")}
            </Button>
          </div>
        </div>
      </div>

      {/* Paired Clients Section */}
      <div className="settings-section mt-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="settings-section-title text-xl">{t("settings.remote.clients.title")}</h2>
            <p className="text-xs text-slatecopy mt-0.5">{t("settings.remote.clients.description")}</p>
          </div>
          <Button
            variant="primary"
            size="compact"
            disabled={isBusy || !activeEndpoint}
            onClick={() => {
              setPairNameDraft("");
              setPairSayScope(false);
              setShowPairModal(true);
            }}
          >
            {t("settings.remote.clients.pairNew")}
          </Button>
        </div>

        <div className="settings-group">
          {clients.length === 0 ? (
            <div className="p-6 text-center text-xs text-slatecopy">
              {t("settings.remote.clients.none")}
            </div>
          ) : (
            <div className="divide-y divide-blue-50">
              {clients.map((client) => {
                const isRevoked = client.revoked;
                const formattedLastActive = client.lastActivityAt
                  ? formatRemoteDate(client.lastActivityAt, locale)
                  : t("settings.remote.clients.neverActive");
                return (
                  <div key={client.id} className="flex items-center justify-between gap-4 p-4 hover:bg-white/80 transition-colors">
                    <div className="flex flex-col gap-1 min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <strong className="text-sm font-bold text-navy">{client.name}</strong>
                        <StatusPill tone={isRevoked ? "red" : "green"}>
                          {isRevoked ? t("settings.remote.clients.revoked") : t("settings.remote.clients.active")}
                        </StatusPill>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slatecopy">
                        <span>{t("settings.remote.clients.idLabel", { id: `${client.id.slice(0, 8)}…` })}</span>
                        <span>•</span>
                        <span>{t("settings.remote.clients.lastActive", { time: formattedLastActive })}</span>
                      </div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {client.scopes.map((scope) => (
                          <StatusPill key={scope} tone={scope === "say" ? "orange" : "blue"}>
                            {scope}
                          </StatusPill>
                        ))}
                      </div>
                    </div>

                    {!isRevoked && (
                      <div className="flex items-center gap-2 shrink-0">
                        <Button
                          variant="secondary"
                          size="compact"
                          disabled={isBusy}
                          onClick={() => setConfirmRotateClient(client)}
                        >
                          {t("settings.remote.clients.rotate")}
                        </Button>
                        <Button
                          variant="danger"
                          size="compact"
                          disabled={isBusy}
                          onClick={() => setConfirmRevokeClient(client)}
                        >
                          {t("settings.remote.clients.revoke")}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Warning Modal before Enable */}
      <AccessibleDialog
        isOpen={showWarningModal}
        onClose={() => setShowWarningModal(false)}
        titleId="remote-warning-title"
        descriptionId="remote-warning-body"
        role="alertdialog"
        isBusy={isBusy}
        className="max-w-lg"
      >
        <div className="flex items-center gap-3 text-amber-600">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <h3 id="remote-warning-title" className="m-0 font-monoDisplay text-xl font-black text-navy">{t("settings.remote.warning.title")}</h3>
        </div>
        <p id="remote-warning-body" className="text-sm text-slatecopy leading-relaxed m-0">
          {t("settings.remote.warning.body")}
        </p>
        <label htmlFor="remote-warning-ack" className="flex items-start gap-3 p-3 rounded-xl bg-amber-50 border border-amber-200/70 text-xs font-semibold text-amber-900 cursor-pointer">
          <input
            id="remote-warning-ack"
            type="checkbox"
            className="mt-0.5 accent-amber-600 shrink-0"
            checked={warningAck}
            onChange={(e) => setWarningAck(e.target.checked)}
          />
          <span>{t("settings.remote.warning.ack")}</span>
        </label>
        <div className="flex justify-end gap-3 mt-2">
          <Button variant="secondary" size="compact" onClick={() => setShowWarningModal(false)}>
            {t("settings.remote.warning.cancel")}
          </Button>
          <Button variant="primary" size="compact" disabled={!warningAck || isBusy} onClick={() => void confirmEnableRemote()}>
            {t("settings.remote.warning.confirm")}
          </Button>
        </div>
      </AccessibleDialog>

      {/* Pair New Client Modal */}
      <AccessibleDialog
        isOpen={showPairModal}
        onClose={() => setShowPairModal(false)}
        titleId="remote-pair-title"
        isBusy={isBusy}
        className="max-w-md"
      >
        <form onSubmit={(e) => void handlePairSubmit(e)} className="flex flex-col gap-4">
          <h3 id="remote-pair-title" className="m-0 font-monoDisplay text-xl font-black text-navy">{t("settings.remote.pairModal.title")}</h3>
          <div className="flex flex-col gap-1">
            <label htmlFor="remote-pair-name" className="text-xs font-bold text-navy">{t("settings.remote.pairModal.nameLabel")}</label>
            <input
              id="remote-pair-name"
              type="text"
              className="settings-select w-full"
              placeholder={t("settings.remote.pairModal.namePlaceholder")}
              value={pairNameDraft}
              onChange={(e) => setPairNameDraft(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-xs font-bold text-navy">{t("settings.remote.pairModal.scopesLabel")}</label>
            <label className="flex items-center gap-2 text-xs text-slatecopy cursor-not-allowed opacity-80">
              <input type="checkbox" checked disabled readOnly className="accent-brand" />
              <span>{t("settings.remote.pairModal.scopeStatus")}</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-slatecopy cursor-not-allowed opacity-80">
              <input type="checkbox" checked disabled readOnly className="accent-brand" />
              <span>{t("settings.remote.pairModal.scopeReact")}</span>
            </label>
            <label htmlFor="remote-scope-say" className="flex items-center gap-2 text-xs text-navy font-semibold cursor-pointer">
              <input
                id="remote-scope-say"
                type="checkbox"
                checked={pairSayScope}
                onChange={(e) => setPairSayScope(e.target.checked)}
                className="accent-brand"
              />
              <span>{t("settings.remote.pairModal.scopeSay")}</span>
            </label>
          </div>
          <div className="flex justify-end gap-3 mt-2">
            <Button variant="secondary" size="compact" type="button" onClick={() => setShowPairModal(false)}>
              {t("settings.remote.warning.cancel")}
            </Button>
            <Button variant="primary" size="compact" type="submit" disabled={!pairNameDraft.trim() || isBusy}>
              {t("settings.remote.pairModal.submit")}
            </Button>
          </div>
        </form>
      </AccessibleDialog>

      {/* Confirmation Modal for Token Rotation */}
      <AccessibleDialog
        isOpen={Boolean(confirmRotateClient)}
        onClose={() => setConfirmRotateClient(null)}
        titleId="remote-rotate-title"
        descriptionId="remote-rotate-body"
        role="alertdialog"
        isBusy={isBusy}
        className="max-w-md"
      >
        <h3 id="remote-rotate-title" className="m-0 font-monoDisplay text-xl font-black text-navy">{t("settings.remote.clients.confirmRotateTitle")}</h3>
        <p id="remote-rotate-body" className="text-sm text-slatecopy leading-relaxed m-0">
          {confirmRotateClient && t("settings.remote.clients.confirmRotateBody").replace("{name}", confirmRotateClient.name)}
        </p>
        <div className="flex justify-end gap-3 mt-2">
          <Button variant="secondary" size="compact" onClick={() => setConfirmRotateClient(null)}>
            {t("settings.remote.warning.cancel")}
          </Button>
          <Button variant="primary" size="compact" disabled={isBusy} onClick={() => void handleConfirmRotate()}>
            {t("settings.remote.clients.rotate")}
          </Button>
        </div>
      </AccessibleDialog>

      {/* Confirmation Modal for Client Revocation */}
      <AccessibleDialog
        isOpen={Boolean(confirmRevokeClient)}
        onClose={() => setConfirmRevokeClient(null)}
        titleId="remote-revoke-title"
        descriptionId="remote-revoke-body"
        role="alertdialog"
        isBusy={isBusy}
        className="max-w-md"
      >
        <h3 id="remote-revoke-title" className="m-0 font-monoDisplay text-xl font-black text-navy">{t("settings.remote.clients.confirmRevokeTitle")}</h3>
        <p id="remote-revoke-body" className="text-sm text-slatecopy leading-relaxed m-0">
          {confirmRevokeClient && t("settings.remote.clients.confirmRevokeBody").replace("{name}", confirmRevokeClient.name)}
        </p>
        <div className="flex justify-end gap-3 mt-2">
          <Button variant="secondary" size="compact" onClick={() => setConfirmRevokeClient(null)}>
            {t("settings.remote.warning.cancel")}
          </Button>
          <Button variant="danger" size="compact" disabled={isBusy} onClick={() => void handleConfirmRevoke()}>
            {t("settings.remote.clients.revoke")}
          </Button>
        </div>
      </AccessibleDialog>
    </div>
  );
}

function getLanTopologyIssueLabel(issue: LanTopologyIssue, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (issue.code === "self_reference") return t("settings.lan.topologySelfReference");
  return t("settings.lan.topologyMissingReverse", { reverse: oppositeLanEdge(issue.edge), neighbor: issue.neighbor, host: issue.host });
}

function oppositeLanEdge(edge: LanTopologyIssue["edge"]): LanTopologyIssue["edge"] {
  if (edge === "left") return "right";
  if (edge === "right") return "left";
  if (edge === "up") return "down";
  return "up";
}

function LanStatusMetric({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  const pillClass = tone === "ok" ? "pill pill-green" : tone === "warn" ? "pill pill-orange" : "pill pill-blue";
  return (
    <div className="lan-status-metric">
      <span>{label}</span>
      <strong className={pillClass}>{value}</strong>
    </div>
  );
}
const pluginFilterLabelKeys: Record<PluginFilter, string> = {
  all: "plugins.filter.all",
  installed: "plugins.filter.installed",
  catalog: "plugins.filter.catalog",
  local: "plugins.filter.local",
  broken: "plugins.filter.broken",
};

const pluginPermissionLabelKeys: Record<PluginPermission, string> = {
  "pet:speak": "plugins.permission.pet:speak",
  "pet:reaction": "plugins.permission.pet:reaction",
  "pet:move": "plugins.permission.pet:move",
  timer: "plugins.permission.timer",
  schedule: "plugins.permission.schedule",
  storage: "plugins.permission.storage",
  status: "plugins.permission.status",
  commands: "plugins.permission.commands",
  network: "plugins.permission.network",
  "pet:interact": "plugins.permission.pet:interact",
  "pet:pin": "plugins.permission.pet:pin",
  "pet:animate": "plugins.permission.pet:animate",
  "pet:speak:dynamic": "plugins.permission.pet:speak:dynamic",
  "pet:drop": "plugins.permission.pet:drop",
  "pets:read": "plugins.permission.pets:read",
  "pets:manage": "plugins.permission.pets:manage",
  audio: "plugins.permission.audio",
  events: "plugins.permission.events",
  "ui:toast": "plugins.permission.ui:toast",
  "ui:panel": "plugins.permission.ui:panel",
  "ui:delivery": "plugins.permission.ui:delivery",
  notify: "plugins.permission.notify",
  bus: "plugins.permission.bus",
  ai: "plugins.permission.ai",
  secrets: "plugins.permission.secrets",
  "voice:speak": "plugins.permission.voice:speak",
  "voice:listen": "plugins.permission.voice:listen",
  auth: "plugins.permission.auth",
  files: "plugins.permission.files",
  "system:openExternal": "plugins.permission.system:openExternal",
  "system:metrics": "plugins.permission.system:metrics",
  clipboard: "plugins.permission.clipboard",
  "network:write": "plugins.permission.network:write",
  "network:local": "plugins.permission.network:local",
};
const sensitivePermissionSet = new Set<PluginPermission>(["voice:listen", "clipboard", "pet:speak:dynamic", "network:local"]);

const pluginStatusTone: Record<NonNullable<PluginStatus["tone"]>, keyof typeof statusPillToneClass> = {
  info: "blue",
  success: "green",
  warning: "orange",
  error: "red",
};

function PluginGlyph({ className = "plugin-glyph" }: { className?: string }) {
  return <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2 3 6.5l9 4.5 9-4.5z" />
    <path d="m3 12 9 4.5 9-4.5" />
    <path d="m3 17.5 9 4.5 9-4.5" />
  </svg>;
}

function PluginIcon({ icon = "plugin", className = "plugin-glyph" }: { icon?: PluginIconName; className?: string }) {
  if (icon === "bell") return <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3H4a4 4 0 0 0 2-3v-3a7 7 0 0 1 4-6M9 17v1a3 3 0 0 0 6 0v-1" />
  </svg>;
  if (icon === "timer") return <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0" />
    <path d="M12 7v5l3 3" />
  </svg>;
  if (icon === "github") return <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 19c-4.3 1.4-4.3-2.5-6-3" />
    <path d="M15 21v-3.5c0-1 .1-1.4-.5-2c2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2a4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6c-.6.6-.6 1.2-.5 2V21" />
  </svg>;
  if (icon === "heart") return <HeartIcon />;
  if (icon === "sparkles") return <StarIcon />;
  if (icon === "coffee") return <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 2v2" /><path d="M14 2v2" /><path d="M16 8h1a4 4 0 0 1 0 8h-1" /><path d="M6 8h10v7a5 5 0 0 1-5 5h0a5 5 0 0 1-5-5Z" /><path d="M4 22h14" />
  </svg>;
  if (icon === "focus") return <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
  </svg>;
  if (icon === "droplet") return <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 2.5S5 10 5 15a7 7 0 0 0 14 0c0-5-7-12.5-7-12.5Z" />
    <path d="M8.5 15.5a3.5 3.5 0 0 0 5.5 2.9" />
  </svg>;
  return <PluginGlyph className={className} />;
}

function isPluginIconDataUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^data:image\/svg\+xml;base64,[a-z0-9+/=]+$/iu.test(value);
}

function PluginIconImage({ entry, className = "plugin-glyph" }: { entry: PluginEntry; className?: string }) {
  const iconDataUrl = isPluginIconDataUrl(entry.installed?.iconDataUrl) ? entry.installed.iconDataUrl : isPluginIconDataUrl(entry.catalog?.iconDataUrl) ? entry.catalog.iconDataUrl : undefined;
  if (iconDataUrl) return <img className={`${className} plugin-icon-img`} src={iconDataUrl} alt="" aria-hidden="true" draggable="false" />;
  return <PluginIcon icon={pluginIcon(entry)} className={className} />;
}

function pluginIcon(entry: PluginEntry): PluginIconName {
  return entry.installed?.icon || entry.catalog?.icon || "plugin";
}

function pluginName(entry: PluginEntry): string {
  return entry.installed?.name || entry.catalog?.name || entry.id;
}

function pluginDescription(entry: PluginEntry, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (entry.installed?.brokenReason) return entry.installed.brokenReason;
  return entry.installed?.description || entry.catalog?.description || (entry.installed ? t("plugins.description.installedReady") : t("plugins.description.availableCatalog"));
}

function pluginPrimaryTone(entry: PluginEntry): keyof typeof statusPillToneClass {
  if (entry.installed?.brokenReason) return "red";
  if (entry.installed?.catalogDisabled) return "orange";
  if (entry.installed?.enabled) return "green";
  if (entry.installed) return "slate";
  return "blue";
}

function pluginPrimaryLabel(entry: PluginEntry, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (entry.installed?.brokenReason) return t("plugins.status.broken");
  if (entry.installed?.catalogDisabled) return t("plugins.status.catalogDisabled");
  if (entry.installed?.enabled) return t("plugins.status.active");
  if (entry.installed) return t("plugins.status.disabled");
  return t("plugins.status.available");
}

function mergePluginEntries(snapshot: PluginServiceSnapshot | null, catalog: PluginCatalogSnapshot | null): PluginEntry[] {
  const merged = new Map<string, PluginEntry>();
  for (const installed of snapshot?.plugins ?? []) merged.set(installed.id, { id: installed.id, installed });
  for (const catalogPlugin of catalog?.plugins ?? []) {
    const current = merged.get(catalogPlugin.id) ?? { id: catalogPlugin.id };
    merged.set(catalogPlugin.id, { ...current, catalog: catalogPlugin });
  }
  return [...merged.values()].sort((a, b) => {
    const installedDelta = Number(Boolean(b.installed)) - Number(Boolean(a.installed));
    if (installedDelta) return installedDelta;
    return pluginName(a).localeCompare(pluginName(b));
  });
}

function initialConfigValue(field: PluginConfigField): unknown {
  if (field.default !== undefined) return field.default;
  if (field.type === "boolean") return false;
  if (field.type === "number") return field.min ?? 0;
  if (field.type === "multiSelect" || field.type === "list") return [];
  return "";
}

function commandFieldToConfigField(field: PluginCommandFormField): PluginConfigField {
  return { type: field.type, label: field.label, default: field.default, options: field.options, min: field.min, max: field.max, maxLength: field.maxLength };
}

function materializeCommandDraft(form: PluginCommandForm | undefined, values: Record<string, unknown> | undefined): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const field of form?.fields ?? []) next[field.id] = values?.[field.id] ?? initialConfigValue(commandFieldToConfigField(field));
  return next;
}

function materializeListItemDefaults(schema: PluginConfigSchema, value: Record<string, unknown> = {}): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) next[key] = materializeConfigValue(field, value[key]);
  return next;
}

function materializeConfigValue(field: PluginConfigField, value: unknown): unknown {
  if (field.type === "list" && field.itemSchema) {
    const items = Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item)) : [];
    return items.map((item) => materializeListItemDefaults(field.itemSchema ?? {}, item));
  }
  return value ?? initialConfigValue(field);
}

function materializeConfigDraft(schema: PluginConfigSchema | undefined, config: PluginConfig | undefined): PluginConfig {
  const next: PluginConfig = {};
  for (const [key, field] of Object.entries(schema ?? {})) next[key] = materializeConfigValue(field, config?.[key]);
  return next;
}

export function computeNextRovingIndex(
  key: string,
  currentIndex: number,
  totalCount: number
): { nextIndex: number } {
  if (key === "ArrowRight" || key === "ArrowDown") {
    return { nextIndex: (currentIndex + 1) % totalCount };
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return { nextIndex: (currentIndex - 1 + totalCount) % totalCount };
  }
  if (key === "Home") {
    return { nextIndex: 0 };
  }
  if (key === "End") {
    return { nextIndex: totalCount - 1 };
  }
  return { nextIndex: currentIndex };
}

function ConfigFieldEditor({ pluginId, fieldKey, field, value, onChange, onPickSound, spritePreviews }: { pluginId?: string; fieldKey: string; field: PluginConfigField; value: unknown; onChange: (value: unknown) => void; onPickSound?: (pluginId: string) => Promise<void>; spritePreviews?: SafePluginRecord["spritePreviews"] }) {
  const { t } = useI18n();
  const label = field.label || fieldKey;
  const description = field.description;
  const textValue = typeof value === "string" ? value : typeof field.default === "string" ? field.default : "";

  if (field.type === "boolean") {
    return <label className="plugin-config-row plugin-config-row-boolean">
      <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <input className="settings-toggle" type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
    </label>;
  }

  if (field.type === "list" && field.itemSchema) {
    const items = Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item)) : [];
    const maxed = typeof field.maxItems === "number" && items.length >= field.maxItems;

    const isReminders = (pluginId === "openpets.break-buddy" || fieldKey === "reminders") && ["reminders", "breaks"].includes(fieldKey);
    const addLabel = isReminders ? t("plugins.config.addReminder") : t("plugins.config.addItem");

    return <div className="plugin-config-row">
      <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <div className="plugin-list-editor">
        {items.map((item, index) => {
          let itemTitle = t("plugins.config.item", { index: index + 1 });
          let removeLabel = t("plugins.config.remove");

          if (isReminders) {
            removeLabel = t("plugins.config.removeReminder");
            const id = String(item.id || "").trim();
            const scheduleType = item.scheduleType;
            if (scheduleType === "daily") {
              const time = String(item.time || "09:00");
              itemTitle = t("plugins.config.dailyAt", { id: id || t("plugins.config.reminder"), time });
            } else if (scheduleType === "interval") {
              const mins = Number(item.intervalMinutes) || 60;
              itemTitle = t("plugins.config.everyMin", { id: id || t("plugins.config.reminder"), mins });
            } else if (id) {
              itemTitle = id;
            }
          }

          const schemaEntries = Object.entries(field.itemSchema ?? {});
          const messageField = schemaEntries.find(([k]) => k === "message");
          const scheduleFields = schemaEntries.filter(([k]) => ["scheduleType", "time", "days", "intervalMinutes"].includes(k));
          const behaviorFields = schemaEntries.filter(([k]) => ["id", "enabled", "reaction"].includes(k));
          const otherFields = schemaEntries.filter(([k]) => !["message", "scheduleType", "time", "days", "intervalMinutes", "id", "enabled", "reaction"].includes(k));

          const renderField = ([childKey, childField]: [string, PluginConfigField]) => {
            if (isReminders) {
              const scheduleType = item.scheduleType;
              if (scheduleType === "daily" && childKey === "intervalMinutes") return null;
              if (scheduleType === "interval" && (childKey === "time" || childKey === "days")) return null;
            }
            return <ConfigFieldEditor key={childKey} pluginId={pluginId} fieldKey={childKey} field={childField} value={item[childKey] ?? initialConfigValue(childField)} onChange={(nextValue) => onChange(items.map((existing, itemIndex) => itemIndex === index ? { ...existing, [childKey]: nextValue } : existing))} spritePreviews={spritePreviews} />;
          };

          return (
            <div className="plugin-list-item" key={index}>
              <div className="plugin-list-item-header">
                <span className="truncate mr-2">{itemTitle}</span>
                <Button variant="danger" size="compact" onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}>{removeLabel}</Button>
              </div>
              <div className="flex flex-col gap-3">
                {isReminders ? (
                  <>
                    {behaviorFields.length > 0 && (
                      <div className="plugin-config-group">
                        <div className="plugin-config-group-title">{t("plugins.config.group.identity")}</div>
                        {behaviorFields.map(renderField)}
                      </div>
                    )}
                    {messageField && (
                      <div className="plugin-config-group">
                        <div className="plugin-config-group-title">{t("plugins.config.group.message")}</div>
                        {renderField(messageField)}
                      </div>
                    )}
                    {scheduleFields.length > 0 && (
                      <div className="plugin-config-group">
                        <div className="plugin-config-group-title">{t("plugins.config.group.schedule")}</div>
                        {scheduleFields.map(renderField)}
                      </div>
                    )}
                    {otherFields.map(renderField)}
                  </>
                ) : (
                  schemaEntries.map(renderField)
                )}
              </div>
            </div>
          );
        })}
        <Button variant="secondary" size="compact" disabled={maxed} onClick={() => onChange([...items, materializeListItemDefaults(field.itemSchema ?? {})])}>{addLabel}</Button>
      </div>
    </div>;
  }

  if (field.type === "sound") {
    const soundLabel = typeof value === "string" ? (value || t("plugins.config.defaultSound")) : value && typeof value === "object" && "name" in value && typeof value.name === "string" ? value.name : t("plugins.config.defaultSound");
    return <label className="plugin-config-row">
      <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <span className="flex items-center gap-2">
        <span className="plugin-input flex-1 truncate" aria-live="polite">{soundLabel}</span>
        <Button variant="secondary" size="compact" disabled={!pluginId || !onPickSound} onClick={() => { if (pluginId) void onPickSound?.(pluginId); }}>{t("plugins.config.browseSound")}</Button>
        <Button variant="secondary" size="compact" onClick={() => onChange("alert")}>{t("plugins.config.useDefaultSound")}</Button>
        <Button variant="secondary" size="compact" onClick={() => onChange("")}>{t("plugins.config.clearSound")}</Button>
      </span>
    </label>;
  }

  if (field.type === "select" && field.presentation === "sprite-grid") {
    const options = field.options ?? [];
    const [focusedValue, setFocusedValue] = React.useState<string>(textValue || (options[0]?.value ?? ""));
    const cardRefs = React.useRef<Map<string, HTMLDivElement | null>>(new Map());

    React.useEffect(() => {
      if (textValue) setFocusedValue(textValue);
    }, [textValue]);

    return <div className="plugin-config-row">
      <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <div className="courier-sprite-grid" role="radiogroup" aria-label={label}>
        {options.map((option, index) => {
          const isSelected = textValue === option.value;
          const isFocused = focusedValue === option.value || (!focusedValue && index === 0);

          const spriteInfo = spritePreviews?.[option.previewSprite || ""];
          const spriteUrl = spriteInfo?.url || "";
          const frames = spriteInfo?.frames ?? 1;
          const duration = spriteInfo?.durationMs ?? 0;
          const frameWidth = spriteInfo?.frameWidth || 256;
          const frameHeight = spriteInfo?.frameHeight || 256;
          const scaleVal = 80 / frameWidth;

          const previewStyle: React.CSSProperties = {
            backgroundImage: `url("${spriteUrl}")`,
            width: `${frameWidth}px`,
            height: `${frameHeight}px`,
            backgroundSize: `${frameWidth * frames}px ${frameHeight}px`,
            transform: `scale(${scaleVal})`,
            transformOrigin: "top left",
            position: "absolute",
            top: 0,
            left: 0,
            backgroundRepeat: "repeat-x",
            backgroundPosition: "0 0",
            pointerEvents: "none",
            animationDuration: `${duration}ms`,
            animationTimingFunction: `steps(${frames})`,
          };

          const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
            const idx = options.findIndex((o) => o.value === option.value);
            const { nextIndex } = computeNextRovingIndex(event.key, idx, options.length);

            const isArrowKey = event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowUp";
            const isHomeEnd = event.key === "Home" || event.key === "End";

            if (isArrowKey || isHomeEnd) {
              event.preventDefault();
              const targetValue = options[nextIndex].value;
              onChange(targetValue); // ARIA: arrow navigation both focus and select next option; Home/End also select
              setFocusedValue(targetValue);
              setTimeout(() => {
                const targetEl = cardRefs.current.get(targetValue);
                targetEl?.focus();
              }, 0);
            } else if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              onChange(option.value);
            }
          };

          return (
            <div
              key={option.value}
              ref={(el) => {
                if (el) cardRefs.current.set(option.value, el);
                else cardRefs.current.delete(option.value);
              }}
              role="radio"
              aria-checked={isSelected}
              tabIndex={isFocused ? 0 : -1}
              data-courier-value={option.value}
              onFocus={() => setFocusedValue(option.value)}
              onKeyDown={handleKeyDown}
              onClick={() => onChange(option.value)}
              className={`courier-card ${isSelected ? "selected" : ""}`}
              style={{
                "--courier-total-width": `-${frameWidth * frames}px`
              } as React.CSSProperties}
            >
              <div className="courier-sprite-frame">
                {spriteUrl && (
                  <div
                    className="courier-sprite-preview"
                    style={previewStyle}
                  />
                )}
              </div>
              <div className="courier-card-meta">
                <span className="courier-card-title">{option.label || option.value}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>;
  }

  return <label className="plugin-config-row">
    <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
    {field.type === "textarea" ? (
      <textarea className="plugin-input plugin-textarea" value={textValue} maxLength={field.maxLength} onChange={(event) => onChange(event.target.value)} />
    ) : field.type === "select" ? (
      <select className="settings-select plugin-select" value={textValue} onChange={(event) => onChange(event.target.value)}>
        {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label || option.value}</option>)}
      </select>
    ) : field.type === "multiSelect" ? (
      <span className="plugin-chip-list">
        {(field.options ?? []).map((option) => {
          const selected = Array.isArray(value) && value.includes(option.value);
          return <button type="button" key={option.value} className={`plugin-chip ${selected ? "active" : ""}`} onClick={() => {
            const current = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
            onChange(selected ? current.filter((item) => item !== option.value) : [...current, option.value]);
          }}>{option.label || option.value}</button>;
        })}
      </span>
    ) : (
      <input className="plugin-input" type={field.type === "number" ? "number" : field.type === "time" ? "time" : field.type === "date" ? "date" : field.type === "secret" ? "password" : "text"} autoComplete={field.type === "secret" ? "off" : undefined} value={field.type === "number" && typeof value === "number" ? String(value) : textValue} min={field.min} max={field.max} step={field.step} maxLength={field.maxLength} onChange={(event) => onChange(field.type === "number" ? Number(event.target.value) : event.target.value)} />
    )}
  </label>;
}

function PathField({ label, value, placeholder, onSave, disabled }: { label: string; value: string; placeholder: string; onSave: (v: string) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-bold text-slatecopy uppercase tracking-wider">{label}</label>
      <div className="flex gap-2">
        <input
          className="plugin-input flex-1"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
        />
        <Button variant="secondary" size="compact" icon={<SaveIcon />} disabled={disabled || draft === value} onClick={() => onSave(draft)}>{t("common.save")}</Button>
      </div>
    </div>
  );
}

function IntegrationIcon({ id }: { id: string }) {
  const logos: Record<string, string> = {
    claude: claudeLogoUrl,
    opencode: opencodeLogoUrl,
    cursor: cursorLogoUrl,
    pi: piLogoUrl,
    vscode: vscodeLogoUrl,
    windsurf: windsurfLogoUrl,
    zed: zedLogoUrl,
  };
  const src = logos[id];
  if (src) return <img src={src} className="integration-logo" alt="" draggable="false" />;
  return <PluginGlyph />;
}

function claudeStatusTone(state: ClaudeCodeStatus["state"]): StatusTone {
  if (state === "configured") return "green";
  if (state === "error") return "red";
  if (state === "needs_setup" || state === "detected") return "blue";
  return "slate";
}

function opencodeStatusTone(state: OpenCodeSetupStatus["state"]): StatusTone {
  if (state === "configured") return "green";
  if (state === "error") return "red";
  if (state === "needs_setup") return "blue";
  return "slate";
}

function cursorStatusTone(state: CursorSetupStatus["state"]): StatusTone {
  if (state === "configured") return "green";
  if (state === "error" || state === "conflict") return "red";
  if (state === "needs_update") return "orange";
  if (state === "needs_setup") return "blue";
  return "slate";
}

function IntegrationsView() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<AgentSetupSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = async (selectedPetId?: string, commandMode?: AgentSetupSnapshot["commandMode"]) => {
    try {
      const petId = selectedPetId === undefined ? snapshot?.selectedPetId : selectedPetId;
      const mode = commandMode === undefined ? snapshot?.commandMode : commandMode;
      const next = await api.getIntegrationsState(petId, mode);
      setSnapshot(next);
      setError("");
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 3000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  const run = async (label: string, action: AgentSetupAction) => {
    try {
      setBusy(label);
      setError("");
      setMessage("");
      const next = await api.runIntegrationAction(action, snapshot?.selectedPetId, snapshot?.commandMode);
      setSnapshot(next);
      if (next.lastAction) {
        if (next.lastAction.ok) setMessage(next.lastAction.message);
        else setError(next.lastAction.message);
      }
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy("");
    }
  };

  const updatePath = async (key: keyof AgentSetupCommandPaths, value: string) => {
    try {
      setBusy(t("integrations.busy.savingPath"));
      await api.updateIntegrationCommandPaths({ [key]: value });
      await load();
      setMessage(t("integrations.toast.pathSaved"));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy("");
    }
  };

  const changeCommandMode = (mode: AgentSetupSnapshot["commandMode"]) => {
    void load(snapshot?.selectedPetId, mode);
  };

  if (!snapshot) {
    return (
      <GlassCard className="flex h-64 flex-col items-center justify-center gap-4 text-center">
        <p className="text-sm font-semibold text-slatecopy">{error || t("integrations.loading")}</p>
        {error && <Button variant="secondary" size="compact" icon={<RefreshIcon />} onClick={() => void load()}>{t("common.retry")}</Button>}
      </GlassCard>
    );
  }

  const isBusy = Boolean(busy) || snapshot.busy;
  const integrationDialogTitleId = selectedId ? `integration-detail-title-${selectedId}` : undefined;

  const integrations = [
    { id: "claude", name: t("integrations.claude.name"), icon: "claude", status: snapshot.status.label, tone: claudeStatusTone(snapshot.status.state), description: t("integrations.claude.description") },
    { id: "opencode", name: t("integrations.opencode.name"), icon: "opencode", status: snapshot.opencodeStatus.label, tone: opencodeStatusTone(snapshot.opencodeStatus.state), description: t("integrations.opencode.description") },
    { id: "cursor", name: t("integrations.cursor.name"), icon: "cursor", status: snapshot.cursorStatus.label, tone: cursorStatusTone(snapshot.cursorStatus.state), description: t("integrations.cursor.description") },
    { id: "pi", name: t("integrations.pi.name"), icon: "pi", status: t("integrations.pi.status"), tone: "blue" satisfies StatusTone, description: t("integrations.pi.description") },
  ] as const;

  const soon = [
    { name: t("integrations.soon.vscode"), icon: "vscode" },
    { name: t("integrations.soon.windsurf"), icon: "windsurf" },
    { name: t("integrations.soon.zed"), icon: "zed" },
  ];

  const selectedIntegrationName = selectedId === "pi" ? t("integrations.pi.name") : integrations.find((item) => item.id === selectedId)?.name;

  return (
    <div className="flex flex-col gap-6 h-full overflow-y-auto pr-2">
      {error && <div className="error">{error}</div>}
      {message && <div className="settings-success settings-message">{message}</div>}

      <div className="integration-grid">
        {integrations.map((item) => (
          <article key={item.id} className={`integration-card ${selectedId === item.id ? "border-brand ring-4 ring-brand/15" : ""}`}>
            <div className="plugin-card-body">
              <div className="integration-icon">
                <IntegrationIcon id={item.icon} />
              </div>
              <div className="plugin-card-content">
                <div className="flex items-center justify-between">
                  <strong>{item.name}</strong>
                  <StatusPill tone={item.tone}>{item.status}</StatusPill>
                </div>
                <small>{item.description}</small>
              </div>
            </div>
            <div className="plugin-card-footer">
              <div className="flex gap-2 w-full">
                {item.id === "claude" && snapshot.status.canConfigure && <Button variant="primary" size="compact" icon={<InstallIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.installing"), "configure")}>{t("integrations.install")}</Button>}
                {item.id === "opencode" && snapshot.opencodeStatus.canInstall && <Button variant="primary" size="compact" icon={<InstallIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.installing"), "opencode-install")}>{t("integrations.install")}</Button>}
                {item.id === "cursor" && snapshot.cursorStatus.canInstall && <Button variant="primary" size="compact" icon={<InstallIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.installing"), "cursor-install")}>{t("integrations.install")}</Button>}
                <Button variant="secondary" size="compact" icon={<ConfigureIcon />} fullWidth={item.id === "pi"} onClick={() => setSelectedId(item.id)}>{item.id === "pi" ? t("integrations.viewSetup") : t("integrations.configure")}</Button>
              </div>
            </div>
          </article>
        ))}
        {soon.map((item) => (
          <article key={item.name} className="integration-card opacity-60">
            <div className="plugin-card-body">
              <div className="integration-icon grayscale">
                <IntegrationIcon id={item.icon} />
              </div>
              <div className="plugin-card-content">
                <div className="flex items-center justify-between">
                  <strong>{item.name}</strong>
                  <StatusPill tone="slate">{t("integrations.soon.status")}</StatusPill>
                </div>
                <small>{t("integrations.soon.description")}</small>
              </div>
            </div>
            <div className="plugin-card-footer">
              <Button variant="secondary" size="compact" fullWidth disabled>{t("integrations.soon.button")}</Button>
            </div>
          </article>
        ))}
      </div>

      {selectedId && (
        <div className="plugin-config-overlay" role="dialog" aria-modal="true" aria-labelledby={integrationDialogTitleId}>
          <button className="plugin-config-backdrop" type="button" aria-label={t("integrations.closeAria")} onClick={() => setSelectedId(null)} />
          <GlassCard className="plugin-inspector">
            <div className="plugin-inspector-head">
              <div className="plugin-inspector-icon">
                <IntegrationIcon id={selectedId} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="eyebrow">{t("integrations.detail")}</p>
                <h2 id={integrationDialogTitleId}>{selectedIntegrationName}</h2>
              </div>
              <Button variant="secondary" size="compact" icon={<CloseIcon />} onClick={() => setSelectedId(null)}>{t("integrations.close")}</Button>
            </div>

            <div className="flex flex-col gap-5 mt-4">
              {selectedId !== "pi" && (
                <section className="plugin-section">
                  <div className="plugin-section-title"><small>{t("integrations.commandSource")}</small><strong>{t("integrations.cliMode")}</strong></div>
                  <select className="settings-select w-full" value={snapshot.commandMode} disabled={isBusy} onChange={(event) => changeCommandMode(event.target.value as AgentSetupSnapshot["commandMode"])}>
                    <option value="published">{t(commandModeLabelKeys.published)}</option>
                    <option value="bundled">{t(commandModeLabelKeys.bundled)}</option>
                    <option value="local" disabled={!snapshot.localDevAvailable}>{t(commandModeLabelKeys.local)}{snapshot.localDevAvailable ? "" : t("integrations.localUnavailable")}</option>
                  </select>
                  <p className="text-xs text-slatecopy mt-2">{t("integrations.commandModeHelp")}</p>
                </section>
              )}

              {selectedId === "claude" && (
                <>
                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.connection")}</small><strong>{t("integrations.statusRouting")}</strong></div>
                    <div className="flex items-center justify-between p-3 rounded-2xl bg-blue-50/50 border border-blue-100/50">
                      <div className="flex flex-col">
                        <strong className="text-sm text-navy">{snapshot.status.label}</strong>
                        <small className="text-xs text-slatecopy">{snapshot.status.details}</small>
                      </div>
                      <StatusPill tone={claudeStatusTone(snapshot.status.state)}>{snapshot.status.state}</StatusPill>
                    </div>
                    <div className="mt-2">
                      <label className="text-xs font-bold text-slatecopy uppercase tracking-wider mb-1 block">{t("integrations.petRouting")}</label>
                      <select
                        className="settings-select w-full"
                        value={snapshot.selectedPetId || ""}
                        onChange={(e) => void load(e.target.value)}
                        disabled={isBusy}
                      >
                        <option value="">{t("integrations.defaultPet")}</option>
                        {snapshot.petOptions.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                      </select>
                    </div>
                  </section>

                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.configuration")}</small><strong>{t("integrations.commandPaths")}</strong></div>
                    <div className="flex flex-col gap-3">
                      <PathField label={t("integrations.claudeCommand")} value={snapshot.commandPaths.claude} placeholder="claude" onSave={(v) => updatePath("claude", v)} disabled={isBusy} />
                      <PathField label={t("integrations.nodeCommand")} value={snapshot.commandPaths.node} placeholder="node" onSave={(v) => updatePath("node", v)} disabled={isBusy} />
                    </div>
                  </section>

                  <div className="grid grid-cols-2 gap-3">
                    <section className="plugin-section">
                      <div className="plugin-section-title"><small>{t("integrations.optional")}</small><strong>{t("integrations.claudeHooks")}</strong></div>
                      <div className="flex items-center justify-between mb-2">
                        <StatusPill tone={snapshot.hookStatus.status === "installed" ? "green" : "blue"}>{snapshot.hookStatus.status}</StatusPill>
                      </div>
                    <div className="flex flex-col gap-2">
                      <Button variant="primary" size="compact" icon={<HookIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.installingHooks"), "install-hooks")}>{t("integrations.installHooks")}</Button>
                      <Button variant="danger" size="compact" icon={<RemoveIcon />} disabled={isBusy || snapshot.hookStatus.status === "needs_setup"} onClick={() => run(t("integrations.busy.removingHooks"), "uninstall-hooks")}>{t("integrations.removeHooks")}</Button>
                    </div>
                  </section>
                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.included")}</small><strong>{t("integrations.instructions")}</strong></div>
                    <div className="flex items-center justify-between mb-2">
                      <StatusPill tone={snapshot.memoryStatus.state === "installed" ? "green" : "blue"}>{snapshot.memoryStatus.state}</StatusPill>
                    </div>
                    <Button variant="secondary" size="compact" icon={<MemoryIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.updatingInstructions"), "install-memory")}>{t("integrations.updateInstructions")}</Button>
                  </section>
                </div>

                <section className="plugin-section">
                  <div className="plugin-section-title"><small>{t("integrations.actions")}</small><strong>{t("integrations.management")}</strong></div>
                  <div className="grid grid-cols-2 gap-2">
                    {snapshot.status.canConfigure && <Button variant="primary" icon={<InstallIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.installing"), "configure")}>{t("integrations.installMcp")}</Button>}
                    {snapshot.status.canReplace && <Button variant="warning" icon={<ReplaceIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.replacing"), "replace")}>{t("integrations.replaceMcp")}</Button>}
                    {snapshot.status.canRemove && <Button variant="danger" icon={<RemoveIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.removing"), "remove")}>{t("integrations.removeMcp")}</Button>}
                    <Button variant="secondary" icon={<RefreshIcon />} disabled={isBusy} onClick={() => void load()}>{t("integrations.refreshStatus")}</Button>
                  </div>
                </section>


                  <details className="plugin-section group">
                    <summary className="cursor-pointer list-none flex items-center justify-between">
                      <div className="plugin-section-title"><small>{t("integrations.advanced")}</small><strong>{t("integrations.mcpJsonPreview")}</strong></div>
                      <span className="text-brand group-open:rotate-180 transition-transform"><NextIcon /></span>
                    </summary>
                    <pre className="mt-3 p-3 rounded-xl bg-navy/5 text-[10px] font-mono overflow-x-auto border border-navy/5">
                      {JSON.stringify(snapshot.preview.mcpJson, null, 2)}
                    </pre>
                  </details>

                </>
              )}

              {selectedId === "opencode" && (
                <>
                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.connection")}</small><strong>{t("integrations.globalSetup")}</strong></div>
                    <div className="flex items-center justify-between p-3 rounded-2xl bg-blue-50/50 border border-blue-100/50">
                      <div className="flex flex-col">
                        <strong className="text-sm text-navy">{snapshot.opencodeStatus.label}</strong>
                        <small className="text-xs text-slatecopy">{snapshot.opencodeStatus.details}</small>
                      </div>
                      <StatusPill tone={opencodeStatusTone(snapshot.opencodeStatus.state)}>{snapshot.opencodeStatus.state}</StatusPill>
                    </div>
                    <div className="mt-2">
                      <label className="text-xs font-bold text-slatecopy uppercase tracking-wider mb-1 block">{t("integrations.petRouting")}</label>
                      <select
                        className="settings-select w-full"
                        value={snapshot.selectedPetId || ""}
                        onChange={(e) => void load(e.target.value)}
                        disabled={isBusy}
                      >
                        <option value="">{t("integrations.defaultPet")}</option>
                        {snapshot.petOptions.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                      </select>
                    </div>
                  </section>

                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.configuration")}</small><strong>{t("integrations.commandPaths")}</strong></div>
                    <div className="flex flex-col gap-3">
                      <PathField label={t("integrations.opencodeCommand")} value={snapshot.commandPaths.opencode} placeholder="opencode" onSave={(v) => updatePath("opencode", v)} disabled={isBusy} />
                      <PathField label={t("integrations.nodeCommand")} value={snapshot.commandPaths.node} placeholder="node" onSave={(v) => updatePath("node", v)} disabled={isBusy} />
                    </div>
                  </section>

                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.actions")}</small><strong>{t("integrations.management")}</strong></div>
                    <div className="grid grid-cols-2 gap-2">
                      {snapshot.opencodeStatus.canInstall && <Button variant="primary" icon={<InstallIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.installing"), "opencode-install")}>{t("integrations.installGlobal")}</Button>}
                      {snapshot.opencodeStatus.canRemove && <Button variant="danger" icon={<RemoveIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.removing"), "opencode-remove")}>{t("integrations.removeGlobal")}</Button>}
                      <Button variant="secondary" icon={<RefreshIcon />} disabled={isBusy} onClick={() => void load()}>{t("integrations.refreshStatus")}</Button>
                    </div>
                  </section>

                  <details className="plugin-section group">
                    <summary className="cursor-pointer list-none flex items-center justify-between">
                      <div className="plugin-section-title"><small>{t("integrations.advanced")}</small><strong>{t("integrations.configPreview")}</strong></div>
                      <span className="text-brand group-open:rotate-180 transition-transform"><NextIcon /></span>
                    </summary>
                    <pre className="mt-3 p-3 rounded-xl bg-navy/5 text-[10px] font-mono overflow-x-auto border border-navy/5">
                      {JSON.stringify(snapshot.opencodePreview.configPreview, null, 2)}
                    </pre>
                  </details>
                </>
              )}

              {selectedId === "cursor" && (
                <>
                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.connection")}</small><strong>{t("integrations.globalMcp")}</strong></div>
                    <div className="flex items-center justify-between p-3 rounded-2xl bg-blue-50/50 border border-blue-100/50">
                      <div className="flex flex-col">
                        <strong className="text-sm text-navy">{snapshot.cursorStatus.label}</strong>
                        <small className="text-xs text-slatecopy">{snapshot.cursorStatus.details}</small>
                      </div>
                      <StatusPill tone={cursorStatusTone(snapshot.cursorStatus.state)}>{snapshot.cursorStatus.state}</StatusPill>
                    </div>
                    <div className="mt-2">
                      <label className="text-xs font-bold text-slatecopy uppercase tracking-wider mb-1 block">{t("integrations.petRouting")}</label>
                      <select
                        className="settings-select w-full"
                        value={snapshot.selectedPetId || ""}
                        onChange={(e) => void load(e.target.value)}
                        disabled={isBusy}
                      >
                        <option value="">{t("integrations.defaultPet")}</option>
                        {snapshot.petOptions.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                      </select>
                    </div>
                  </section>

                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.actions")}</small><strong>{t("integrations.management")}</strong></div>
                    <div className="grid grid-cols-2 gap-2">
                      {snapshot.cursorStatus.canInstall && <Button variant="primary" icon={<InstallIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.installing"), "cursor-install")}>{t("integrations.installMcp")}</Button>}
                      {snapshot.cursorStatus.canReplace && <Button variant="warning" icon={<ReplaceIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.replacing"), "cursor-replace")}>{t("integrations.replaceMcp")}</Button>}
                      {snapshot.cursorStatus.canRemove && <Button variant="danger" icon={<RemoveIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.removing"), "cursor-remove")}>{t("integrations.removeMcp")}</Button>}
                      <Button variant="secondary" icon={<RefreshIcon />} disabled={isBusy} onClick={() => void load()}>{t("integrations.refreshStatus")}</Button>
                    </div>
                  </section>


                  <details className="plugin-section group">
                    <summary className="cursor-pointer list-none flex items-center justify-between">
                      <div className="plugin-section-title"><small>{t("integrations.advanced")}</small><strong>{t("integrations.mcpEntryPreview")}</strong></div>
                      <span className="text-brand group-open:rotate-180 transition-transform"><NextIcon /></span>
                    </summary>
                    <pre className="mt-3 p-3 rounded-xl bg-navy/5 text-[10px] font-mono overflow-x-auto border border-navy/5">
                      {JSON.stringify({ mcpServers: snapshot.cursorPreview.mcpEntry }, null, 2)}
                    </pre>
                  </details>

                  <details className="plugin-section group">
                    <summary className="cursor-pointer list-none flex items-center justify-between">
                      <div className="plugin-section-title"><small>{t("integrations.advanced")}</small><strong>{t("integrations.rulesPreview")}</strong></div>
                      <span className="text-brand group-open:rotate-180 transition-transform"><NextIcon /></span>
                    </summary>
                    <p className="mt-3 text-xs text-slatecopy">{snapshot.cursorPreview.rulesPath}</p>
                    <pre className="mt-3 p-3 rounded-xl bg-navy/5 text-[10px] font-mono overflow-x-auto border border-navy/5">
                      {snapshot.cursorPreview.rulesContent}
                    </pre>
                  </details>
                </>
              )}

              {selectedId === "pi" && (
                <section className="plugin-section">
                  <div className="plugin-section-title"><small>{t("integrations.pi.manualSetup")}</small><strong>{t("integrations.pi.extension")}</strong></div>
                  <p className="text-sm text-slatecopy leading-relaxed">
                    {t("integrations.pi.intro")}
                  </p>
                  <div className="mt-3 p-4 rounded-2xl bg-navy/5 border border-navy/5 flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-bold text-slatecopy uppercase tracking-wider">{t("integrations.pi.globalInstall")}</span>
                      <code className="bg-white px-2 py-1 rounded border border-blue-100 text-brand text-xs">pi install npm:@open-pets/pi</code>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-bold text-slatecopy uppercase tracking-wider">{t("integrations.pi.projectInstall")}</span>
                      <code className="bg-white px-2 py-1 rounded border border-blue-100 text-brand text-xs">pi install -l npm:@open-pets/pi</code>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-bold text-slatecopy uppercase tracking-wider">{t("integrations.pi.remove")}</span>
                      <code className="bg-white px-2 py-1 rounded border border-blue-100 text-brand text-xs">pi remove npm:@open-pets/pi</code>
                    </div>
                  </div>
                  <div className="mt-3 p-4 rounded-2xl bg-blue-50/50 border border-blue-100/60 flex flex-col gap-2">
                    <span className="text-[10px] font-bold text-slatecopy uppercase tracking-wider">{t("integrations.pi.slashCommands")}</span>
                    <code className="bg-white px-2 py-1 rounded border border-blue-100 text-brand text-xs">/openpets status</code>
                    <code className="bg-white px-2 py-1 rounded border border-blue-100 text-brand text-xs">/openpets test</code>
                    <code className="bg-white px-2 py-1 rounded border border-blue-100 text-brand text-xs">/openpets react &lt;reaction&gt;</code>
                    <code className="bg-white px-2 py-1 rounded border border-blue-100 text-brand text-xs">/openpets say &lt;message&gt;</code>
                  </div>
                  <p className="text-xs text-slatecopy mt-2">
                    {t("integrations.pi.outro")}
                  </p>
                </section>
              )}
            </div>
          </GlassCard>
        </div>
      )}
    </div>
  );
}

function PluginsView() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<PluginServiceSnapshot | null>(null);
  const [catalog, setCatalog] = useState<PluginCatalogSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [configDraft, setConfigDraft] = useState<PluginConfig>({});
  const [commandDrafts, setCommandDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [activeCommandId, setActiveCommandId] = useState("");
  const [showDeveloperMode, setShowDeveloperMode] = useState(false);

  async function load(refreshCatalog = false, clearMessages = true) {
    if (clearMessages) setError("");
    const [nextSnapshot, nextCatalog] = await Promise.all([
      api.getPluginsSnapshot(),
      api.getPluginCatalogSnapshot(refreshCatalog).catch(() => ({ plugins: [] } as PluginCatalogSnapshot)),
    ]);
    setSnapshot(nextSnapshot);
    setCatalog(nextCatalog);
    const entries = mergePluginEntries(nextSnapshot, nextCatalog);
    setSelectedId((current) => entries.some((entry) => entry.id === current) ? current : "");
  }

  useEffect(() => { void load().catch((err) => setError(String(err?.message ?? err))); }, []);
  // Re-fetch plugin records when the host locale changes so `$t:` labels re-render translated.
  useEffect(() => api.onPluginsRefresh(() => { void load(false, false).catch((err) => setError(String(err?.message ?? err))); }), []);
  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [message]);

  const entries = useMemo(() => mergePluginEntries(snapshot, catalog), [snapshot, catalog]);
  const selected = entries.find((entry) => entry.id === selectedId);
  const installed = selected?.installed;
  const catalogPlugin = selected?.catalog;
  const hasConfigFields = Boolean(installed?.configSchema && Object.keys(installed.configSchema).length > 0);
  const activeCommand = installed?.commands?.find((command) => command.id === activeCommandId);

  useEffect(() => { setConfigDraft(materializeConfigDraft(installed?.configSchema, installed?.effectiveConfig)); }, [installed?.id, installed?.configSchema, installed?.effectiveConfig]);
  useEffect(() => { setCommandDrafts({}); setActiveCommandId(""); }, [installed?.id]);

  const filteredEntries = useMemo(() => {
    return entries.filter((entry) => {
      if (filter === "installed" && !entry.installed) return false;
      if (filter === "catalog" && entry.installed) return false;
      if (filter === "local" && entry.installed?.source !== "local") return false;
      if (filter === "broken" && !entry.installed?.brokenReason) return false;
      return true;
    });
  }, [entries, filter]);

  async function run(label: string, fn: () => Promise<void>) {
    try { setBusy(label); setError(""); setMessage(""); await fn(); }
    catch (err) { setError(String((err as Error)?.message ?? err)); }
    finally { setBusy(""); }
  }

  function applyResult(result: PluginServiceResult, success?: string) {
    setSnapshot(result.snapshot);
    if (!result.ok) { setError(result.error); return false; }
    if (success) setMessage(success);
    return true;
  }

  function updateDraft(key: string, value: unknown) {
    setConfigDraft((current) => ({ ...current, [key]: value }));
  }

  function updateCommandDraft(commandId: string, key: string, value: unknown) {
    setCommandDrafts((current) => ({ ...current, [commandId]: { ...(current[commandId] ?? {}), [key]: value } }));
  }

  async function pickConfigSound(pluginId: string, key: string) {
    try {
      setError("");
      const result = await api.pickPluginConfigSound(pluginId);
      if (!result.ok) { setSnapshot(result.snapshot); setError(result.error); return; }
      if (!result.sound.id) { setSnapshot(result.snapshot); return; }
      updateDraft(key, result.sound);
      setMessage(t("plugins.toast.soundImported"));
    } catch (err) { setError(String((err as Error)?.message ?? err)); }
  }

  async function installCatalogEntry(entry: PluginEntry) {
    const result = await api.installCatalogPlugin(entry.id);
    if (!applyResult(result)) return;
    const installedPlugin = result.snapshot.plugins.find((plugin) => plugin.id === entry.id);
    if (!installedPlugin) { setMessage(t("plugins.toast.noPluginInstalled")); return; }
    await load(false, false);
    setMessage(t("plugins.toast.pluginInstalled"));
  }

  async function updateCatalogEntry(plugin: SafePluginRecord) {
    const previousVersion = plugin.version;
    const result = await api.updateCatalogPlugin(plugin.id);
    if (!applyResult(result)) return;
    const updatedPlugin = result.snapshot.plugins.find((nextPlugin) => nextPlugin.id === plugin.id);
    setMessage(updatedPlugin && updatedPlugin.version !== previousVersion ? t("plugins.toast.pluginUpdated") : t("plugins.toast.noPluginUpdate"));
  }

  return (
    <div className="plugins-layout">
      {error && <div className="error settings-message">{error}</div>}
      {message && <div className="settings-success settings-message">{message}</div>}
      <div className={`plugin-developer-panel ${showDeveloperMode ? "open" : ""}`}>
        <button className="plugin-developer-toggle" type="button" onClick={() => setShowDeveloperMode((open) => !open)} aria-expanded={showDeveloperMode}>
          <span>{t("plugins.developer.eyebrow")}</span>
          <small>{showDeveloperMode ? t("plugins.developer.hide") : t("plugins.developer.show")}</small>
        </button>
        {showDeveloperMode && <div className="plugin-developer-body">
          <p>{t("plugins.developer.description")}</p>
          <Button variant="secondary" size="compact" icon={<FolderPlusIcon />} disabled={!!busy} onClick={() => void run(t("plugins.busy.loading"), async () => {
            const beforeIds = new Set(snapshot?.plugins.map((plugin) => plugin.id) ?? []);
            const result = await api.loadLocalPlugin();
            if (!applyResult(result)) return;
            const loadedPlugin = result.snapshot.plugins.find((plugin) => plugin.source === "local" && !beforeIds.has(plugin.id));
            setMessage(loadedPlugin ? t("plugins.toast.localLoaded") : t("plugins.toast.noLocalLoaded"));
          })}>{t("plugins.developer.loadUnpacked")}</Button>
        </div>}
      </div>
      <GlassCard className="plugins-hub">
        <div className="filters">
          {(["all", "installed", "catalog", "local", "broken"] as PluginFilter[]).map((nextFilter) => (
            <button key={nextFilter} className={`filter ${filter === nextFilter ? "active" : ""}`} onClick={() => setFilter(nextFilter)}>{t(pluginFilterLabelKeys[nextFilter])}</button>
          ))}
        </div>
        <div className="plugin-grid">
          {filteredEntries.map((entry) => (
            <article key={entry.id} className={`plugin-card ${entry.installed?.brokenReason ? "broken" : ""}`}>
              <div className="plugin-card-body">
                <span className="plugin-card-icon"><PluginIconImage entry={entry} /></span>
                <div className="plugin-card-content">
                  <strong>{pluginName(entry)}</strong>
                  <small>{pluginDescription(entry, t)}</small>
                  <div className="badges mt-1">
                    <StatusPill tone={pluginPrimaryTone(entry)}>{pluginPrimaryLabel(entry, t)}</StatusPill>
                    {entry.installed?.bundled && <StatusPill tone="blue">{t("plugins.badge.bundled")}</StatusPill>}
                    {entry.catalog?.publisherType === "community" && <StatusPill tone="orange">{t("plugins.badge.community")}</StatusPill>}
                    {entry.installed?.source === "local" && <StatusPill tone="orange">{t("plugins.badge.local")}</StatusPill>}
                    {entry.installed?.runtime === "javascript" || entry.catalog?.runtime === "javascript" ? <StatusPill tone="purple">{t("plugins.badge.js")}</StatusPill> : <StatusPill tone="slate">{t("plugins.badge.declarative")}</StatusPill>}
                  </div>
                </div>
              </div>

              <div className="plugin-card-footer">
                <div className="plugin-card-meta">
                  <span className="text-[10px] font-bold text-slatecopy/50 uppercase tracking-tight">v{entry.installed?.version || entry.catalog?.version}</span>
                </div>

                <div className="plugin-card-actions">
                  {entry.installed && (
                    <div className="plugin-card-toggle-zone">
                      <span className="plugin-card-toggle-label">{entry.installed.enabled ? t("plugins.card.active") : t("plugins.card.off")}</span>
                      <input
                        className="settings-toggle plugin-card-toggle"
                        type="checkbox"
                        checked={entry.installed.enabled}
                        disabled={!!busy || entry.installed.catalogDisabled || Boolean(entry.installed.brokenReason)}
                        onChange={(event) => {
                          const nextEnabled = event.target.checked;
                          void run(t("plugins.busy.saving"), async () => {
                            applyResult(await api.setPluginEnabled(entry.id, nextEnabled), nextEnabled ? t("plugins.toast.pluginEnabled") : t("plugins.toast.pluginDisabled"));
                          });
                        }}
                      />
                    </div>
                  )}

                  {entry.installed ? (
                    <>
                      {entry.installed.source === "local" && entry.installed.sourcePath && <Button variant="secondary" size="compact" icon={<RefreshIcon />} disabled={!!busy} onClick={() => void run(t("plugins.busy.refreshingSource"), async () => { applyResult(await api.refreshLocalPlugin(entry.id), t("plugins.toast.localRefreshed")); })}>{t("plugins.card.refresh")}</Button>}
                      <Button variant="secondary" size="compact" icon={<ConfigureIcon />} disabled={!!busy} onClick={() => setSelectedId(entry.id)}>{t("plugins.card.configure")}</Button>
                    </>
                  ) : (
                    <Button variant="primary" size="compact" icon={<InstallIcon />} disabled={!!busy || entry.catalog?.deprecated} onClick={() => void run(t("plugins.busy.installing"), async () => { await installCatalogEntry(entry); })}>{t("plugins.card.installPlugin")}</Button>
                  )}
                </div>
              </div>
            </article>
          ))}
          {!filteredEntries.length && <div className="plugin-empty"><PluginGlyph /><strong>{t("plugins.empty.title")}</strong><small>{t("plugins.empty.description")}</small></div>}
        </div>
        <div className="plugin-hub-footer">
          <span><strong>{snapshot?.plugins.length ?? 0}</strong> {t("plugins.footer.installed")} · <strong>{catalog?.plugins.length ?? 0}</strong> {t("plugins.footer.catalog")}</span>
          <span className="plugin-hub-actions">
            <Button variant="secondary" size="compact" disabled={!!busy} icon={<RefreshIcon />} onClick={() => void run(t("plugins.busy.refreshing"), async () => { await load(true); setMessage(t("plugins.toast.catalogRefreshed")); })}>{t("plugins.footer.refresh")}</Button>
            <Button variant="secondary" size="compact" icon={<FolderPlusIcon />} disabled={!!busy} onClick={() => void run(t("plugins.busy.loading"), async () => {
              const result = await api.loadLocalPlugin();
              if (applyResult(result, t("plugins.toast.localLoaded"))) await load(false, false);
            })}>{t("plugins.footer.loadLocal")}</Button>
          </span>
        </div>
      </GlassCard>
      {selected && <div className="plugin-config-overlay" role="dialog" aria-modal="true" aria-label={t("plugins.inspector.configAria", { name: pluginName(selected) })}>
        <button className="plugin-config-backdrop" type="button" aria-label={t("plugins.inspector.closeAria")} onClick={() => setSelectedId("")} />
        <GlassCard className="plugin-inspector">
        {selected ? <>
          <div className="plugin-inspector-head">
            <span className="plugin-inspector-icon"><PluginIconImage entry={selected} /></span>
            <div className="flex-1 min-w-0"><p className="eyebrow">{t("plugins.inspector.details")}</p><h2>{pluginName(selected)}</h2><p className="desc">{pluginDescription(selected, t)}</p></div>
            <Button variant="secondary" size="compact" icon={<CloseIcon />} onClick={() => setSelectedId("")}>{t("plugins.inspector.close")}</Button>
          </div>
          <div className="meta">
            <StatusPill tone={pluginPrimaryTone(selected)}>{pluginPrimaryLabel(selected, t)}</StatusPill>
            <StatusPill tone="slate">v{installed?.version ?? catalogPlugin?.version}</StatusPill>
            {installed?.bundled && <StatusPill tone="blue">{t("plugins.badge.bundled")}</StatusPill>}
            {catalogPlugin?.publisherType === "community" && <StatusPill tone="orange">{t("plugins.badge.community")}</StatusPill>}
            {installed?.source === "local" && <StatusPill tone="orange">{t("plugins.badge.local")}</StatusPill>}
            {(installed?.catalogDeprecated || catalogPlugin?.deprecated) && <StatusPill tone="orange">{t("plugins.badge.deprecated")}</StatusPill>}
          </div>
          {(installed?.catalogStatusReason || catalogPlugin?.statusReason || installed?.status?.text) && <div className="plugin-status-strip">
            {installed?.status?.text && <StatusPill tone={installed.status.tone ? pluginStatusTone[installed.status.tone] : "blue"}>{installed.status.text}</StatusPill>}
            <span>{installed?.catalogStatusReason || catalogPlugin?.statusReason}</span>
          </div>}
          {installed ? <>
            <section className="plugin-section">
              <div className="plugin-section-title"><small>{t("plugins.inspector.runtime")}</small><strong>{t("plugins.inspector.statePermissions")}</strong></div>
              <label className="settings-row plugin-toggle-row">
                <div className="settings-row-info"><strong>{installed.enabled ? t("plugins.inspector.enabled") : t("plugins.inspector.disabled")}</strong><small>{installed.brokenReason || (installed.catalogDisabled ? t("plugins.inspector.catalogDisabledNote") : t("plugins.inspector.toggleNote"))}</small></div>
                <input className="settings-toggle" type="checkbox" checked={installed.enabled} disabled={!!busy || installed.catalogDisabled || Boolean(installed.brokenReason)} onChange={(event) => { const nextEnabled = event.target.checked; void run(t("plugins.busy.saving"), async () => { applyResult(await api.setPluginEnabled(installed.id, nextEnabled), nextEnabled ? t("plugins.toast.pluginEnabled") : t("plugins.toast.pluginDisabled")); }); }} />
              </label>
              {installed.source === "local" && installed.sourcePath && <div className="plugin-source-path"><small>{t("plugins.inspector.sourceFolder")}</small><code>{installed.sourcePath}</code></div>}
              <div className="badges plugin-permissions">{installed.approvedPermissions.length ? installed.approvedPermissions.map((permission) => <StatusPill key={permission} tone={sensitivePermissionSet.has(permission) ? "red" : permission === "network" || permission === "network:write" ? "orange" : "blue"}>{t(pluginPermissionLabelKeys[permission])}</StatusPill>) : <StatusPill tone="slate">{t("plugins.inspector.noPermissions")}</StatusPill>}</div>
            </section>
            {!!installed.configErrors?.length && <section className="plugin-section plugin-section-danger"><div className="plugin-section-title"><small>{t("plugins.inspector.configuration")}</small><strong>{t("plugins.inspector.needsAttention")}</strong></div><ul>{installed.configErrors.map((configError, index) => <li key={index}>{configError.message || String(configError)}</li>)}</ul></section>}
            {hasConfigFields && <section className="plugin-section">
              <div className="plugin-section-title"><small>{t("plugins.inspector.settings")}</small><strong>{t("plugins.inspector.configuration")}</strong></div>
              <div className="plugin-config-form">{Object.entries(installed.configSchema ?? {}).map(([key, field]) => <ConfigFieldEditor key={key} pluginId={installed.id} fieldKey={key} field={field} value={configDraft[key] ?? initialConfigValue(field)} onChange={(value) => updateDraft(key, value)} onPickSound={(pluginId) => pickConfigSound(pluginId, key)} spritePreviews={installed.spritePreviews} />)}</div>
              <Button variant="primary" fullWidth icon={<SaveIcon />} disabled={!!busy} onClick={() => void run(t("plugins.busy.saving"), async () => { applyResult(await api.savePluginConfig(installed.id, configDraft), t("plugins.toast.configSaved")); })}>{t("plugins.inspector.saveConfiguration")}</Button>
            </section>}
            {!!installed.commands?.length && <section className="plugin-section">
              <div className="plugin-section-title"><small>{t("plugins.inspector.commands")}</small><strong>{t("plugins.inspector.quickActions")}</strong></div>
              <div className="plugin-command-list">
                {installed.commands.map((command) => (
                  <div key={command.id} className="flex flex-col gap-2">
                    <Button variant="secondary" size="compact" disabled={!!busy} onClick={() => {
                      if (command.form) { setActiveCommandId((current) => current === command.id ? "" : command.id); return; }
                      void run(t("plugins.busy.running"), async () => { applyResult(await api.executePluginCommand(installed.id, command.id), t("plugins.toast.commandRan")); });
                    }}>
                      {command.title}
                    </Button>
                    {command.description && <small className="text-[10px] text-slatecopy px-1 leading-tight">{command.description}</small>}
                  </div>
                ))}
              </div>
              {activeCommand?.form && (() => {
                const formDraft = materializeCommandDraft(activeCommand.form, commandDrafts[activeCommand.id]);
                return <div className="plugin-command-form-panel">
                  <div className="plugin-section-title"><small>{activeCommand.title}</small><strong>{activeCommand.form.submitLabel || activeCommand.title}</strong></div>
                  <div className="plugin-command-form">
                    {activeCommand.form.fields.map((field) => <ConfigFieldEditor key={field.id} pluginId={installed.id} fieldKey={field.id} field={commandFieldToConfigField(field)} value={formDraft[field.id]} onChange={(value) => updateCommandDraft(activeCommand.id, field.id, value)} />)}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="primary" size="compact" disabled={!!busy} onClick={() => void run(t("plugins.busy.running"), async () => { if (applyResult(await api.executePluginCommand(installed.id, activeCommand.id, formDraft), t("plugins.toast.commandRan"))) setActiveCommandId(""); })}>{activeCommand.form.submitLabel || activeCommand.title}</Button>
                    <Button variant="secondary" size="compact" disabled={!!busy} onClick={() => setActiveCommandId("")}>{t("plugins.inspector.close")}</Button>
                  </div>
                </div>;
              })()}
            </section>}
            <section className="plugin-section plugin-actions-section">
              {installed.source === "local" && installed.sourcePath && <Button variant="secondary" disabled={!!busy} icon={<FolderPlusIcon />} onClick={() => void run(t("plugins.busy.refreshingSource"), async () => { applyResult(await api.refreshLocalPlugin(installed.id), t("plugins.toast.localRefreshed")); })}>{t("plugins.inspector.refreshFromFolder")}</Button>}
              <Button variant="secondary" disabled={!!busy} icon={<RefreshIcon />} onClick={() => void run(t("plugins.busy.reloading"), async () => { applyResult(await api.reloadPlugin(installed.id), t("plugins.toast.pluginReloaded")); })}>{t("plugins.inspector.reload")}</Button>
              {installed.source === "catalog" && !installed.bundled && catalogPlugin && catalogPlugin.version !== installed.version && <Button variant="primary" icon={<InstallIcon />} disabled={!!busy} onClick={() => void run(t("plugins.busy.updating"), async () => { await updateCatalogEntry(installed); })}>{t("plugins.inspector.update")}</Button>}
              {!installed.bundled && <Button variant="danger" icon={<RemoveIcon />} disabled={!!busy} onClick={() => { if (window.confirm(t("plugins.inspector.uninstallConfirm", { name: pluginName(selected) }))) void run(t("plugins.busy.uninstalling"), async () => { if (applyResult(await api.uninstallPlugin(installed.id), t("plugins.toast.pluginUninstalled"))) setSelectedId(""); }); }}>{t("plugins.inspector.uninstall")}</Button>}
            </section>
          </> : <section className="plugin-section">
            <div className="plugin-section-title"><small>{t("plugins.inspector.catalog")}</small><strong>{t("plugins.inspector.readyToInstall")}</strong></div>
            <p className="desc">{t("plugins.inspector.catalogDescription")}</p>
            <div className="badges plugin-permissions">{catalogPlugin?.permissions.map((permission) => <StatusPill key={permission} tone={sensitivePermissionSet.has(permission) ? "red" : permission === "network" || permission === "network:write" ? "orange" : "blue"}>{t(pluginPermissionLabelKeys[permission])}</StatusPill>)}</div>
            <Button variant="primary" fullWidth icon={<InstallIcon />} disabled={!!busy || catalogPlugin?.deprecated} onClick={() => void run(t("plugins.busy.installing"), async () => { await installCatalogEntry(selected); })}>{t("plugins.inspector.installPlugin")}</Button>
          </section>}
        </> : <div className="plugin-empty plugin-empty-detail"><PluginGlyph /><strong>{t("plugins.emptyDetail.title")}</strong><small>{t("plugins.emptyDetail.description")}</small></div>}
        </GlassCard>
      </div>}
    </div>
  );
}

function ControlCenter() {
  const { t } = useI18n();
  const [currentRoute, setCurrentRoute] = useState<Route>(() => initialControlCenterRoute());
  const [remoteTokenHandoff, setRemoteTokenHandoff] = useState<RemoteTokenHandoffState>(null);
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [catalog, setCatalog] = useState<CatalogState | null>(null);
  const [catalogPages, setCatalogPages] = useState<Record<number, PetEntry[]>>({});
  const [catalogSearch, setCatalogSearch] = useState<SearchPetEntry[] | null>(null);
  const [catalogPage, setCatalogPage] = useState(0);
  const [codex, setCodex] = useState<CodexState>({ pets: [] });
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const petDetailDialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => api.onRouteChange((route) => {
    if (isRoute(route)) setCurrentRoute(route);
  }), []);

  async function loadPetsData() {
    setError("");
    const [nextState, nextCatalog, nextCodex] = await Promise.all([api.getPetsState(), api.getCatalog(), api.getCodexPets()]);
    logPetsEvent("load-complete", { installed: nextState.pets.installed.length, defaultPetId: nextState.preferences.defaultPetId, catalogSource: nextCatalog.source, catalogPets: nextCatalog.pets.length, catalogPage: nextCatalog.page, catalogPageCount: nextCatalog.pageCount, codexPets: nextCodex.pets.length, catalogError: nextCatalog.error, codexError: nextCodex.error, firstCatalogPet: nextCatalog.pets[0] ? { id: nextCatalog.pets[0].id, preview: imageDebug(nextCatalog.pets[0].preview), thumbnail: imageDebug(nextCatalog.pets[0].thumbnail), spritesheet: imageDebug(nextCatalog.pets[0].spritesheet) } : null });
    setState(nextState); setCatalog(nextCatalog); setCodex(nextCodex);
    setCatalogPage(nextCatalog.page ?? 0);
    setCatalogPages({ [nextCatalog.page ?? 0]: nextCatalog.pets });
    const visiblePetIds = new Set<string>([...nextState.pets.installed.map((pet) => pet.id), ...nextCatalog.pets.map((pet) => pet.id), ...nextCodex.pets.map((pet) => pet.id)]);
    setSelectedId((current) => current && visiblePetIds.has(current) ? current : "");
  }
  useEffect(() => {
    if (currentRoute !== "pets") return;
    void loadPetsData().catch((err) => setError(String(err?.message ?? err)));
  }, [currentRoute]);

  const pets = useMemo(() => {
    const installed = new Map((state?.pets.installed ?? []).map((p) => [p.id, p]));
    const catalogMap = new Map<string, PetEntry>();
    for (const pagePets of Object.values(catalogPages)) {
      for (const p of pagePets) {
        catalogMap.set(p.id, p);
      }
    }
    const codexMap = new Map<string, PetEntry>((codex.pets ?? []).map((p) => [p.id, p]));

    const rows: PetEntry[] = (state?.pets.installed ?? []).map((p) => {
      const catalogPet = catalogMap.get(p.id);
      const codexPet = codexMap.get(p.id);
      const localSpritesheet = p.id && !catalogPet && !codexPet && !p.builtIn ? installedPetSpritesheetUrl(p.id) : undefined;
      const spritesheet = safePetImage(codexPet?.spritesheet) || safePetImage(catalogPet?.spritesheet) || safePetImage(localSpritesheet);
      const preview = safePetImage(codexPet?.preview) || safePetImage(catalogPet?.preview) || safePetImage(catalogPet?.thumbnail) || safePetImage(p.source && "preview" in p.source ? (p.source as { preview?: string }).preview : undefined) || safePetImage(localSpritesheet) || defaultThumbUrl;
      const category = catalogPet?.category;
      const original = catalogPet?.original;
      const featured = catalogPet?.featured;
      return {
        ...p,
        spritesheet,
        preview,
        category,
        original,
        featured,
        sourceKind: "installed" as const,
        installed: true,
      };
    });

    for (const p of catalogMap.values()) {
      if (!installed.has(p.id)) {
        rows.push({
          ...p,
          preview: safePetImage(p.preview) || safePetImage(p.thumbnail) || defaultThumbUrl,
          spritesheet: safePetImage(p.spritesheet),
          sourceKind: "catalog",
          installed: false,
        });
      }
    }

    for (const p of codexMap.values()) {
      if (!installed.has(p.id) && !catalogMap.has(p.id)) {
        rows.push({
          ...p,
          preview: safePetImage(p.preview),
          spritesheet: safePetImage(p.spritesheet),
          sourceKind: "codex",
          installed: false,
        });
      }
    }

    return rows.filter((p) => {
      if (filter === "installed" && !p.installed) return false;
      if (filter === "codex" && p.sourceKind !== "codex" && !(installed.get(p.id)?.source?.kind === "codex")) return false;
      if (filter === "originals" && !p.original && !p.builtIn) return false;
      if (filter === "featured" && (!p.featured || p.original)) return false;
      const q = query.trim().toLowerCase();
      return !q || `${p.displayName} ${p.description ?? ""} ${p.searchText ?? ""} ${p.id}`.toLowerCase().includes(q);
    });
  }, [state, catalogPages, catalogSearch, codex, filter, query]);

  const selected = selectedId ? pets.find((p) => p.id === selectedId) ?? null : null;
  const defaultId = state?.preferences.defaultPetId;

  useEffect(() => {
    if (!selected) return;

    const dialog = petDetailDialogRef.current;
    if (!dialog) return;

    previouslyFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    requestAnimationFrame(() => {
      dialog.querySelector<HTMLElement>(focusableSelector)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSelectedId("");
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocusedElementRef.current?.focus();
    };
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    logPetsEvent("selected-pet", { id: selected.id, sourceKind: selected.sourceKind, installed: selected.installed, builtIn: selected.builtIn, preview: imageDebug(selected.preview), spritesheet: imageDebug(selected.spritesheet), hasSafePreview: Boolean(safePetImage(selected.preview)), hasSafeSpritesheet: Boolean(safePetImage(selected.spritesheet)), catalogPages: Object.keys(catalogPages).join(",") });
  }, [selected]);

  const statusText = useMemo(() => {
    if (!selected) return "";
    const isDefault = selected.id === defaultId;
    const isCodex = selected.sourceKind === "codex" || (state?.pets.installed.find(p => p.id === selected.id)?.source?.kind === "codex");
    if (selected.broken) return selected.brokenReason || t("pets.status.broken");
    if (isDefault) return selected.protected ? t("pets.status.defaultProtected") : t("pets.status.default");
    if (selected.installed) {
      if (isCodex) return t("pets.status.installedCodex");
      return t("pets.status.installed");
    }
    if (selected.sourceKind === "codex") return t("pets.status.availableCodex");
    return t("pets.status.availableCatalog");
  }, [selected, defaultId, state, t]);

  async function act(label: string, fn: () => Promise<unknown>) {
    try { setBusy(label); setError(""); await fn(); await loadPetsData(); }
    catch (err) { setError(String((err as Error)?.message ?? err)); }
    finally { setBusy(""); }
  }

  useEffect(() => {
    if (currentRoute !== "pets") return;
    if (catalogSearch) return;
    void api.getCatalogSearch().then((result) => {
      if (result.error) setError(result.error);
      setCatalogSearch(result.pets ?? []);
    }).catch((err) => setError(String(err?.message ?? err)));
  }, [catalogSearch, currentRoute]);

  useEffect(() => {
    if (currentRoute !== "pets") return;
    if (!catalogSearch) return;
    const q = query.trim().toLowerCase();
    const needsRemotePages = !!q || filter === "featured" || filter === "originals";

    const pages = new Set<number>();

    if (state?.pets.installed) {
      for (const p of state.pets.installed) {
        const searchPet = catalogSearch.find(sp => sp.id === p.id);
        if (searchPet && typeof searchPet.catalogPage === "number" && !catalogPages[searchPet.catalogPage]) {
          pages.add(searchPet.catalogPage);
        }
      }
    }

    if (needsRemotePages) {
      for (const pet of catalogSearch) {
        if (pages.size >= 12) break;
        if (filter === "originals" && !pet.original) continue;
        if (filter === "featured" && (!pet.featured || pet.original)) continue;
        if (q && !`${pet.displayName} ${pet.searchText ?? ""} ${pet.id}`.toLowerCase().includes(q)) continue;
        if (typeof pet.catalogPage === "number" && !catalogPages[pet.catalogPage]) pages.add(pet.catalogPage);
      }
    }

    if (!pages.size) return;
    let cancelled = false;
    void Promise.all([...pages].map((page) => api.getCatalogPage(page).catch((err) => ({ source: "error", pets: [], error: String((err as Error)?.message ?? err), page } as CatalogState)))).then((results) => {
      if (cancelled) return;
      setCatalogPages((current) => {
        const next = { ...current };
        for (const result of results) if (result.source !== "error") next[result.page ?? 0] = result.pets;
        return next;
      });
      const firstError = results.find((result) => result.source === "error")?.error;
      if (firstError) setError(firstError);
    });
    return () => { cancelled = true; };
  }, [catalogPages, catalogSearch, filter, query, state, currentRoute]);

  async function loadCatalogPage(page: number) {
    if (catalogPages[page]) { setCatalogPage(page); return; }
    try {
      setBusy(t("pets.busy.loadingPage")); setError("");
      const next = await api.getCatalogPage(page);
      setCatalog(next); setCatalogPage(next.page ?? page); setCatalogPages((pages) => ({ ...pages, [next.page ?? page]: next.pets }));
    } catch (err) { setError(String((err as Error)?.message ?? err)); }
    finally { setBusy(""); }
  }

  const currentMeta = routeMetadata[currentRoute];

  return (
    <main className="app-shell">
      <header className="hero">
        <div className="hero-content">
          <p className="eyebrow">{t("app.controlCenter")}</p>
          <h1>{t(currentMeta.titleKey)}</h1>
          <p className="hero-desc">{t(currentMeta.descKey)}</p>
        </div>
        <div className="hero-logo-container">
          <img src={openPetsLogoUrl} className="hero-brand-logo" alt={t("app.logo.alt")} />
        </div>
      </header>

      <nav className="nav-bar">
        {navTabs.map((tab) => (
          <button
            key={tab.id}
            className={`nav-tab ${currentRoute === tab.id ? "active" : ""}`}
            onClick={() => setCurrentRoute(tab.id)}
          >
            {tab.icon}
            <span>{t(tab.labelKey)}</span>
          </button>
        ))}
      </nav>

      {error && <div className="error">{error}</div>}

      {currentRoute === "dashboard" ? (
        <DashboardView onNavigate={setCurrentRoute} />
      ) : currentRoute === "settings" ? (
        <SettingsView onTokenHandoff={(result, endpoint) => setRemoteTokenHandoff({ result, endpoint })} />
      ) : currentRoute === "plugins" ? (
        <PluginsView />
      ) : currentRoute === "integrations" ? (
        <IntegrationsView />
      ) : (
        <div className="layout">
          <GlassCard className="gallery">
            <div className="toolbar"><SearchInput value={query} onChange={(e) => setQuery(e.target.value)} /></div>
            <div className="filter-row">
              <div className="filters">
                {(["all", "installed", "featured", "originals", "codex"] as Filter[]).map((f) => (
                  <button
                    key={f}
                    className={`filter ${filter === f ? "active" : ""} ${f === "originals" ? "original" : ""} ${f === "featured" ? "featured" : ""}`}
                    onClick={() => setFilter(f)}
                    aria-current={filter === f ? "page" : undefined}
                  >
                    <span className="filter-icon-wrapper">{filterIcons[f]}</span>
                    <span className="filter-text">{t(filterLabelKeys[f])}</span>
                  </button>
                ))}
              </div>
              <div className="filter-actions">
                <Button variant="secondary" size="compact" icon={<FolderPlusIcon />} disabled={!!busy} onClick={() => void act(t("pets.busy.importing"), () => api.installLocalPet())}>{t("pets.import")}</Button>
                <Button variant="secondary" size="compact" icon={<HeartIcon />} onClick={() => void api.openGallery().catch((err) => setError(String(err?.message ?? err)))}>{t("pets.gallery")}</Button>
              </div>
            </div>
            <div className="pets-grid">{pets.map((pet) => {
              const isBuiltIn = pet.builtIn;
              const hasDistinctPreview = pet.preview && pet.preview !== pet.spritesheet;
              const useSpritesheetFrame = !isBuiltIn && !hasDistinctPreview && !!pet.spritesheet;
              const isDefault = pet.id === defaultId;
              const canInstall = !pet.installed && pet.sourceKind === "catalog";
              const canImport = !pet.installed && pet.sourceKind === "codex";
              const canSetDefault = pet.installed && !isDefault && !pet.broken;
              const canRemove = pet.installed && !pet.builtIn && !pet.protected;

              return (
                <div
                  key={`${pet.sourceKind}-${pet.id}`}
                  className={`pet-card group ${selected?.id === pet.id ? "selected" : ""}`}
                >
                  <span className="thumb">
                    {useSpritesheetFrame ? (
                      <SpriteFrame src={pet.spritesheet} label={t("pets.spriteLabel.thumbnail", { name: pet.displayName })} size="thumb" />
                    ) : (
                      <PetImage src={pet.preview} debugLabel={`${pet.id}:card`} />
                    )}
                  </span>
                  <div className="card-content">
                    <span className="card-title-row">
                      <b className="card-title">{pet.displayName}</b>
                    </span>
                    <p className="card-desc">{pet.description || pet.id}</p>
                    <div className="badges">{isDefault && <StatusPill tone="green">{t("pets.badge.default")}</StatusPill>}{pet.original || pet.builtIn ? <StatusPill tone="yellow">{t("pets.badge.original")}</StatusPill> : pet.featured ? <StatusPill tone="purple">{t("pets.badge.featured")}</StatusPill> : null}{pet.installed && <StatusPill>{t("pets.badge.installed")}</StatusPill>}{pet.sourceKind === "codex" && <StatusPill tone="orange">{t("pets.badge.codex")}</StatusPill>}</div>

                    <div className="pet-card-actions" onClick={(event) => event.stopPropagation()}>
                      <Button
                        variant="secondary"
                        size="compact"
                        icon={<EyeIcon />}
                        ariaLabel={t("pets.aria.view", { name: pet.displayName })}
                        onClick={() => setSelectedId(pet.id)}
                      >
                        {t("pets.action.viewPet")}
                      </Button>
                      {canInstall && (
                        <Button
                          variant="primary"
                          size="compact"
                          icon={<InstallIcon />}
                          disabled={!!busy}
                          ariaLabel={t("pets.aria.install", { name: pet.displayName })}
                          onClick={() => { void act(t("pets.busy.installing"), () => api.installPet(pet.id)); }}
                        >
                          {t("pets.action.install")}
                        </Button>
                      )}
                      {canImport && (
                        <Button
                          variant="warning"
                          size="compact"
                          icon={<ImportIcon />}
                          disabled={!!busy}
                          ariaLabel={t("pets.aria.import", { name: pet.displayName })}
                          onClick={() => { void act(t("pets.busy.importing"), () => api.importCodexPet(pet.id)); }}
                        >
                          {t("pets.action.import")}
                        </Button>
                      )}
                      {canSetDefault && (
                        <Button
                          variant="primary"
                          size="compact"
                          icon={<SetDefaultIcon />}
                          disabled={!!busy}
                          ariaLabel={t("pets.aria.setDefault", { name: pet.displayName })}
                          onClick={() => { void act(t("pets.busy.settingDefault"), () => api.setDefaultPet(pet.id)); }}
                        >
                          {t("pets.action.default")}
                        </Button>
                      )}
                      {canRemove && (
                        <Button
                          variant="danger"
                          size="compact"
                          icon={<RemoveIcon />}
                          disabled={!!busy}
                          ariaLabel={t("pets.aria.remove", { name: pet.displayName })}
                          onClick={() => { void act(t("pets.busy.removing"), () => api.removePet(pet.id)); }}
                        >
                          {t("pets.action.remove")}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}</div>
            <div className="pager">
              {!!catalog?.pageCount && catalog.pageCount > 1 ? (
                <Button
                  variant="secondary"
                  size="compact"
                  icon={<PrevIcon />}
                  disabled={!!busy || catalogPage <= 0}
                  onClick={() => void loadCatalogPage(catalogPage - 1)}
                >
                  {t("pets.pager.prev")}
                </Button>
              ) : <span />}
              <span className="pager-text">{t("pets.pager.count", { count: pets.length })}{!!catalog?.pageCount && catalog.pageCount > 1 ? t("pets.pager.page", { page: catalogPage + 1, pageCount: catalog.pageCount }) : ""}</span>
              {!!catalog?.pageCount && catalog.pageCount > 1 ? (
                <Button
                  variant="secondary"
                  size="compact"
                  icon={<NextIcon />}
                  iconPosition="right"
                  disabled={!!busy || catalogPage >= catalog.pageCount - 1}
                  onClick={() => void loadCatalogPage(catalogPage + 1)}
                >
                  {t("pets.pager.next")}
                </Button>
              ) : <span />}
            </div>
          </GlassCard>

          {selected ? (
            <div ref={petDetailDialogRef} className="plugin-config-overlay" role="dialog" aria-modal="true" aria-label={t("pets.detail.ariaLabel", { name: selected.displayName })}>
              <button className="plugin-config-backdrop" type="button" aria-label={t("pets.detail.closeAria")} onClick={() => setSelectedId("")} />
              <GlassCard className="plugin-inspector pet-detail-inspector">
                <div className="plugin-inspector-head">
                  <span className="plugin-inspector-icon">
                    {safePetImage(selected.spritesheet) ? (
                      <SpriteFrame src={selected.spritesheet} label={t("pets.spriteLabel.thumb", { name: selected.displayName })} size="thumb" />
                    ) : (
                      <PetImage src={selected.preview} debugLabel={`${selected.id}:thumb`} />
                    )}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="eyebrow">{t("pets.detail.eyebrow")}</p>
                    <h2>{selected.displayName}</h2>
                  </div>
                  <Button variant="secondary" size="compact" icon={<CloseIcon />} onClick={() => setSelectedId("")}>{t("common.close")}</Button>
                </div>

                <div className="pet-detail-content">
                  <div className="pet-detail-main">
                    <p className="desc">{selected.description || selected.id}</p>
                    <div className="stage">
                      {safePetImage(selected.spritesheet) ? (
                        <SpriteFrame src={selected.spritesheet} label={t("pets.spriteLabel.animatedPreview", { name: selected.displayName })} />
                      ) : (
                        <PetImage src={selected.preview} debugLabel={`${selected.id}:detail-fallback`} />
                      )}
                    </div>
                    <div className="meta">
                      {selected.broken && <StatusPill tone="red">{t("pets.badge.broken")}</StatusPill>}
                      {selected.installed && !selected.broken && <StatusPill tone="green">{t("pets.badge.ready")}</StatusPill>}
                      {selected.builtIn && <StatusPill tone="orange">{t("pets.badge.originals")}</StatusPill>}
                      {selected.original && !selected.builtIn && <StatusPill tone="yellow">{t("pets.badge.original")}</StatusPill>}
                      {selected.featured && !selected.original && <StatusPill tone="purple">{t("pets.badge.featured")}</StatusPill>}
                    </div>
                    {statusText && <p className="text-sm text-slatecopy mt-3 mb-0 font-medium">{statusText}</p>}
                  </div>

                  <aside className="pet-detail-reactions">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slatecopy mb-3">{t("pets.detail.previewAnimations")}</h3>
                    <div className="pet-preview-grid">
                      {[
                        { label: t("pets.detail.preview.idle"), state: "idle" as const },
                        { label: t("pets.detail.preview.thinking"), state: "thinking" as const },
                        { label: t("pets.detail.preview.happy"), state: "happy" as const },
                        { label: t("pets.detail.preview.wave"), state: "wave" as const },
                      ].map((previewState) => (
                        <article key={previewState.state} className="pet-preview-item">
                          <SpriteFrame src={selected.spritesheet} label={t("pets.spriteLabel.statePreview", { name: selected.displayName, state: previewState.label })} state={previewState.state} size="mini" />
                          <span className="text-xs font-bold text-slatecopy">{previewState.label}</span>
                        </article>
                      ))}
                    </div>
                  </aside>
                </div>

                <div className="actions-container mt-6 flex flex-col gap-3 pet-detail-actions">
                  {/* Main Action (Install, Import, Set Default) */}
                  {!selected.installed && selected.sourceKind === "catalog" && (
                    <Button
                      variant="primary"
                      fullWidth
                      icon={<InstallIcon />}
                      disabled={!!busy}
                      onClick={() => act(t("pets.busy.installing"), () => api.installPet(selected.id))}
                    >
                      {busy || t("pets.detail.installPet")}
                    </Button>
                  )}
                  {!selected.installed && selected.sourceKind === "codex" && (
                    <Button
                      variant="warning"
                      fullWidth
                      icon={<ImportIcon />}
                      disabled={!!busy}
                      onClick={() => act(t("pets.busy.importing"), () => api.importCodexPet(selected.id))}
                    >
                      {busy || t("pets.detail.importCodexPet")}
                    </Button>
                  )}
                  {selected.installed && selected.id !== defaultId && !selected.broken && (
                    <Button
                      variant="primary"
                      fullWidth
                      icon={<SetDefaultIcon />}
                      disabled={!!busy}
                      onClick={() => act(t("pets.busy.settingDefault"), () => api.setDefaultPet(selected.id))}
                    >
                      {busy || t("pets.detail.setDefaultPet")}
                    </Button>
                  )}

                  <div className={`grid gap-3 ${selected.installed && !selected.builtIn && !selected.protected ? "grid-cols-2" : "grid-cols-1"}`}>
                    {selected.installed && !selected.builtIn && !selected.protected && (
                      <Button
                        variant="danger"
                        icon={<RemoveIcon />}
                        disabled={!!busy}
                        onClick={() => act(t("pets.busy.removing"), () => api.removePet(selected.id))}
                      >
                        {t("pets.detail.remove")}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      icon={<RefreshIcon />}
                      disabled={!!busy}
                      onClick={() => void loadPetsData()}
                    >
                      {t("pets.detail.refresh")}
                    </Button>
                  </div>
                </div>
              </GlassCard>
            </div>
          ) : null}
        </div>
      )}
      <RemoteTokenHandoffModal
        handoff={remoteTokenHandoff}
        onDismiss={() => setRemoteTokenHandoff(null)}
      />
    </main>
  );
}

function App() {
  const [i18n, setI18n] = useState<I18nSnapshot | null>(null);

  const reloadI18n = React.useCallback(() => {
    void api.getI18n().then((snapshot) => {
      setI18n(snapshot);
      document.documentElement.lang = snapshot.locale;
    }).catch(() => undefined);
  }, []);
  useEffect(() => { reloadI18n(); }, [reloadI18n]);

  return (
    <I18nProvider snapshot={i18n} onReload={reloadI18n}>
      <ControlCenter />
    </I18nProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
