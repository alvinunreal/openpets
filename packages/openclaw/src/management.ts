export const openClawPackageName = "@open-pets/openclaw";
export const openClawPluginId = "openpets";
export const openClawMinimumVersion = "2026.7.1";
export const openClawMaxStructuredOutputBytes = 256 * 1024;

export type OpenClawCommandAction = "list" | "inspect" | "install" | "enable" | "update" | "remove" | "version";

export interface OpenClawCommandSpec {
  readonly command: string;
  readonly args: readonly string[];
}

export interface OpenClawCommandPaths {
  readonly openclaw: string;
}

export type OpenClawSetupState =
  | "unavailable"
  | "unsupported-host"
  | "management-disabled"
  | "not-installed"
  | "installed-disabled"
  | "installed-enabled"
  | "invalid"
  | "conflict"
  | "indeterminate";

export interface OpenClawPluginStatus {
  readonly state: OpenClawSetupState;
  readonly label: string;
  readonly details: string;
  readonly version?: string;
  readonly installedVersion?: string;
  readonly trackedSource?: OpenClawSourceCategory;
  readonly canInstall: boolean;
  readonly canUpdate: boolean;
  readonly canEnable: boolean;
  readonly canRemove: boolean;
}

export type OpenClawSourceCategory = "official-package" | "custom-source" | "untracked";

export interface OpenClawDiscoveryInput {
  readonly version?: string;
  readonly list: unknown;
  readonly inspect: unknown;
  readonly nixMode?: boolean;
  readonly hostSupported?: boolean;
  readonly inspectMissing?: boolean;
}

export interface OpenClawPluginListSnapshot {
  readonly plugin?: {
    readonly enabled: boolean;
    readonly requiredInstalled?: boolean;
  };
}

export type OpenClawMutation = "configure" | "update" | "remove";

export function buildOpenClawCommand(action: OpenClawCommandAction, targetVersion?: string, paths: OpenClawCommandPaths = { openclaw: "openclaw" }): OpenClawCommandSpec {
  const command = paths.openclaw;
  switch (action) {
    case "version": return { command, args: ["--version"] };
    case "list": return { command, args: ["plugins", "list", "--json"] };
    case "inspect": return { command, args: ["plugins", "inspect", openClawPluginId, "--json"] };
    case "install": return { command, args: ["plugins", "install", `npm:${exactPackageSpec(targetVersion)}`] };
    case "enable": return { command, args: ["plugins", "enable", openClawPluginId] };
    case "update": return { command, args: ["plugins", "update", exactPackageSpec(targetVersion)] };
    case "remove": return { command, args: ["plugins", "uninstall", openClawPluginId, "--force"] };
  }
}

export function exactPackageSpec(targetVersion: string | undefined): string {
  if (!targetVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(targetVersion)) throw new Error("OpenClaw package version is invalid.");
  return `${openClawPackageName}@${targetVersion}`;
}

export function classifyOpenClawStatus(input: OpenClawDiscoveryInput): OpenClawPluginStatus {
  if (input.hostSupported === false) return status("unsupported-host", "Unsupported host", "OpenClaw management is not supported on this host.");
  if (input.nixMode === true) return status("management-disabled", "Managed externally", "OpenClaw is running in Nix mode; its plugin files and configuration are managed externally.");
  if (!input.version) return status("unavailable", "OpenClaw unavailable", "OpenClaw was not found or did not report a version.");
  if (!isSupportedOpenClawVersion(input.version)) return status("unsupported-host", "OpenClaw version unsupported", `OpenClaw ${input.version} is older than the supported ${openClawMinimumVersion}.`);

  const listed = parseOpenClawPluginList(input.list);
  if (!listed) return status("indeterminate", "Status unavailable", "OpenClaw returned malformed plugin list status.", input.version);
  const inspected = normalizeInspect(input.inspect);
  if (!listed.plugin && !inspected) {
    return input.inspectMissing
      ? status("not-installed", "Not installed", "The OpenPets OpenClaw plugin is not installed.", input.version)
      : status("indeterminate", "Status unavailable", "OpenClaw did not return a structured OpenPets plugin inspection.", input.version);
  }
  if (!inspected || inspected.invalid) return status("invalid", "Invalid installation", "OpenClaw returned incomplete or invalid OpenPets plugin metadata.", input.version);
  if (inspected.install === undefined) return status("invalid", "Invalid installation", "OpenClaw did not report the installed OpenPets plugin source.", input.version, inspected.version, "untracked");
  const sourceCategory = classifyInstallSource(inspected.install);
  if (sourceCategory !== "official-package") return status("conflict", "Installation conflict", "The openpets plugin id is owned by a different or untracked source.", input.version, inspected.version, sourceCategory);
  if (inspected.status === "error" || listed.plugin?.requiredInstalled === false || inspected.requiredInstalled === false) return status("invalid", "Invalid installation", "OpenClaw reports that the installed OpenPets plugin cannot load its dependencies.", input.version, inspected.version, sourceCategory);
  const enabled = listed.plugin?.enabled ?? inspected.enabled;
  if (enabled === undefined) return status("invalid", "Invalid installation", "OpenClaw did not report whether the installed OpenPets plugin is enabled.", input.version, inspected.version, sourceCategory);
  return status(enabled ? "installed-enabled" : "installed-disabled", enabled ? "Installed and enabled" : "Installed but disabled", enabled ? "OpenClaw has the owned OpenPets plugin enabled." : "OpenClaw has the owned OpenPets plugin installed but disabled.", input.version, inspected.version, sourceCategory);
}

export function planOpenClawMutation(status: OpenClawPluginStatus, mutation: OpenClawMutation, targetVersion: string): readonly OpenClawCommandAction[] {
  if (status.state === "unsupported-host" || status.state === "management-disabled" || status.state === "unavailable" || status.state === "invalid" || status.state === "conflict" || status.state === "indeterminate") return [];
  if (mutation === "remove") return status.state === "not-installed" ? [] : ["remove"];
  if (mutation === "configure") return status.state === "installed-enabled" && status.installedVersion === targetVersion ? [] : status.state === "installed-disabled" && status.installedVersion === targetVersion ? ["enable"] : [status.state === "not-installed" ? "install" : "update", "enable"];
  return status.state === "installed-enabled" && status.installedVersion === targetVersion ? [] : [status.state === "not-installed" ? "install" : "update", "enable"];
}

export function isSupportedOpenClawVersion(version: string): boolean {
  return compareVersions(version, openClawMinimumVersion) >= 0;
}

export function parseOpenClawVersion(output: string): string | undefined {
  return output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1];
}

function exactPackageSource(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.startsWith(`${openClawPackageName}@`) ? value : undefined;
}

function classifyInstallSource(value: unknown): OpenClawSourceCategory {
  if (!isRecord(value) || typeof value.source !== "string") return "untracked";
  if (value.source === "npm" && exactPackageSource(value.spec) !== undefined) return "official-package";
  return value.source === "npm" || value.source === "path" || value.source === "archive" || value.source === "clawhub" || value.source === "git" ? "custom-source" : "untracked";
}

export function parseOpenClawPluginList(value: unknown): OpenClawPluginListSnapshot | undefined {
  if (!isRecord(value) || !Array.isArray(value.plugins)) return undefined;
  const plugin = value.plugins.find((entry) => isRecord(entry) && (entry.id === openClawPluginId || entry.name === openClawPluginId));
  if (plugin === undefined) return {};
  if (!isRecord(plugin) || typeof plugin.enabled !== "boolean") return undefined;
  const dependencyStatus = plugin.dependencyStatus;
  if (dependencyStatus === undefined) return { plugin: { enabled: plugin.enabled } };
  if (!isRecord(dependencyStatus) || (dependencyStatus.requiredInstalled !== undefined && typeof dependencyStatus.requiredInstalled !== "boolean")) return undefined;
  return { plugin: { enabled: plugin.enabled, ...(typeof dependencyStatus.requiredInstalled === "boolean" ? { requiredInstalled: dependencyStatus.requiredInstalled } : {}) } };
}

function normalizeInspect(value: unknown): { readonly enabled?: boolean; readonly invalid: boolean; readonly status?: "loaded" | "disabled" | "error"; readonly requiredInstalled?: boolean; readonly install?: unknown; readonly version?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const plugin = value.plugin;
  if (!isRecord(plugin)) return undefined;
  if (plugin.id !== openClawPluginId && plugin.name !== openClawPluginId) return undefined;
  const status = plugin.status;
  const dependencyStatus = plugin.dependencyStatus;
  const invalidDependencyStatus = dependencyStatus !== undefined && (!isRecord(dependencyStatus) || (dependencyStatus.requiredInstalled !== undefined && typeof dependencyStatus.requiredInstalled !== "boolean"));
  return {
    invalid: (typeof plugin.id !== "string" && typeof plugin.name !== "string") || (status !== undefined && status !== "loaded" && status !== "disabled" && status !== "error") || invalidDependencyStatus,
    status: status === "loaded" || status === "disabled" || status === "error" ? status : undefined,
    requiredInstalled: isRecord(dependencyStatus) && typeof dependencyStatus.requiredInstalled === "boolean" ? dependencyStatus.requiredInstalled : undefined,
    enabled: typeof plugin.enabled === "boolean" ? plugin.enabled : undefined,
    install: value.install,
    version: typeof plugin.version === "string" ? plugin.version : isRecord(value.install) && typeof value.install.version === "string" ? value.install.version : isRecord(value.install) ? parseOwnedSpecVersion(value.install.spec) : undefined,
  };
}

function parseOwnedSpecVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.startsWith(`${openClawPackageName}@`) ? value.slice(`${openClawPackageName}@`.length) : undefined;
}

function status(state: OpenClawSetupState, label: string, details: string, version?: string, installedVersion?: string, trackedSource?: OpenClawSourceCategory): OpenClawPluginStatus {
  return { state, label, details, ...(version ? { version } : {}), ...(installedVersion ? { installedVersion } : {}), ...(trackedSource ? { trackedSource } : {}), canInstall: state === "not-installed", canUpdate: state === "not-installed" || state === "installed-disabled" || state === "installed-enabled", canEnable: state === "installed-disabled", canRemove: state === "installed-disabled" || state === "installed-enabled" };
}

function compareVersions(left: string, right: string): number {
  const a = left.split("-")[0]!.split(".").map(Number);
  const b = right.split("-")[0]!.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
