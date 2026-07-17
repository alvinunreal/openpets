import { allowedReactions } from "./local-ipc-protocol.js";

export const OPENPETS_PLUGIN_MANIFEST_FILENAME = "openpets.plugin.json";
export const openPetsPluginManifestFilename = OPENPETS_PLUGIN_MANIFEST_FILENAME;

export type PluginRuntime = "declarative";
export type KnownPluginRuntime = PluginRuntime | "javascript";
export type PluginPermission =
  | "pet:speak"
  | "pet:reaction"
  | "pet:move"
  | "timer"
  | "schedule"
  | "storage"
  | "status"
  | "commands"
  | "network"
  // SDK v3 permissions (manifestVersion 3 only)
  | "pet:interact"
  | "pet:pin"
  | "pet:animate"
  | "pet:speak:dynamic"
  | "pet:drop"
  | "pets:read"
  | "pets:manage"
  | "audio"
  | "events"
  | "ui:toast"
  | "ui:panel"
  | "ui:delivery"
  | "companion:context"
  | "notify"
  | "bus"
  | "ai"
  | "secrets"
  | "voice:speak"
  | "voice:listen"
  | "auth"
  | "files"
  | "system:openExternal"
  | "system:metrics"
  | "clipboard"
  | "network:write";
export type PluginJavascriptPermission = Exclude<PluginPermission, "timer">;
/** Permissions flagged sensitive in the UI (louder consent, global toggles). */
export const sensitivePluginPermissions: ReadonlySet<PluginPermission> = new Set(["voice:listen", "clipboard", "pet:speak:dynamic"]);
export type PluginIcon = "plugin" | "bell" | "timer" | "github" | "heart" | "sparkles" | "coffee" | "focus" | "droplet";
export type PluginConfigFieldType = "text" | "textarea" | "number" | "boolean" | "select" | "time" | "date" | "multiSelect" | "list" | "secret" | "sound";

/** Asset kinds a v3 plugin can declare and bundle. */
export type PluginAssetKind = "icons" | "images" | "svgs" | "sprites" | "sounds";
/** Manifest `assets` block: per-kind maps of asset name -> relative file path. */
export type PluginSpriteAsset = { path: string; frameWidth: number; frameHeight: number; frames: number; durationMs: number };
export type PluginAssetsDeclaration = Partial<Omit<Record<PluginAssetKind, Record<string, string>>, "sprites">> & { sprites?: Record<string, PluginSpriteAsset> };

export type PluginConfigField = {
  type: PluginConfigFieldType;
  label?: string;
  description?: string;
  default?: string | number | boolean | string[] | Array<Record<string, unknown>>;
  options?: Array<{ label: string; value: string; previewSprite?: string }>;
  presentation?: "sprite-grid";
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  maxItems?: number;
  itemSchema?: Record<string, PluginConfigField>;
};

export type PluginStringConfigRef = { config: string };
export type PluginAction = { type: "pet.speak"; message: string | PluginStringConfigRef } | { type: "pet.react"; reaction: string | PluginStringConfigRef };
export type PluginTimerEveryMinutes = number | { config: string };
export type PluginTrigger = { on: "timer"; everyMinutes: PluginTimerEveryMinutes; actions: PluginAction[] };

export type OpenPetsDeclarativePluginManifest = {
  manifestVersion: 1;
  id: string;
  name: string;
  description?: string;
  version: string;
  runtime: PluginRuntime;
  icon?: PluginIcon;
  permissions: PluginPermission[];
  configSchema?: Record<string, PluginConfigField>;
  triggers: PluginTrigger[];
};

export type OpenPetsJavascriptPluginManifest = {
  manifestVersion: 2 | 3;
  id: string;
  name: string;
  description?: string;
  version: string;
  runtime: "javascript";
  sdkVersion: string;
  entry: string;
  icon?: PluginIcon;
  permissions: PluginJavascriptPermission[];
  network?: { hosts: string[] };
  configSchema?: Record<string, PluginConfigField>;
  /** v3 only: bundled asset declarations (name -> relative path). */
  assets?: PluginAssetsDeclaration;
  /** v3 only: sandboxed panel pages (name -> relative .html path). */
  panels?: Record<string, string>;
};

export type OpenPetsPluginManifest = OpenPetsDeclarativePluginManifest | OpenPetsJavascriptPluginManifest;

export type PluginManifestValidationError = {
  path: string;
  code: string;
  message: string;
};

export type PluginManifestValidationResult =
  | { ok: true; manifest: OpenPetsPluginManifest; errors: [] }
  | { ok: false; errors: PluginManifestValidationError[] };

// "$schema" is tolerated everywhere so manifests can opt into editor validation.
const topLevelFields = new Set(["$schema", "manifestVersion", "id", "name", "description", "version", "runtime", "icon", "permissions", "configSchema", "triggers"]);
const jsTopLevelFields = new Set(["$schema", "manifestVersion", "id", "name", "description", "version", "runtime", "sdkVersion", "entry", "icon", "permissions", "network", "configSchema"]);
const jsV3TopLevelFields = new Set([...jsTopLevelFields, "assets", "panels"]);
const configFieldFields = new Set(["type", "label", "description", "default", "options", "presentation", "min", "max", "step", "maxLength", "maxItems", "itemSchema"]);
const configOptionFields = new Set(["label", "value", "previewSprite"]);
const triggerFields = new Set(["on", "everyMinutes", "actions"]);
const speakActionFields = new Set(["type", "message"]);
const reactActionFields = new Set(["type", "reaction"]);
const supportedConfigTypes = new Set(["text", "textarea", "number", "boolean", "select", "time", "date", "multiSelect", "list", "secret", "sound"]);
const deferredConfigTypes = new Set(["multi-select", "schedule", "connection"]);
const deferredConfigFeatures = new Set(["dynamicOptions"]);
const supportedPluginIcons = new Set(["plugin", "bell", "timer", "github", "heart", "sparkles", "coffee", "focus", "droplet"]);
export const pluginV3Permissions = [
  "pet:interact",
  "pet:pin",
  "pet:animate",
  "pet:speak:dynamic",
  "pet:drop",
  "pets:read",
  "pets:manage",
  "audio",
  "events",
  "ui:toast",
  "ui:panel",
  "ui:delivery",
  "companion:context",
  "notify",
  "bus",
  "ai",
  "secrets",
  "voice:speak",
  "voice:listen",
  "auth",
  "files",
  "system:openExternal",
  "system:metrics",
  "clipboard",
  "network:write",
] as const satisfies readonly PluginPermission[];
export const pluginPermissions = ["pet:speak", "pet:reaction", "pet:move", "timer", "schedule", "storage", "status", "commands", "network", ...pluginV3Permissions] as const satisfies readonly PluginPermission[];
const javascriptPluginPermissionsV2 = ["pet:speak", "pet:reaction", "pet:move", "schedule", "storage", "status", "commands", "network"] as const satisfies readonly PluginJavascriptPermission[];
const javascriptPluginPermissionsV3 = [...javascriptPluginPermissionsV2, ...pluginV3Permissions] as const satisfies readonly PluginJavascriptPermission[];
export const pluginPermissionSet: ReadonlySet<string> = new Set(pluginPermissions);
const declarativePluginPermissionSet: ReadonlySet<string> = new Set(["pet:speak", "pet:reaction", "timer"]);
const pluginAssetKinds = ["icons", "images", "svgs", "sprites", "sounds"] as const satisfies readonly PluginAssetKind[];
const pluginAssetExtensions: Record<PluginAssetKind, readonly string[]> = {
  icons: [".png", ".webp", ".svg"],
  images: [".png", ".webp", ".jpg", ".jpeg", ".gif"],
  svgs: [".svg"],
  sprites: [".webp"],
  sounds: [".ogg", ".mp3", ".wav"],
};
/** Per-file size caps enforced when asset files are published/installed. */
export const pluginAssetMaxBytes: Record<PluginAssetKind, number> = {
  icons: 256 * 1024,
  images: 1024 * 1024,
  svgs: 256 * 1024,
  sprites: 5 * 1024 * 1024,
  sounds: 1024 * 1024,
};
export const pluginPanelMaxBytes = 1024 * 1024;
const assetNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function canonicalizePluginPermissions(value: unknown): PluginPermission[] {
  if (!Array.isArray(value)) throw new Error("Plugin permissions must be an array.");
  const seen = new Set<string>();
  for (const permission of value) {
    if (typeof permission !== "string" || !pluginPermissionSet.has(permission)) throw new Error(`Invalid plugin permission: ${String(permission)}`);
    if (seen.has(permission)) throw new Error(`Duplicate plugin permission: ${permission}`);
    seen.add(permission);
  }
  return pluginPermissions.filter((permission) => seen.has(permission));
}

export function validatePluginManifest(input: unknown): PluginManifestValidationResult {
  const errors: PluginManifestValidationError[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: "$", code: "invalid_manifest", message: "Plugin manifest must be a JSON object." }] };
  }

  if (input.manifestVersion === 2 || input.manifestVersion === 3) return validateJavascriptPluginManifest(input, input.manifestVersion);

  rejectUnknownFields(input, topLevelFields, "$", errors);
  if (input.manifestVersion !== 1) addError(errors, "$.manifestVersion", "invalid_manifest_version", "manifestVersion must be 1, 2, or 3.");
  validateString(input.id, "$.id", "id", errors, /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/);
  validateString(input.name, "$.name", "name", errors);
  if (input.description !== undefined) validateString(input.description, "$.description", "description", errors);
  validateString(input.version, "$.version", "version", errors, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  validatePluginIcon(input.icon, errors);

  if (input.runtime === "javascript") {
    addError(errors, "$.runtime", "unsupported_runtime", 'Runtime "javascript" is recognized but unsupported in manifest v1. Use "declarative".');
  } else if (input.runtime !== "declarative") {
    addError(errors, "$.runtime", "invalid_runtime", 'runtime must be "declarative".');
  }

  const permissions = validatePermissions(input.permissions, errors, declarativePluginPermissionSet);
  const configFields = validateConfigSchema(input.configSchema, errors);
  validateTriggers(input.triggers, permissions, configFields, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: input as OpenPetsPluginManifest, errors: [] };
}

function validateJavascriptPluginManifest(input: Record<string, unknown>, manifestVersion: 2 | 3): PluginManifestValidationResult {
  const errors: PluginManifestValidationError[] = [];
  rejectUnknownFields(input, manifestVersion === 3 ? jsV3TopLevelFields : jsTopLevelFields, "$", errors);
  validateString(input.id, "$.id", "id", errors, /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/);
  validateString(input.name, "$.name", "name", errors);
  if (input.description !== undefined) validateString(input.description, "$.description", "description", errors);
  validateString(input.version, "$.version", "version", errors, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  validatePluginIcon(input.icon, errors);
  if (input.runtime !== "javascript") addError(errors, "$.runtime", "invalid_runtime", `manifestVersion ${manifestVersion} runtime must be "javascript".`);
  validateString(input.sdkVersion, "$.sdkVersion", "sdkVersion", errors, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  if (manifestVersion === 3 && typeof input.sdkVersion === "string" && !input.sdkVersion.startsWith("3.")) {
    addError(errors, "$.sdkVersion", "invalid_sdk_version", "manifestVersion 3 requires sdkVersion 3.x.y.");
  }
  validateEntryPath(input.entry, errors);
  validateJavascriptPermissions(input.permissions, manifestVersion, errors);
  validateConfigSchema(input.configSchema, errors, manifestVersion);
  validateNetwork(input.network, errors);
  if (manifestVersion === 3) {
    validateAssets(input.assets, errors);
    validateSpriteGridPreviews(input.configSchema, input.assets, errors);
    validatePanels(input.panels, errors);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: input as OpenPetsPluginManifest, errors: [] };
}

function validateSpriteGridPreviews(schema: unknown, assets: unknown, errors: PluginManifestValidationError[]): void {
  if (!isRecord(schema) || !isRecord(assets) || !isRecord(assets.sprites)) return;
  for (const [fieldName, field] of Object.entries(schema)) {
    if (!isRecord(field) || field.presentation !== "sprite-grid" || !Array.isArray(field.options)) continue;
    for (const [index, option] of field.options.entries()) {
      if (!isRecord(option) || typeof option.previewSprite !== "string" || !Object.prototype.hasOwnProperty.call(assets.sprites, option.previewSprite)) addError(errors, `$.configSchema.${fieldName}.options[${index}].previewSprite`, "invalid_preview_sprite", "sprite-grid options must reference a declared sprite.");
    }
  }
}

function validateJavascriptPermissions(value: unknown, manifestVersion: 2 | 3, errors: PluginManifestValidationError[]): Set<string> {
  const allowed = new Set<string>(manifestVersion === 3 ? javascriptPluginPermissionsV3 : javascriptPluginPermissionsV2);
  const permissions = validatePermissions(value, errors);
  for (const permission of permissions) if (!allowed.has(permission)) addError(errors, "$.permissions", "invalid_permission", `Permission ${permission} is not valid for manifestVersion ${manifestVersion} javascript plugins.`);
  return permissions;
}

function validateRelativeAssetPath(value: unknown, allowedExtensions: readonly string[], path: string, errors: PluginManifestValidationError[]): void {
  if (typeof value !== "string" || value.trim() === "") return addError(errors, path, "invalid_asset_path", "Asset path must be a non-empty string.");
  if (value.startsWith("/") || value.includes("\\") || value.split("/").includes("..") || value.split("/").includes(".")) {
    return addError(errors, path, "invalid_asset_path", "Asset path must be a safe relative path.");
  }
  if (!allowedExtensions.some((extension) => value.toLowerCase().endsWith(extension))) {
    addError(errors, path, "invalid_asset_format", `Asset must end with one of ${allowedExtensions.join(", ")}.`);
  }
}

function validateAssets(value: unknown, errors: PluginManifestValidationError[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) return addError(errors, "$.assets", "invalid_assets", "assets must be an object.");
  rejectUnknownFields(value, new Set(pluginAssetKinds), "$.assets", errors);
  for (const kind of pluginAssetKinds) {
    const group = value[kind];
    if (group === undefined) continue;
    if (!isRecord(group)) { addError(errors, `$.assets.${kind}`, "invalid_assets", `assets.${kind} must be an object.`); continue; }
    const entries = Object.entries(group);
    if (entries.length > 32) addError(errors, `$.assets.${kind}`, "too_many_assets", `assets.${kind} may declare at most 32 entries.`);
    for (const [name, assetValue] of entries) {
      const path = `$.assets.${kind}.${name}`;
      if (!assetNamePattern.test(name)) addError(errors, path, "invalid_asset_name", "Asset names must be simple lowercase identifiers.");
      if (kind !== "sprites") validateRelativeAssetPath(assetValue, pluginAssetExtensions[kind], path, errors);
      else validateSpriteAsset(assetValue, path, errors);
    }
  }
}

function validateSpriteAsset(value: unknown, path: string, errors: PluginManifestValidationError[]): void {
  if (!isRecord(value)) { addError(errors, path, "invalid_sprite", "Sprite assets must declare path and frame metadata."); return; }
  rejectUnknownFields(value, new Set(["path", "frameWidth", "frameHeight", "frames", "durationMs"]), path, errors);
  validateRelativeAssetPath(value.path, pluginAssetExtensions.sprites, `${path}.path`, errors);
  for (const [key, min, max] of [["frameWidth", 32, 512], ["frameHeight", 32, 512], ["frames", 1, 16], ["durationMs", 100, 4000]] as const) {
    if (typeof value[key] !== "number" || !Number.isInteger(value[key]) || value[key] < min || value[key] > max) addError(errors, `${path}.${key}`, "invalid_sprite_metadata", `${key} must be an integer between ${min} and ${max}.`);
  }
}

function validatePanels(value: unknown, errors: PluginManifestValidationError[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) return addError(errors, "$.panels", "invalid_panels", "panels must be an object.");
  const entries = Object.entries(value);
  if (entries.length > 8) addError(errors, "$.panels", "too_many_panels", "panels may declare at most 8 entries.");
  for (const [name, panelPath] of entries) {
    const path = `$.panels.${name}`;
    if (!assetNamePattern.test(name)) addError(errors, path, "invalid_panel_name", "Panel names must be simple lowercase identifiers.");
    validateRelativeAssetPath(panelPath, [".html"], path, errors);
  }
}

function validatePluginIcon(value: unknown, errors: PluginManifestValidationError[]): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !supportedPluginIcons.has(value)) addError(errors, "$.icon", "invalid_icon", "icon must be one of plugin, bell, timer, github, heart, sparkles, coffee, focus, or droplet.");
}

function validateEntryPath(value: unknown, errors: PluginManifestValidationError[]): void {
  validateString(value, "$.entry", "entry", errors);
  if (typeof value !== "string") return;
  if (value.startsWith("/") || value.includes("\\") || value.split("/").includes("..") || !/\.(?:mjs|js)$/.test(value)) addError(errors, "$.entry", "invalid_entry", "entry must be a relative .js or .mjs path.");
}

function validateNetwork(value: unknown, errors: PluginManifestValidationError[]): void {
  if (value === undefined) return;
  if (!isRecord(value) || !Array.isArray(value.hosts)) return addError(errors, "$.network.hosts", "invalid_network_hosts", "network.hosts must be an array.");
  rejectUnknownFields(value, new Set(["hosts"]), "$.network", errors);
  const seen = new Set<string>();
  value.hosts.forEach((host, index) => {
    if (typeof host !== "string" || !/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host) || host.includes("*") || host.trim() !== host) addError(errors, `$.network.hosts[${index}]`, "invalid_network_host", "network hosts must be exact host names.");
    else if (seen.has(host)) addError(errors, `$.network.hosts[${index}]`, "duplicate_network_host", "Duplicate network host.");
    seen.add(String(host));
  });
}

function validatePermissions(value: unknown, errors: PluginManifestValidationError[], allowedPermissions: ReadonlySet<string> = pluginPermissionSet): Set<string> {
  const permissions = new Set<string>();
  if (!Array.isArray(value)) {
    addError(errors, "$.permissions", "invalid_permissions", "permissions must be an array.");
    return permissions;
  }
  value.forEach((permission, index) => {
    if (typeof permission !== "string" || !allowedPermissions.has(permission)) {
      addError(errors, `$.permissions[${index}]`, "invalid_permission", `Permission must be one of ${[...allowedPermissions].join(", ")}.`);
      return;
    }
    if (permissions.has(permission)) {
      addError(errors, `$.permissions[${index}]`, "duplicate_permission", `Duplicate permission ${permission}.`);
      return;
    }
    permissions.add(permission);
  });
  return permissions;
}

type ConfigFieldSets = { text: Set<string>; select: Set<string>; number: Set<string>; schema: Record<string, unknown> };

function validateConfigSchema(value: unknown, errors: PluginManifestValidationError[], manifestVersion: 1 | 2 | 3 = 1): ConfigFieldSets {
  const fields: ConfigFieldSets = { text: new Set(), select: new Set(), number: new Set(), schema: isRecord(value) ? value : {} };
  if (value === undefined) return fields;
  if (!isRecord(value)) {
    addError(errors, "$.configSchema", "invalid_config_schema", "configSchema must be an object.");
    return fields;
  }
  const v3OnlyTypes = new Set(["date", "secret", "sound"]);
  for (const [key, field] of Object.entries(value)) {
    const path = `$.configSchema.${key}`;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) addError(errors, path, "invalid_config_key", "Config field keys must be simple identifiers.");
    if (!isRecord(field)) {
      addError(errors, path, "invalid_config_field", "Config field must be an object.");
      continue;
    }
    rejectUnknownFields(field, configFieldFields, path, errors);
    for (const feature of deferredConfigFeatures) {
      if (Object.prototype.hasOwnProperty.call(field, feature)) addError(errors, `${path}.${feature}`, "deferred_config_feature", `${feature} is deferred and unsupported in v1.`);
    }
    const typeUnsupported = typeof field.type !== "string" || !supportedConfigTypes.has(field.type) || (manifestVersion < 3 && v3OnlyTypes.has(field.type));
    if (typeUnsupported) {
      const code = typeof field.type === "string" && (deferredConfigTypes.has(field.type) || (manifestVersion < 3 && v3OnlyTypes.has(field.type))) ? "deferred_config_type" : "invalid_config_type";
      addError(errors, `${path}.type`, code, "Config field type is not supported for this manifest version.");
    } else {
      validateConfigFieldSemantics(field, path, errors, manifestVersion);
      if (field.type === "number") fields.number.add(key);
      if (field.type === "text") fields.text.add(key);
      if (field.type === "select") fields.select.add(key);
    }
  }
  return fields;
}

function validateConfigFieldSemantics(field: Record<string, unknown>, path: string, errors: PluginManifestValidationError[], manifestVersion: 1 | 2 | 3 = 1): void {
  if (field.label !== undefined) validateString(field.label, `${path}.label`, "label", errors);
  if (field.description !== undefined) validateString(field.description, `${path}.description`, "description", errors);
  if (field.type !== "select" && field.type !== "multiSelect" && field.options !== undefined) addError(errors, `${path}.options`, "invalid_options", "options are only valid for select config fields.");
  if ((field.type === "text" || field.type === "textarea") && field.default !== undefined && typeof field.default !== "string") addError(errors, `${path}.default`, "invalid_default", "Default must be a string.");
  if (field.type === "number" && field.default !== undefined && (typeof field.default !== "number" || !Number.isFinite(field.default))) addError(errors, `${path}.default`, "invalid_default", "Default must be a finite number.");
  if (field.type === "boolean" && field.default !== undefined && typeof field.default !== "boolean") addError(errors, `${path}.default`, "invalid_default", "Default must be a boolean.");
  if (field.type === "time" && field.default !== undefined && (typeof field.default !== "string" || !isValidTime(field.default))) addError(errors, `${path}.default`, "invalid_default", "Default must be HH:mm between 00:00 and 23:59.");
  if (field.type === "date" && field.default !== undefined && (typeof field.default !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(field.default))) addError(errors, `${path}.default`, "invalid_default", "Default must be YYYY-MM-DD.");
  if (field.type === "secret" && field.default !== undefined) addError(errors, `${path}.default`, "invalid_default", "Secret config fields must not declare defaults.");
  if (field.presentation !== undefined && (field.type !== "select" || field.presentation !== "sprite-grid")) addError(errors, `${path}.presentation`, "invalid_presentation", "sprite-grid presentation is only valid for select fields.");
  if (field.type === "select" || field.type === "multiSelect") validateSelectField(field, path, errors);
  if (field.type === "list") {
    if (field.maxItems !== undefined && (typeof field.maxItems !== "number" || !Number.isInteger(field.maxItems) || field.maxItems < 0)) addError(errors, `${path}.maxItems`, "invalid_max_items", "maxItems must be a non-negative integer.");
    if (field.itemSchema !== undefined) validateConfigSchema(field.itemSchema, errors, manifestVersion);
  }
}

function isValidTime(value: string): boolean { const m = /^(\d{2}):(\d{2})$/.exec(value); return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59; }

function validateSelectField(field: Record<string, unknown>, path: string, errors: PluginManifestValidationError[]): void {
  if (!Array.isArray(field.options) || field.options.length === 0) {
    addError(errors, `${path}.options`, "invalid_options", "select config fields must have non-empty options.");
    return;
  }
  const values = validateOptions(field.options, path, errors);
  if (field.default !== undefined) {
    if (field.type === "multiSelect") {
      if (!Array.isArray(field.default) || field.default.some((item) => typeof item !== "string" || !values.has(item))) addError(errors, `${path}.default`, "invalid_default", "Multi-select default must match option values.");
    } else if (typeof field.default !== "string") addError(errors, `${path}.default`, "invalid_default", "Select default must be a string.");
    else if (!values.has(field.default)) addError(errors, `${path}.default`, "invalid_default", "Select default must match one of the option values.");
  }
}

function validateOptions(value: unknown, path: string, errors: PluginManifestValidationError[]): Set<string> {
  const values = new Set<string>();
  if (!Array.isArray(value)) {
    addError(errors, `${path}.options`, "invalid_options", "options must be an array.");
    return values;
  }
  value.forEach((option, index) => {
    const optionPath = `${path}.options[${index}]`;
    if (!isRecord(option)) return addError(errors, optionPath, "invalid_option", "Option must be an object.");
    rejectUnknownFields(option, configOptionFields, optionPath, errors);
    validateString(option.label, `${optionPath}.label`, "option label", errors);
    validateString(option.value, `${optionPath}.value`, "option value", errors);
    if (option.previewSprite !== undefined && (typeof option.previewSprite !== "string" || !assetNamePattern.test(option.previewSprite))) addError(errors, `${optionPath}.previewSprite`, "invalid_preview_sprite", "previewSprite must be a declared sprite name.");
    if (typeof option.value === "string" && option.value.trim() !== "") {
      if (values.has(option.value)) addError(errors, `${optionPath}.value`, "duplicate_option_value", `Duplicate option value ${option.value}.`);
      values.add(option.value);
    }
  });
  return values;
}

function validateTriggers(value: unknown, permissions: Set<string>, configFields: ConfigFieldSets, errors: PluginManifestValidationError[]): void {
  if (!Array.isArray(value)) return addError(errors, "$.triggers", "invalid_triggers", "triggers must be an array.");
  value.forEach((trigger, index) => {
    const path = `$.triggers[${index}]`;
    if (!isRecord(trigger)) return addError(errors, path, "invalid_trigger", "Trigger must be an object.");
    rejectUnknownFields(trigger, triggerFields, path, errors);
    if (trigger.on !== "timer") addError(errors, `${path}.on`, "invalid_trigger", 'Only timer triggers are supported in v1.');
    requirePermission(permissions, "timer", path, errors);
    validateEveryMinutes(trigger.everyMinutes, configFields.number, `${path}.everyMinutes`, errors);
    if (!Array.isArray(trigger.actions)) return addError(errors, `${path}.actions`, "invalid_actions", "actions must be an array.");
    trigger.actions.forEach((action, actionIndex) => validateAction(action, permissions, configFields, `${path}.actions[${actionIndex}]`, errors));
  });
}

function validateEveryMinutes(value: unknown, numberConfigFields: Set<string>, path: string, errors: PluginManifestValidationError[]): void {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 5) addError(errors, path, "invalid_timer_interval", "Timer interval must be an integer of at least 5 minutes.");
    return;
  }
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.prototype.hasOwnProperty.call(value, "config") || typeof value.config !== "string") {
    addError(errors, path, "invalid_timer_interval", "Timer interval must be an integer or { config: string }.");
    return;
  }
  if (!numberConfigFields.has(value.config)) addError(errors, `${path}.config`, "invalid_timer_config_reference", "Timer config reference must point to a number config field.");
}

function validateStringOrConfigRef(value: unknown, allowedFields: Set<string>, path: string, label: string, fieldType: string, errors: PluginManifestValidationError[]): void {
  if (typeof value === "string") return validateString(value, path, label, errors);
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.prototype.hasOwnProperty.call(value, "config") || typeof value.config !== "string") {
    addError(errors, path, "invalid_config_reference", `${label} must be a non-empty string or { config: string }.`);
    return;
  }
  if (!allowedFields.has(value.config)) addError(errors, `${path}.config`, "invalid_config_reference", `${label} config reference must point to a ${fieldType} config field.`);
}

function validateReactionSelectReference(schema: Record<string, unknown>, fieldName: string, path: string, errors: PluginManifestValidationError[]): void {
  if (!Object.prototype.hasOwnProperty.call(schema, fieldName)) return;
  const field = schema[fieldName];
  if (!isRecord(field) || field.type !== "select") return;
  const reactions = new Set<string>(allowedReactions);
  if (!Object.prototype.hasOwnProperty.call(field, "default") || typeof field.default !== "string" || !reactions.has(field.default)) {
    addError(errors, `${path}.config`, "invalid_reaction_config_reference", "Reaction select config must have a valid OpenPets reaction default.");
  }
  if (Array.isArray(field.options)) {
    for (const option of field.options) {
      if (isRecord(option) && typeof option.value === "string" && !reactions.has(option.value)) addError(errors, `${path}.config`, "invalid_reaction_config_reference", "Reaction select options must be valid OpenPets reactions.");
    }
  }
}

function validateAction(value: unknown, permissions: Set<string>, configFields: ConfigFieldSets, path: string, errors: PluginManifestValidationError[]): void {
  if (!isRecord(value)) return addError(errors, path, "invalid_action", "Action must be an object.");
  if (value.type === "pet.speak") {
    rejectUnknownFields(value, speakActionFields, path, errors);
    validateStringOrConfigRef(value.message, configFields.text, `${path}.message`, "message", "text", errors);
    requirePermission(permissions, "pet:speak", path, errors);
  } else if (value.type === "pet.react") {
    rejectUnknownFields(value, reactActionFields, path, errors);
    validateStringOrConfigRef(value.reaction, configFields.select, `${path}.reaction`, "reaction", "select", errors);
    if (isRecord(value.reaction) && typeof value.reaction.config === "string" && configFields.select.has(value.reaction.config)) validateReactionSelectReference(configFields.schema, value.reaction.config, `${path}.reaction`, errors);
    requirePermission(permissions, "pet:reaction", path, errors);
  } else {
    addError(errors, `${path}.type`, "invalid_action", "Action type must be pet.speak or pet.react.");
  }
}

function requirePermission(permissions: Set<string>, permission: string, path: string, errors: PluginManifestValidationError[]): void {
  if (!permissions.has(permission)) addError(errors, path, "missing_permission", `Missing required permission ${permission}.`);
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: Set<string>, path: string, errors: PluginManifestValidationError[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) addError(errors, `${path}.${key}`, "unknown_field", `Unknown field ${key}.`);
  }
}

function validateString(value: unknown, path: string, label: string, errors: PluginManifestValidationError[], pattern?: RegExp): void {
  if (typeof value !== "string" || value.trim() === "") return addError(errors, path, "invalid_string", `${label} must be a non-empty string.`);
  if (pattern && !pattern.test(value)) addError(errors, path, "invalid_format", `${label} has an invalid format.`);
}

function addError(errors: PluginManifestValidationError[], path: string, code: string, message: string): void {
  errors.push({ path, code, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
