#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { validateSpriteAssetBytes } from "./plugin-sprite-validation.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestFilename = "openpets.plugin.json";
const supportedLocales = ["en", "ja", "ko", "zh-Hans", "zh-Hant", "pt-BR", "es-419"];
const supportedLocaleSet = new Set(supportedLocales);
const manifestFields = new Set([
  "$schema", "manifestVersion", "id", "name", "description", "version", "runtime", "sdkVersion", "entry", "icon",
  "permissions", "network", "configSchema", "assets", "panels",
]);
const supportedIcons = new Set(["plugin", "bell", "timer", "github", "heart", "sparkles", "coffee", "focus", "droplet"]);
const permissionOrder = [
  "pet:speak", "pet:reaction", "pet:move", "schedule", "storage", "status", "commands", "network", "pet:interact", "pet:pin",
  "pet:animate", "pet:speak:dynamic", "pet:drop", "pets:read", "pets:manage", "audio", "events", "ui:toast", "ui:panel",
  "ui:delivery", "companion:context", "notify", "bus", "ai", "secrets", "voice:speak", "voice:listen", "auth", "files",
  "system:openExternal", "system:metrics", "clipboard", "network:write",
];
const permissionSet = new Set(permissionOrder);
const catalogPermissionSet = new Set([...permissionOrder, "timer"]);
const assetRules = {
  icons: { extensions: [".png", ".webp", ".svg"], maxBytes: 256 * 1024 },
  images: { extensions: [".png", ".webp", ".jpg", ".jpeg", ".gif"], maxBytes: 1024 * 1024 },
  svgs: { extensions: [".svg"], maxBytes: 256 * 1024 },
  sprites: { extensions: [".webp"], maxBytes: 5 * 1024 * 1024 },
  sounds: { extensions: [".ogg", ".mp3", ".wav"], maxBytes: 1024 * 1024 },
};
const configFieldTypes = new Set(["text", "textarea", "number", "boolean", "select", "time", "date", "multiSelect", "list", "secret", "sound"]);
const configFieldFields = new Set(["type", "label", "description", "default", "options", "presentation", "min", "max", "step", "maxLength", "maxItems", "itemSchema"]);
const configOptionFields = new Set(["label", "value", "previewSprite"]);
const idPattern = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const assetNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const hostPattern = /^[a-z0-9.-]+(?::\d{1,5})?$/;
const maxManifestBytes = 64 * 1024;
const maxEntryBytes = 1024 * 1024;
const maxLocaleBytes = 256 * 1024;
const maxPanelBytes = 1024 * 1024;
const maxZipEntries = 2 + supportedLocales.length + 32 * 5 + 8;
const maxUncompressedBytes = 32 * 1024 * 1024;
const maxZipBytes = 16 * 1024 * 1024;
const maxReviewedTreeBytes = 64 * 1024 * 1024;
const windowsDeviceNamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const windowsInvalidSegmentCharacterPattern = /[<>:"|?*\u0000-\u001f]/;
const catalogFields = new Set(["version", "generatedAt", "plugins"]);
const catalogEntryFields = new Set([
  "id", "name", "version", "description", "runtime", "icon", "permissions", "downloadUrl", "sha256",
  "minOpenPetsVersion", "iconDataUrl", "sdkVersion", "maxOpenPetsVersion", "disabled", "deprecated",
  "statusReason", "network", "publisherType",
]);
const iconDataUrlPattern = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertOnlyKeys(record, allowed, label) {
  for (const key of Object.keys(record)) assert(allowed.has(key), `${label} contains unknown field ${key}.`);
}

export function validateSafeRelativePath(value, label = "path") {
  assert(typeof value === "string" && value.length > 0 && value.length <= 512, `${label} must be a non-empty relative path.`);
  assert(!value.includes("\\") && !value.includes("\0") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value), `${label} is not a safe relative path: ${value}`);
  const normalized = posix.normalize(value);
  assert(normalized === value && normalized !== "." && !normalized.startsWith("../") && !normalized.includes("/../") && !normalized.endsWith("/"), `${label} is not a safe relative path: ${value}`);
  for (const segment of value.split("/")) {
    assert(segment.length > 0 && !segment.endsWith(".") && !segment.endsWith(" "), `${label} contains a Windows-unsafe path segment: ${segment}`);
    assert(!windowsInvalidSegmentCharacterPattern.test(segment) && !windowsDeviceNamePattern.test(segment), `${label} contains a Windows-unsafe path segment: ${segment}`);
  }
  return value;
}

function comparePortableStrings(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isUnder(root, target) {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !rel.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(rel);
}

function isWithin(root, target) {
  return root === target || isUnder(root, target);
}

async function validateRealDirectory(path, label) {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  assert(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a real directory.`);
  return realpath(absolute);
}

async function readSafeFile(root, relPath, maxBytes, label) {
  validateSafeRelativePath(relPath, label);
  const expected = resolve(root, ...relPath.split("/"));
  assert(isUnder(root, expected) && expected !== root, `${label} escapes the plugin directory.`);
  const info = await lstat(expected);
  assert(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file (symbolic links are not allowed).`);
  assert(info.size <= maxBytes, `${label} exceeds ${maxBytes} bytes.`);
  assert(await realpath(expected) === expected, `${label} must not traverse a symbolic link.`);
  return readFile(expected);
}

function flattenLocale(value, prefix = "", out = {}) {
  assert(isRecord(value), `${prefix || "locale"} must be a JSON object.`);
  for (const [key, entry] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (isRecord(entry)) flattenLocale(entry, fullKey, out);
    else {
      assert(typeof entry === "string", `Locale key ${fullKey} must be a string.`);
      out[fullKey] = entry;
    }
  }
  return out;
}

function resolveManifestText(locale, value, label, maxLength) {
  assert(typeof value === "string" && value.trim() !== "", `${label} must be a non-empty string.`);
  const resolved = value.startsWith("$t:") ? locale[value.slice(3)] : value;
  assert(typeof resolved === "string" && resolved.trim() !== "" && !resolved.includes("$t:"), `${label} cannot be resolved from locales/en.json.`);
  assert(resolved.length <= maxLength, `${label} exceeds ${maxLength} characters.`);
  return resolved;
}

function sanitizeSvgText(svg) {
  return svg
    .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, "")
    .replace(/<foreignObject\b[\s\S]*?(?:<\/foreignObject\s*>|$)/gi, "")
    .replace(/<!ENTITY[\s\S]*?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/\s(href|xlink:href)\s*=\s*"(?!#)[^"]*"/gi, "")
    .replace(/\s(href|xlink:href)\s*=\s*'(?!#)[^']*'/gi, "")
    .replace(/@import[^;]*;/gi, "")
    .replace(/url\(\s*(?!['"]?#)[^)]*\)/gi, "none");
}

const panelCsp = "default-src 'none'; script-src 'unsafe-inline' file:; style-src 'unsafe-inline' file:; img-src file: data:; media-src file: data:; font-src file: data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'";

function injectPanelCsp(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${panelCsp}">`;
  const withoutExisting = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi, "");
  if (/<head[^>]*>/i.test(withoutExisting)) return withoutExisting.replace(/<head[^>]*>/i, (match) => `${match}${meta}`);
  if (/<html[^>]*>/i.test(withoutExisting)) return withoutExisting.replace(/<html[^>]*>/i, (match) => `${match}<head>${meta}</head>`);
  return `${meta}${withoutExisting}`;
}

function assertOptionalNonEmptyString(value, label) {
  if (value !== undefined) assert(typeof value === "string" && value.trim() !== "", `${label} must be a non-empty string.`);
}

function isValidTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return Boolean(match) && Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

function validateConfigOptions(field, path) {
  assert(Array.isArray(field.options) && field.options.length > 0, `${path}.options must be a non-empty array.`);
  const values = new Set();
  field.options.forEach((option, index) => {
    const optionPath = `${path}.options[${index}]`;
    assert(isRecord(option), `${optionPath} must be an object.`);
    assertOnlyKeys(option, configOptionFields, optionPath);
    assert(typeof option.label === "string" && option.label.trim() !== "", `${optionPath}.label must be a non-empty string.`);
    assert(typeof option.value === "string" && option.value.trim() !== "", `${optionPath}.value must be a non-empty string.`);
    assert(!values.has(option.value), `${optionPath}.value duplicates option value ${option.value}.`);
    values.add(option.value);
    if (option.previewSprite !== undefined) assert(typeof option.previewSprite === "string" && assetNamePattern.test(option.previewSprite), `${optionPath}.previewSprite must be a valid sprite name.`);
  });
  if (field.default === undefined) return;
  if (field.type === "multiSelect") {
    assert(Array.isArray(field.default) && field.default.every((value) => typeof value === "string" && values.has(value)), `${path}.default must contain only declared option values.`);
  } else {
    assert(typeof field.default === "string" && values.has(field.default), `${path}.default must match a declared option value.`);
  }
}

function validateConfigSchemaValue(schema, pluginId, path = `${pluginId}: configSchema`) {
  assert(isRecord(schema), `${path} must be an object.`);
  for (const [key, field] of Object.entries(schema)) {
    const fieldPath = `${path}.${key}`;
    assert(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key), `${fieldPath} has an invalid config field key.`);
    assert(isRecord(field), `${fieldPath} must be an object.`);
    assertOnlyKeys(field, configFieldFields, fieldPath);
    assert(typeof field.type === "string" && configFieldTypes.has(field.type), `${fieldPath}.type is not supported.`);
    assertOptionalNonEmptyString(field.label, `${fieldPath}.label`);
    assertOptionalNonEmptyString(field.description, `${fieldPath}.description`);
    assert(field.type === "select" || field.type === "multiSelect" || field.options === undefined, `${fieldPath}.options are only valid for select fields.`);
    if ((field.type === "text" || field.type === "textarea") && field.default !== undefined) assert(typeof field.default === "string", `${fieldPath}.default must be a string.`);
    if (field.type === "number" && field.default !== undefined) assert(typeof field.default === "number" && Number.isFinite(field.default), `${fieldPath}.default must be a finite number.`);
    if (field.type === "boolean" && field.default !== undefined) assert(typeof field.default === "boolean", `${fieldPath}.default must be a boolean.`);
    if (field.type === "time" && field.default !== undefined) assert(typeof field.default === "string" && isValidTime(field.default), `${fieldPath}.default must be HH:mm between 00:00 and 23:59.`);
    if (field.type === "date" && field.default !== undefined) assert(typeof field.default === "string" && /^\d{4}-\d{2}-\d{2}$/.test(field.default), `${fieldPath}.default must be YYYY-MM-DD.`);
    if (field.type === "secret") assert(field.default === undefined, `${fieldPath} must not declare a default.`);
    if (field.presentation !== undefined) assert(field.type === "select" && field.presentation === "sprite-grid", `${fieldPath}.presentation is only valid as sprite-grid on select fields.`);
    if (field.type === "select" || field.type === "multiSelect") validateConfigOptions(field, fieldPath);
    if (field.type === "list") {
      if (field.maxItems !== undefined) assert(Number.isInteger(field.maxItems) && field.maxItems >= 0, `${fieldPath}.maxItems must be a non-negative integer.`);
      if (field.itemSchema !== undefined) validateConfigSchemaValue(field.itemSchema, pluginId, `${fieldPath}.itemSchema`);
    }
  }
}

function validateConfigSchema(manifest) {
  if (manifest.configSchema !== undefined) validateConfigSchemaValue(manifest.configSchema, manifest.id);
}

function validatePermissions(manifest) {
  assert(Array.isArray(manifest.permissions), `${manifest.id}: permissions must be an array.`);
  const seen = new Set();
  for (const permission of manifest.permissions) {
    assert(typeof permission === "string" && permissionSet.has(permission), `${manifest.id}: invalid permission ${String(permission)}.`);
    assert(!seen.has(permission), `${manifest.id}: duplicate permission ${permission}.`);
    seen.add(permission);
  }
  assert(!seen.has("network:write") || seen.has("network"), `${manifest.id}: network:write requires network.`);
  return permissionOrder.filter((permission) => seen.has(permission));
}

function validateNetwork(manifest, permissions) {
  const hasNetwork = permissions.includes("network");
  assert(hasNetwork === (manifest.network !== undefined), `${manifest.id}: network.hosts must be present if and only if the network permission is declared.`);
  if (!hasNetwork) return undefined;
  assert(isRecord(manifest.network), `${manifest.id}: network must be an object.`);
  assertOnlyKeys(manifest.network, new Set(["hosts"]), `${manifest.id}: network`);
  assert(Array.isArray(manifest.network.hosts) && manifest.network.hosts.length > 0, `${manifest.id}: network.hosts must be a non-empty array.`);
  const hosts = [];
  const seen = new Set();
  for (const host of manifest.network.hosts) {
    assert(typeof host === "string" && host.length <= 253 && hostPattern.test(host) && host === host.toLowerCase() && !host.includes("*"), `${manifest.id}: invalid exact network host ${String(host)}.`);
    assert(!seen.has(host), `${manifest.id}: duplicate network host ${host}.`);
    seen.add(host);
    hosts.push(host);
  }
  return { hosts: hosts.sort(comparePortableStrings) };
}

function collectDeclaredFiles(manifest) {
  const files = [];
  if (manifest.assets !== undefined) {
    assert(isRecord(manifest.assets), `${manifest.id}: assets must be an object.`);
    assertOnlyKeys(manifest.assets, new Set(Object.keys(assetRules)), `${manifest.id}: assets`);
    for (const kind of Object.keys(assetRules)) {
      const group = manifest.assets[kind];
      if (group === undefined) continue;
      assert(isRecord(group), `${manifest.id}: assets.${kind} must be an object.`);
      const entries = Object.entries(group);
      assert(entries.length <= 32, `${manifest.id}: assets.${kind} may declare at most 32 entries.`);
      for (const [name, declaration] of entries) {
        assert(assetNamePattern.test(name), `${manifest.id}: invalid ${kind} asset name ${name}.`);
        let relPath = declaration;
        if (kind === "sprites") {
          assert(isRecord(declaration), `${manifest.id}: sprite ${name} metadata must be an object.`);
          assertOnlyKeys(declaration, new Set(["path", "frameWidth", "frameHeight", "frames", "durationMs"]), `${manifest.id}: sprite ${name}`);
          relPath = declaration.path;
          assert(Number.isInteger(declaration.frameWidth) && declaration.frameWidth >= 32 && declaration.frameWidth <= 512, `${manifest.id}: sprite ${name} frameWidth must be between 32 and 512.`);
          assert(Number.isInteger(declaration.frameHeight) && declaration.frameHeight >= 32 && declaration.frameHeight <= 512, `${manifest.id}: sprite ${name} frameHeight must be between 32 and 512.`);
          assert(Number.isInteger(declaration.frames) && declaration.frames >= 1 && declaration.frames <= 16, `${manifest.id}: sprite ${name} frames must be between 1 and 16.`);
          assert(Number.isInteger(declaration.durationMs) && declaration.durationMs >= 100 && declaration.durationMs <= 4000, `${manifest.id}: sprite ${name} durationMs must be between 100 and 4000.`);
        }
        validateSafeRelativePath(relPath, `${manifest.id}: ${kind} asset ${name}`);
        assert(assetRules[kind].extensions.some((extension) => relPath.toLowerCase().endsWith(extension)), `${manifest.id}: ${kind} asset ${name} has an unsupported extension.`);
        files.push({ kind, name, relPath, declaration, maxBytes: assetRules[kind].maxBytes });
      }
    }
  }
  if (manifest.panels !== undefined) {
    assert(isRecord(manifest.panels), `${manifest.id}: panels must be an object.`);
    const entries = Object.entries(manifest.panels);
    assert(entries.length <= 8, `${manifest.id}: panels may declare at most 8 entries.`);
    for (const [name, relPath] of entries) {
      assert(assetNamePattern.test(name), `${manifest.id}: invalid panel name ${name}.`);
      validateSafeRelativePath(relPath, `${manifest.id}: panel ${name}`);
      assert(relPath.toLowerCase().endsWith(".html"), `${manifest.id}: panel ${name} must be an HTML file.`);
      files.push({ kind: "panel", name, relPath, declaration: relPath, maxBytes: maxPanelBytes });
    }
  }
  return files.sort((a, b) => comparePortableStrings(a.relPath, b.relPath));
}

function validateSpriteGridPreviews(manifest) {
  if (!isRecord(manifest.configSchema) || !isRecord(manifest.assets) || !isRecord(manifest.assets.sprites)) return;
  for (const [fieldName, field] of Object.entries(manifest.configSchema)) {
    if (!isRecord(field) || field.presentation !== "sprite-grid" || !Array.isArray(field.options)) continue;
    field.options.forEach((option, index) => {
      assert(isRecord(option) && typeof option.previewSprite === "string" && Object.prototype.hasOwnProperty.call(manifest.assets.sprites, option.previewSprite), `${manifest.id}: configSchema.${fieldName}.options[${index}].previewSprite must reference a declared sprite.`);
    });
  }
}

export function validateDesktopCompatibleReleaseManifest(manifest) {
  // Acceptance must stay at least as strict as apps/desktop/src/plugin-manifest.ts
  // for manifestVersion 3 JavaScript plugins. Producer regressions are covered by
  // the release-manifest parity matrix in sync-plugins.test.mjs.
  assert(isRecord(manifest), "release manifest must be an object.");
  assertOnlyKeys(manifest, manifestFields, `${String(manifest.id ?? "plugin")}: manifest`);
  assert(manifest.manifestVersion === 3, `${String(manifest.id ?? "plugin")}: release plugins must use manifestVersion 3.`);
  assert(typeof manifest.id === "string" && idPattern.test(manifest.id), "release manifest id is invalid.");
  assert(typeof manifest.name === "string" && manifest.name.trim() !== "", `${manifest.id}: name must be a non-empty string.`);
  assertOptionalNonEmptyString(manifest.description, `${manifest.id}: description`);
  assert(typeof manifest.version === "string" && manifest.version.length <= 80 && versionPattern.test(manifest.version), `${manifest.id}: version must be semver and at most 80 characters.`);
  assert(manifest.runtime === "javascript", `${manifest.id}: release plugins must use the JavaScript runtime.`);
  assert(typeof manifest.sdkVersion === "string" && manifest.sdkVersion.length <= 80 && /^3\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.sdkVersion), `${manifest.id}: sdkVersion must be 3.x semver and at most 80 characters.`);
  assert(manifest.icon === undefined || supportedIcons.has(manifest.icon), `${manifest.id}: invalid catalog icon.`);
  validateSafeRelativePath(manifest.entry, `${manifest.id}: entry`);
  assert(/\.(?:js|mjs)$/.test(manifest.entry), `${manifest.id}: entry must be a .js or .mjs file.`);
  validateConfigSchema(manifest);
  const permissions = validatePermissions(manifest);
  const network = validateNetwork(manifest, permissions);
  const declaredFiles = collectDeclaredFiles(manifest);
  validateSpriteGridPreviews(manifest);
  return { permissions, network, declaredFiles };
}

function requireCatalogString(value, label, minLength, maxLength, pattern) {
  assert(typeof value === "string" && value.length >= minLength && value.length <= maxLength && (minLength === 0 || value.trim() !== ""), `plugin catalog ${label} is invalid.`);
  if (pattern) assert(pattern.test(value), `plugin catalog ${label} is invalid.`);
  return value;
}

function validateCatalogPermissions(value, label) {
  assert(Array.isArray(value), `${label}.permissions must be an array.`);
  const permissions = new Set();
  value.forEach((permission, index) => {
    assert(typeof permission === "string" && catalogPermissionSet.has(permission), `${label}.permissions[${index}] is invalid.`);
    assert(!permissions.has(permission), `${label}.permissions[${index}] is duplicated.`);
    permissions.add(permission);
  });
  return permissions;
}

function validateCatalogNetwork(value, permissions, label) {
  const hasNetworkPermission = permissions.has("network");
  assert(hasNetworkPermission === (value !== undefined), `${label}.network must be present if and only if the network permission is declared.`);
  if (value === undefined) return;
  assert(isRecord(value) && Array.isArray(value.hosts), `${label}.network.hosts must be an array.`);
  assertOnlyKeys(value, new Set(["hosts"]), `${label}.network`);
  value.hosts.forEach((host, index) => requireCatalogString(host, `${label}.network.hosts[${index}]`, 1, 253, /^[a-z0-9.-]+(?::\d{1,5})?$/i));
}

export function validateDesktopCompatiblePluginCatalogV2(catalog) {
  assert(isRecord(catalog), "plugin catalog must be an object.");
  assertOnlyKeys(catalog, catalogFields, "plugin catalog");
  assert(catalog.version === 2, "plugin release catalog must use version 2.");
  requireCatalogString(catalog.generatedAt, "generatedAt", 1, 128);
  assert(Array.isArray(catalog.plugins), "plugin catalog plugins must be an array.");
  assert(catalog.plugins.length <= 1000, "plugin catalog may contain at most 1000 plugins.");
  const seen = new Set();
  catalog.plugins.forEach((entry, index) => {
    const label = `plugins[${index}]`;
    assert(isRecord(entry), `${label} must be an object.`);
    assertOnlyKeys(entry, catalogEntryFields, label);
    const id = requireCatalogString(entry.id, `${label}.id`, 3, 64, idPattern);
    assert(!seen.has(id), `plugin catalog contains duplicate id ${id}.`);
    seen.add(id);
    requireCatalogString(entry.name, `${label}.name`, 1, 120);
    requireCatalogString(entry.version, `${label}.version`, 1, 80, versionPattern);
    requireCatalogString(entry.description, `${label}.description`, 0, 1000);
    assert(entry.runtime === "declarative" || entry.runtime === "javascript", `${label}.runtime is invalid.`);
    assert(entry.icon === undefined || supportedIcons.has(entry.icon), `${label}.icon is invalid.`);
    const permissions = validateCatalogPermissions(entry.permissions, label);
    assert(entry.runtime !== "javascript" || !permissions.has("timer"), `${label}.permissions cannot contain timer for a JavaScript plugin.`);
    requireCatalogString(entry.downloadUrl, `${label}.downloadUrl`, 1, 2048);
    requireCatalogString(entry.sha256, `${label}.sha256`, 64, 64, /^[0-9a-f]{64}$/);
    if (entry.minOpenPetsVersion !== undefined) requireCatalogString(entry.minOpenPetsVersion, `${label}.minOpenPetsVersion`, 1, 80, versionPattern);
    if (entry.iconDataUrl !== undefined) requireCatalogString(entry.iconDataUrl, `${label}.iconDataUrl`, 1, 100_000, iconDataUrlPattern);
    if (entry.runtime === "javascript") assert(entry.sdkVersion !== undefined, `${label}.sdkVersion is required for JavaScript plugins.`);
    if (entry.sdkVersion !== undefined) requireCatalogString(entry.sdkVersion, `${label}.sdkVersion`, 1, 80, versionPattern);
    if (entry.maxOpenPetsVersion !== undefined) requireCatalogString(entry.maxOpenPetsVersion, `${label}.maxOpenPetsVersion`, 1, 80, versionPattern);
    if (entry.disabled !== undefined) assert(typeof entry.disabled === "boolean", `${label}.disabled must be a boolean.`);
    if (entry.deprecated !== undefined) assert(typeof entry.deprecated === "boolean", `${label}.deprecated must be a boolean.`);
    if (entry.statusReason !== undefined) requireCatalogString(entry.statusReason, `${label}.statusReason`, 1, 500);
    validateCatalogNetwork(entry.network, permissions, label);
    if (entry.publisherType !== undefined) assert(entry.publisherType === "official" || entry.publisherType === "community", `${label}.publisherType is invalid.`);
  });
  return catalog;
}

async function loadLocales(pluginRoot, pluginId) {
  const localesPath = resolve(pluginRoot, "locales");
  const info = await lstat(localesPath).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  assert(info?.isDirectory() && !info.isSymbolicLink(), `${pluginId}: locales must be a real directory with locales/en.json.`);
  assert(await realpath(localesPath) === localesPath, `${pluginId}: locales must not traverse a symbolic link.`);
  const entries = await readdir(localesPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    assert(!entry.isSymbolicLink(), `${pluginId}: locale ${entry.name} cannot be a symbolic link.`);
    if (entry.name.endsWith(".json")) assert(supportedLocaleSet.has(entry.name.slice(0, -5)), `${pluginId}: unsupported locale file ${entry.name}.`);
  }
  const files = new Map();
  const catalogs = new Map();
  for (const locale of supportedLocales) {
    const relPath = `locales/${locale}.json`;
    try {
      const bytes = await readSafeFile(pluginRoot, relPath, maxLocaleBytes, `${pluginId}: ${relPath}`);
      const parsed = JSON.parse(bytes.toString("utf8"));
      files.set(relPath, bytes);
      catalogs.set(locale, flattenLocale(parsed));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  assert(files.has("locales/en.json"), `${pluginId}: locales/en.json is required.`);
  const english = catalogs.get("en");
  const englishKeys = Object.keys(english).sort();
  for (const [locale, catalog] of catalogs) {
    if (locale === "en") continue;
    const localeKeys = Object.keys(catalog).sort();
    assert(JSON.stringify(localeKeys) === JSON.stringify(englishKeys), `${pluginId}: locales/${locale}.json keys must exactly match locales/en.json.`);
  }
  return { files, english };
}

function addPackageFile(files, name, data, pluginId) {
  validateSafeRelativePath(name, `${pluginId}: ZIP entry`);
  assert(!files.has(name), `${pluginId}: duplicate package path ${name}.`);
  files.set(name, Buffer.from(data));
}

export async function packagePluginDirectory({ pluginDir, publisherType }) {
  assert(publisherType === "official" || publisherType === "community", "publisherType must be official or community.");
  const pluginRoot = await validateRealDirectory(pluginDir, `${publisherType} plugin directory`);
  const rawManifest = await readSafeFile(pluginRoot, manifestFilename, maxManifestBytes, `${basename(pluginRoot)}: manifest`);
  let manifest;
  try { manifest = JSON.parse(rawManifest.toString("utf8")); }
  catch (error) { throw new Error(`${basename(pluginRoot)}: manifest is invalid JSON: ${error.message}`); }
  const { permissions, network, declaredFiles } = validateDesktopCompatibleReleaseManifest(manifest);
  assert(typeof manifest.id === "string" && idPattern.test(manifest.id) && manifest.id === basename(pluginRoot), `${basename(pluginRoot)}: manifest id must match its directory.`);
  const { files: localeFiles, english } = await loadLocales(pluginRoot, manifest.id);
  const name = resolveManifestText(english, manifest.name, `${manifest.id}: name`, 120);
  const description = resolveManifestText(english, manifest.description, `${manifest.id}: description`, 1000);
  const packageFiles = new Map();
  addPackageFile(packageFiles, manifestFilename, rawManifest, manifest.id);
  addPackageFile(packageFiles, manifest.entry, await readSafeFile(pluginRoot, manifest.entry, maxEntryBytes, `${manifest.id}: entry`), manifest.id);
  let iconDataUrl;
  for (const file of declaredFiles) {
    let bytes = await readSafeFile(pluginRoot, file.relPath, file.maxBytes, `${manifest.id}: ${file.kind} ${file.name}`);
    if (file.kind === "sprites") validateSpriteAssetBytes(file.declaration, bytes, `${manifest.id}: sprite ${file.name}`);
    if ((file.kind === "icons" || file.kind === "svgs") && file.relPath.toLowerCase().endsWith(".svg")) bytes = Buffer.from(sanitizeSvgText(bytes.toString("utf8")), "utf8");
    if (file.kind === "panel") bytes = Buffer.from(injectPanelCsp(bytes.toString("utf8")), "utf8");
    addPackageFile(packageFiles, file.relPath, bytes, manifest.id);
    if (!iconDataUrl && file.kind === "icons" && file.relPath.toLowerCase().endsWith(".svg")) {
      const candidate = `data:image/svg+xml;base64,${bytes.toString("base64")}`;
      assert(candidate.length <= 100_000 && iconDataUrlPattern.test(candidate), `${manifest.id}: generated iconDataUrl must be a valid SVG data URL of at most 100000 characters.`);
      iconDataUrl = candidate;
    }
  }
  for (const [relPath, bytes] of [...localeFiles].sort(([a], [b]) => comparePortableStrings(a, b))) addPackageFile(packageFiles, relPath, bytes, manifest.id);
  assert(packageFiles.size <= maxZipEntries, `${manifest.id}: package contains too many entries.`);
  const uncompressedBytes = [...packageFiles.values()].reduce((total, bytes) => total + bytes.length, 0);
  assert(uncompressedBytes <= maxUncompressedBytes, `${manifest.id}: package is too large when uncompressed.`);
  const zip = createDeterministicZip([...packageFiles].map(([entryName, data]) => ({ name: entryName, data })));
  assert(zip.length <= maxZipBytes, `${manifest.id}: package ZIP exceeds ${maxZipBytes} bytes.`);
  const catalogEntry = {
    id: manifest.id,
    name,
    version: manifest.version,
    description,
    runtime: "javascript",
    ...(manifest.icon ? { icon: manifest.icon } : {}),
    ...(iconDataUrl ? { iconDataUrl } : {}),
    permissions,
    downloadUrl: `https://zip.openpets.dev/plugins/${manifest.id}.zip`,
    sha256: createHash("sha256").update(zip).digest("hex"),
    sdkVersion: manifest.sdkVersion,
    ...(network ? { network } : {}),
    publisherType,
  };
  return { id: manifest.id, publisherType, manifest, catalogEntry, zip, packageFiles };
}

async function collectReviewedTreeFiles(root, current = root, prefix = "", files = []) {
  const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => comparePortableStrings(left.name, right.name));
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    validateSafeRelativePath(relPath, "reviewed tree path");
    const absolute = join(current, entry.name);
    const info = await lstat(absolute);
    assert(!info.isSymbolicLink(), `reviewed tree path ${relPath} cannot be a symbolic link.`);
    assert(await realpath(absolute) === absolute, `reviewed tree path ${relPath} must not traverse a symbolic link.`);
    if (info.isDirectory()) await collectReviewedTreeFiles(root, absolute, relPath, files);
    else {
      assert(info.isFile(), `reviewed tree path ${relPath} must be a regular file or directory.`);
      files.push({ relPath, data: await readFile(absolute) });
    }
  }
  return files;
}

export async function computeReviewedTreeSha256(directory) {
  const root = await validateRealDirectory(directory, "reviewed plugin tree");
  const files = await collectReviewedTreeFiles(root);
  const totalBytes = files.reduce((total, file) => total + file.data.length, 0);
  assert(totalBytes <= maxReviewedTreeBytes, `reviewed plugin tree exceeds ${maxReviewedTreeBytes} bytes.`);
  const hash = createHash("sha256");
  hash.update("openpets-reviewed-tree-v1\0", "utf8");
  for (const file of files.sort((left, right) => comparePortableStrings(left.relPath, right.relPath))) {
    const pathBytes = Buffer.from(file.relPath, "utf8");
    const framing = Buffer.alloc(12);
    framing.writeUInt32BE(pathBytes.length, 0);
    framing.writeBigUInt64BE(BigInt(file.data.length), 4);
    hash.update(framing);
    hash.update(pathBytes);
    hash.update(file.data);
  }
  return hash.digest("hex");
}

function validateGithubSource(entry, label) {
  assert(typeof entry.publisher === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(entry.publisher), `${label}: publisher must be a GitHub owner.`);
  let source;
  try { source = new URL(entry.sourceUrl); } catch { throw new Error(`${label}: sourceUrl must be a GitHub repository URL.`); }
  const parts = source.pathname.split("/").filter(Boolean);
  assert(source.protocol === "https:" && source.hostname === "github.com" && !source.username && !source.password && !source.search && !source.hash && parts.length === 2, `${label}: sourceUrl must be a canonical GitHub repository URL.`);
  assert(parts[0].toLowerCase() === entry.publisher.toLowerCase(), `${label}: sourceUrl owner must match publisher.`);
  if (entry.sourceSubdirectory !== undefined && entry.sourceSubdirectory !== null) validateSafeRelativePath(entry.sourceSubdirectory, `${label}: sourceSubdirectory`);
  assert(typeof entry.sourceCommit === "string" && /^[0-9a-f]{40}$/.test(entry.sourceCommit), `${label}: sourceCommit must be a lowercase 40-character commit SHA.`);
}

export function validateCommunityMetadata({ provenance, submissions, communityIds }) {
  assert(isRecord(provenance), "provenance: source sidecar must be an object.");
  assert(isRecord(submissions), "submissions: source sidecar must be an object.");
  const community = new Set(communityIds);
  for (const id of community) assert(provenance[id], `provenance: community plugin ${id} is missing a reviewed snapshot.`);
  for (const [id, entry] of Object.entries(provenance)) {
    assert(community.has(id), `provenance: ${id} does not match a current community plugin.`);
    assert(idPattern.test(id) && isRecord(entry), `provenance [${id}]: invalid entry.`);
    assertOnlyKeys(entry, new Set(["publisher", "sourceUrl", "sourceSubdirectory", "sourceCommit", "reviewedTreeSha256", "reviewedAt", "updatePolicy"]), `provenance [${id}]`);
    validateGithubSource(entry, `provenance [${id}]`);
    assert(typeof entry.reviewedTreeSha256 === "string" && /^[0-9a-f]{64}$/.test(entry.reviewedTreeSha256), `provenance [${id}]: reviewedTreeSha256 must be a lowercase SHA-256 digest.`);
    assert(typeof entry.reviewedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(entry.reviewedAt) && !Number.isNaN(Date.parse(entry.reviewedAt)), `provenance [${id}]: reviewedAt must be an ISO date.`);
    assert(entry.updatePolicy === "safe-auto" || entry.updatePolicy === "manual-review", `provenance [${id}]: invalid updatePolicy.`);
  }
  for (const [id, entry] of Object.entries(submissions)) {
    assert(idPattern.test(id) && isRecord(entry), `submissions [${id}]: invalid entry.`);
    assert(!community.has(id), `submissions [${id}]: an installable community plugin cannot remain pending.`);
    assertOnlyKeys(entry, new Set(["name", "description", "publisher", "sourceUrl", "sourceSubdirectory", "sourceCommit", "submittedAt", "status"]), `submissions [${id}]`);
    assert(typeof entry.name === "string" && entry.name.trim() !== "", `submissions [${id}]: name is required.`);
    assert(typeof entry.description === "string" && entry.description.trim() !== "", `submissions [${id}]: description is required.`);
    validateGithubSource(entry, `submissions [${id}]`);
    assert(typeof entry.submittedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(entry.submittedAt) && !Number.isNaN(Date.parse(entry.submittedAt)), `submissions [${id}]: submittedAt must be an ISO date.`);
    assert(entry.status === "under-review", `submissions [${id}]: status must be under-review.`);
  }
  return { provenance, submissions };
}

async function readTrackedJson(path, label) {
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink(), `${label} must be a tracked regular JSON file.`);
  const bytes = await readFile(path);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error(`${label} is invalid JSON: ${error.message}`); }
}

async function discoverPlugins(repoRoot) {
  const plugins = [];
  for (const { lane, publisherType } of [{ lane: "official", publisherType: "official" }, { lane: "community", publisherType: "community" }]) {
    const lanePath = join(repoRoot, "plugins", lane);
    const laneRoot = await validateRealDirectory(lanePath, `plugins/${lane}`);
    assert(laneRoot === lanePath && isUnder(repoRoot, laneRoot), `plugins/${lane} must stay inside the repository and must not traverse a symbolic link.`);
    const entries = (await readdir(laneRoot, { withFileTypes: true })).sort((a, b) => comparePortableStrings(a.name, b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      assert(!entry.isSymbolicLink(), `plugins/${lane}/${entry.name} cannot be a symbolic link.`);
      if (!entry.isDirectory()) continue;
      const manifestPath = join(laneRoot, entry.name, manifestFilename);
      try { await access(manifestPath, fsConstants.F_OK); }
      catch { throw new Error(`plugins/${lane}/${entry.name} is missing ${manifestFilename}.`); }
      plugins.push(await packagePluginDirectory({ pluginDir: join(laneRoot, entry.name), publisherType }));
    }
  }
  plugins.sort((a, b) => comparePortableStrings(a.id, b.id));
  const seen = new Set();
  for (const plugin of plugins) {
    assert(!seen.has(plugin.id), `Duplicate plugin id ${plugin.id} across source lanes.`);
    seen.add(plugin.id);
  }
  return plugins;
}

async function lstatOptional(path) {
  try { return await lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureSafeOutputDirectory(repoRoot, relDirectory, label) {
  validateSafeRelativePath(relDirectory, label);
  let current = repoRoot;
  for (const segment of relDirectory.split("/")) {
    current = join(current, segment);
    let info = await lstatOptional(current);
    if (!info) {
      await mkdir(current, { mode: 0o755 });
      info = await lstat(current);
    }
    assert(info.isDirectory() && !info.isSymbolicLink(), `${label} ancestry must contain only real directories.`);
    const actual = await realpath(current);
    assert(actual === current && isWithin(repoRoot, actual), `${label} ancestry escapes the repository through a symbolic link.`);
  }
  return current;
}

async function validateOutputTarget(repoRoot, relPath, label) {
  validateSafeRelativePath(relPath, label);
  const parentRel = posix.dirname(relPath);
  const parent = await ensureSafeOutputDirectory(repoRoot, parentRel, `${label} parent`);
  const target = join(repoRoot, ...relPath.split("/"));
  assert(isUnder(repoRoot, target) && dirname(target) === parent, `${label} escapes the repository.`);
  const info = await lstatOptional(target);
  if (info) {
    assert(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file, not a symbolic link or directory.`);
    assert(await realpath(target) === target, `${label} must not traverse a symbolic link.`);
  }
  return target;
}

async function atomicWrite(repoRoot, relPath, data) {
  const path = await validateOutputTarget(repoRoot, relPath, relPath);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await validateOutputTarget(repoRoot, relPath, relPath);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeArtifacts(repoRoot, plugins, catalogV2, catalogV1, metadata) {
  await ensureSafeOutputDirectory(repoRoot, "web/public/plugins", "plugin public output");
  const zipDir = await ensureSafeOutputDirectory(repoRoot, "web/.data/plugin-zips", "plugin ZIP output");
  await Promise.all([
    atomicWrite(repoRoot, "web/public/plugins/catalog.v2.json", jsonBytes(catalogV2)),
    atomicWrite(repoRoot, "web/public/plugins/catalog.v1.json", jsonBytes(catalogV1)),
    atomicWrite(repoRoot, "web/public/plugins/provenance.json", jsonBytes(metadata.provenance)),
    atomicWrite(repoRoot, "web/public/plugins/submissions.json", jsonBytes(metadata.submissions)),
    ...plugins.map((plugin) => atomicWrite(repoRoot, `web/.data/plugin-zips/${plugin.id}.zip`, plugin.zip)),
  ]);
  const expected = new Set(plugins.map((plugin) => `${plugin.id}.zip`));
  for (const entry of await readdir(zipDir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".zip") || expected.has(entry.name)) continue;
    const relPath = `web/.data/plugin-zips/${entry.name}`;
    const stalePath = await validateOutputTarget(repoRoot, relPath, `stale plugin ZIP ${entry.name}`);
    assert(entry.isFile() && !entry.isSymbolicLink(), `stale plugin ZIP ${entry.name} must be a regular file.`);
    await rm(stalePath);
  }
}

async function runCommand(command, args, cwd) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", (error) => rejectPromise(error.code === "ENOENT" ? new Error("wrangler is required for R2 upload; install it or run with --skip-r2.") : error));
    child.on("exit", (code, signal) => code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} exited with ${signal ?? code}.`)));
  });
}

async function uploadPluginZips(repoRoot, plugins, bucket) {
  for (const plugin of plugins) {
    const zipPath = await validateOutputTarget(repoRoot, `web/.data/plugin-zips/${plugin.id}.zip`, `${plugin.id}: upload ZIP`);
    await runCommand("wrangler", ["r2", "object", "put", `${bucket}/plugins/${plugin.id}.zip`, "--file", zipPath, "--remote"], repoRoot);
  }
}

function parseArgs(argv) {
  const options = { dryRun: false, skipR2: false, bucket: process.env.OPENPETS_R2_BUCKET || "openpets" };
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-r2") options.skipR2 = true;
    else if (arg.startsWith("--bucket=")) options.bucket = arg.slice("--bucket=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  assert(/^[A-Za-z0-9._-]+$/.test(options.bucket), "R2 bucket name is invalid.");
  return options;
}

export async function syncPlugins({ repoRoot = defaultRepoRoot, dryRun = false, skipR2 = false, bucket = process.env.OPENPETS_R2_BUCKET || "openpets", generatedAt = new Date().toISOString() } = {}) {
  repoRoot = await validateRealDirectory(repoRoot, "repository root");
  const plugins = await discoverPlugins(repoRoot);
  const communityIds = plugins.filter((plugin) => plugin.publisherType === "community").map((plugin) => plugin.id);
  const provenance = await readTrackedJson(join(repoRoot, "plugins", "community", "provenance.json"), "plugins/community/provenance.json");
  const submissions = await readTrackedJson(join(repoRoot, "plugins", "community", "submissions.json"), "plugins/community/submissions.json");
  const metadata = validateCommunityMetadata({ provenance, submissions, communityIds });
  for (const id of communityIds) {
    const digest = await computeReviewedTreeSha256(join(repoRoot, "plugins", "community", id));
    assert(digest === metadata.provenance[id].reviewedTreeSha256, `provenance [${id}]: current source tree does not match reviewedTreeSha256; review the new bytes and update sourceCommit, reviewedAt, and reviewedTreeSha256 together.`);
  }
  const catalogV2 = { version: 2, generatedAt, plugins: plugins.map((plugin) => plugin.catalogEntry) };
  validateDesktopCompatiblePluginCatalogV2(catalogV2);
  const catalogV1 = { version: 1, generatedAt, plugins: [] };
  if (!dryRun) await writeArtifacts(repoRoot, plugins, catalogV2, catalogV1, metadata);
  if (!dryRun && !skipR2) await uploadPluginZips(repoRoot, plugins, bucket);
  return { plugins, catalogV2, catalogV1, metadata };
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function assertZipRange(buffer, offset, length, label) {
  assert(Number.isInteger(offset) && Number.isInteger(length) && offset >= 0 && length >= 0 && offset + length <= buffer.length, `${label} exceeds ZIP bounds.`);
}

function validateZipExtraFields(bytes, label) {
  let offset = 0;
  while (offset < bytes.length) {
    assert(offset + 4 <= bytes.length, `${label} has a truncated extra-field header.`);
    const size = bytes.readUInt16LE(offset + 2);
    offset += 4;
    assert(offset + size <= bytes.length, `${label} has a truncated extra-field value.`);
    offset += size;
  }
}

export function parseStrictZip(buffer) {
  assert(Buffer.isBuffer(buffer), "ZIP input must be a Buffer.");
  assert(buffer.length <= maxZipBytes, `ZIP exceeds ${maxZipBytes} bytes.`);
  assert(buffer.length >= 22, "ZIP is too short to contain an end-of-central-directory record.");
  const minimumEocdOffset = Math.max(0, buffer.length - 22 - 0xffff);
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) { eocdOffset = offset; break; }
  }
  assert(eocdOffset >= 0, "ZIP has no valid end-of-central-directory record or contains trailing bytes.");
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  assert(diskNumber === 0 && centralDisk === 0 && entriesOnDisk === entryCount, "Multi-disk ZIP archives are not supported.");
  assert(entryCount > 0 && entryCount <= maxZipEntries, `ZIP entry count must be between 1 and ${maxZipEntries}.`);
  assert(entryCount !== 0xffff && centralSize !== 0xffffffff && centralOffset !== 0xffffffff, "ZIP64 archives are not supported.");
  assert(centralOffset + centralSize === eocdOffset, "ZIP central-directory offset or size does not match the end record.");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const centralEntries = [];
  const names = new Set();
  let declaredUncompressedBytes = 0;
  let centralCursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assertZipRange(buffer, centralCursor, 46, `central-directory entry ${index}`);
    assert(buffer.readUInt32LE(centralCursor) === 0x02014b50, `central-directory entry ${index} has an invalid signature.`);
    const flags = buffer.readUInt16LE(centralCursor + 8);
    const method = buffer.readUInt16LE(centralCursor + 10);
    const crc = buffer.readUInt32LE(centralCursor + 16);
    const compressedSize = buffer.readUInt32LE(centralCursor + 20);
    const uncompressedSize = buffer.readUInt32LE(centralCursor + 24);
    const nameLength = buffer.readUInt16LE(centralCursor + 28);
    const extraLength = buffer.readUInt16LE(centralCursor + 30);
    const commentLength = buffer.readUInt16LE(centralCursor + 32);
    const diskStart = buffer.readUInt16LE(centralCursor + 34);
    const localOffset = buffer.readUInt32LE(centralCursor + 42);
    assert((flags & ~0x0800) === 0, `central-directory entry ${index} uses forbidden ZIP flags (encryption, data descriptors, or unsupported options).`);
    assert(method === 0 || method === 8, `central-directory entry ${index} uses unsupported compression method ${method}.`);
    assert(diskStart === 0, `central-directory entry ${index} references another disk.`);
    assert(compressedSize !== 0xffffffff && uncompressedSize !== 0xffffffff && localOffset !== 0xffffffff, "ZIP64 entries are not supported.");
    declaredUncompressedBytes += uncompressedSize;
    assert(declaredUncompressedBytes <= maxUncompressedBytes, `ZIP declares more than ${maxUncompressedBytes} uncompressed bytes.`);
    assert(nameLength > 0, `central-directory entry ${index} has an empty name.`);
    const variableLength = nameLength + extraLength + commentLength;
    assertZipRange(buffer, centralCursor + 46, variableLength, `central-directory entry ${index}`);
    const nameBytes = buffer.subarray(centralCursor + 46, centralCursor + 46 + nameLength);
    const extraBytes = buffer.subarray(centralCursor + 46 + nameLength, centralCursor + 46 + nameLength + extraLength);
    validateZipExtraFields(extraBytes, `central-directory entry ${index}`);
    const hasUtf8Name = (flags & 0x0800) !== 0;
    assert(hasUtf8Name || nameBytes.every((byte) => byte <= 0x7f), `ZIP entry ${index} has a non-ASCII name without the UTF-8 flag.`);
    const decodedName = hasUtf8Name ? decoder.decode(nameBytes) : nameBytes.toString("ascii");
    const name = validateSafeRelativePath(decodedName, `ZIP entry ${index}`);
    assert(!names.has(name), `Duplicate ZIP entry ${name}.`);
    names.add(name);
    centralEntries.push({ name, nameBytes: Buffer.from(nameBytes), flags, method, crc, compressedSize, uncompressedSize, localOffset });
    centralCursor += 46 + variableLength;
  }
  assert(centralCursor === eocdOffset, "ZIP central directory contains unparsed or truncated bytes.");

  const files = new Map();
  let localCursor = 0;
  let totalUncompressedBytes = 0;
  for (const [index, entry] of [...centralEntries].sort((left, right) => left.localOffset - right.localOffset).entries()) {
    assert(entry.localOffset === localCursor, `local ZIP entry ${entry.name} overlaps another entry or leaves hidden bytes.`);
    assertZipRange(buffer, localCursor, 30, `local ZIP entry ${entry.name}`);
    assert(buffer.readUInt32LE(localCursor) === 0x04034b50, `local ZIP entry ${entry.name} has an invalid signature.`);
    const flags = buffer.readUInt16LE(localCursor + 6);
    const method = buffer.readUInt16LE(localCursor + 8);
    const crc = buffer.readUInt32LE(localCursor + 14);
    const compressedSize = buffer.readUInt32LE(localCursor + 18);
    const uncompressedSize = buffer.readUInt32LE(localCursor + 22);
    const nameLength = buffer.readUInt16LE(localCursor + 26);
    const extraLength = buffer.readUInt16LE(localCursor + 28);
    assert(flags === entry.flags && method === entry.method && crc === entry.crc && compressedSize === entry.compressedSize && uncompressedSize === entry.uncompressedSize, `local and central headers disagree for ZIP entry ${entry.name}.`);
    assert(nameLength === entry.nameBytes.length, `local and central names have different lengths for ZIP entry ${entry.name}.`);
    assertZipRange(buffer, localCursor + 30, nameLength + extraLength + compressedSize, `local ZIP entry ${entry.name}`);
    const localName = buffer.subarray(localCursor + 30, localCursor + 30 + nameLength);
    assert(localName.equals(entry.nameBytes), `local and central names disagree for ZIP entry ${entry.name}.`);
    const extraStart = localCursor + 30 + nameLength;
    validateZipExtraFields(buffer.subarray(extraStart, extraStart + extraLength), `local ZIP entry ${entry.name}`);
    const dataStart = extraStart + extraLength;
    const dataEnd = dataStart + compressedSize;
    assert(dataEnd <= centralOffset, `local ZIP entry ${entry.name} overlaps the central directory.`);
    const compressed = buffer.subarray(dataStart, dataEnd);
    const data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    assert(data.length === uncompressedSize, `ZIP entry ${entry.name} has an invalid uncompressed size.`);
    assert(crc32(data) === crc, `ZIP entry ${entry.name} failed its CRC-32 check.`);
    totalUncompressedBytes += data.length;
    assert(totalUncompressedBytes <= maxUncompressedBytes, `ZIP exceeds ${maxUncompressedBytes} uncompressed bytes.`);
    files.set(entry.name, data);
    localCursor = dataEnd;
    assert(index < entryCount, "ZIP contains too many local entries.");
  }
  assert(localCursor === centralOffset, "ZIP local entries do not end at the central directory.");
  return files;
}

export function createDeterministicZip(inputEntries) {
  assert(Array.isArray(inputEntries) && inputEntries.length > 0, "ZIP must contain at least one entry.");
  assert(inputEntries.length <= maxZipEntries, `ZIP may contain at most ${maxZipEntries} entries.`);
  const entries = inputEntries.map((entry) => {
    assert(isRecord(entry), "ZIP entry must be an object.");
    const name = validateSafeRelativePath(entry.name, "ZIP entry name");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const nameBytes = Buffer.from(name, "utf8");
    assert(nameBytes.length <= 0xffff, `ZIP entry name ${name} is too long.`);
    assert(data.length <= 0xffffffff, `ZIP entry ${name} is too large.`);
    return { name, nameBytes, data, crc: crc32(data) };
  }).sort((a, b) => Buffer.compare(a.nameBytes, b.nameBytes));
  for (let index = 1; index < entries.length; index += 1) assert(entries[index - 1].name !== entries[index].name, `Duplicate ZIP entry ${entries[index].name}.`);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    assert(offset <= 0xffffffff, "ZIP local-entry offset exceeds the ZIP32 limit.");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(entry.nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, entry.nameBytes, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(entry.nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, entry.nameBytes);
    offset += local.length + entry.nameBytes.length + entry.data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  assert(offset + centralDirectory.length <= 0xffffffff, "ZIP central directory exceeds the ZIP32 limit.");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await syncPlugins(options);
    const mode = options.dryRun ? "checked" : options.skipR2 ? "packaged" : "packaged and uploaded";
    console.log(`Plugin catalog ${mode}: ${result.plugins.length} plugins (${result.plugins.filter((plugin) => plugin.publisherType === "official").length} official, ${result.plugins.filter((plugin) => plugin.publisherType === "community").length} community).`);
  } catch (error) {
    console.error(`Plugin catalog sync failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
