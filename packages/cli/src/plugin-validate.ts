import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Author-time manifest validation (§18.5): `openpets plugin validate <dir>`
 * checks the manifest shape, permissions, config schema, network hosts,
 * declared assets/panels, and that every referenced file exists with a sane
 * size — before the plugin ever reaches the app.
 *
 * This mirrors the desktop validator's rules; the desktop remains the source
 * of truth at install time.
 */

export type PluginValidationIssue = { readonly path: string; readonly message: string };
export type PluginValidationResult = { readonly ok: boolean; readonly issues: readonly PluginValidationIssue[] };

const v2Permissions = ["pet:speak", "pet:reaction", "pet:move", "schedule", "storage", "status", "commands", "network"];
const v3Permissions = [
  ...v2Permissions,
  "pet:interact", "pet:pin", "pet:animate", "pet:speak:dynamic", "pet:drop", "pets:read", "pets:manage",
  "audio", "events", "ui:toast", "ui:panel", "ui:delivery", "companion:context", "notify", "bus", "ai", "secrets", "voice:speak", "voice:listen",
  "auth", "files", "system:openExternal", "system:metrics", "clipboard", "network:write",
];
const configFieldTypesV2 = ["text", "textarea", "number", "boolean", "select", "time", "multiSelect", "list"];
const configFieldTypesV3 = [...configFieldTypesV2, "date", "secret", "sound"];
const assetKinds = ["icons", "images", "svgs", "sprites", "sounds"] as const;
const assetExtensions: Record<string, readonly string[]> = {
  icons: [".png", ".webp", ".svg"],
  images: [".png", ".webp", ".jpg", ".jpeg", ".gif"],
  svgs: [".svg"],
  sprites: [".webp"],
  sounds: [".ogg", ".mp3", ".wav"],
};
const assetMaxBytes: Record<string, number> = { icons: 256 * 1024, images: 1024 * 1024, svgs: 256 * 1024, sprites: 5 * 1024 * 1024, sounds: 1024 * 1024 };
const maxEntryBytes = 1024 * 1024;
const maxPanelBytes = 1024 * 1024;
const assetNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function validatePluginFolder(sourceDir: string): PluginValidationResult {
  const issues: PluginValidationIssue[] = [];
  const fail = (path: string, message: string) => issues.push({ path, message });
  const dir = resolve(sourceDir);
  const manifestPath = join(dir, "openpets.plugin.json");
  if (!existsSync(manifestPath)) return { ok: false, issues: [{ path: "openpets.plugin.json", message: "Manifest file not found." }] };

  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    manifest = parsed as Record<string, unknown>;
  } catch (error) {
    return { ok: false, issues: [{ path: "openpets.plugin.json", message: `Manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }] };
  }

  const manifestVersion = manifest.manifestVersion;
  if (manifestVersion !== 1 && manifestVersion !== 2 && manifestVersion !== 3) fail("$.manifestVersion", "manifestVersion must be 1, 2, or 3.");
  if (typeof manifest.id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(manifest.id)) fail("$.id", "id must be lowercase reverse-DNS style (a-z, 0-9, dot, dash, underscore).");
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") fail("$.name", "name must be a non-empty string.");
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) fail("$.version", "version must be semver (x.y.z).");

  if (manifestVersion === 1) {
    if (manifest.runtime !== "declarative") fail("$.runtime", 'manifestVersion 1 runtime must be "declarative".');
    return { ok: issues.length === 0, issues };
  }

  if (manifest.runtime !== "javascript") fail("$.runtime", 'runtime must be "javascript" for manifestVersion 2/3.');
  if (typeof manifest.sdkVersion !== "string" || !/^\d+\.\d+\.\d+/.test(manifest.sdkVersion)) fail("$.sdkVersion", "sdkVersion must be semver.");
  else if (manifestVersion === 3 && !manifest.sdkVersion.startsWith("3.")) fail("$.sdkVersion", "manifestVersion 3 requires sdkVersion 3.x.y.");
  else if (manifestVersion === 2 && manifest.sdkVersion.startsWith("3.")) fail("$.sdkVersion", "sdkVersion 3.x.y requires manifestVersion 3.");

  // entry
  if (typeof manifest.entry !== "string" || manifest.entry.startsWith("/") || manifest.entry.includes("\\") || manifest.entry.split("/").includes("..") || !/\.(?:mjs|js)$/.test(manifest.entry)) {
    fail("$.entry", "entry must be a relative .js or .mjs path.");
  } else {
    checkFile(dir, manifest.entry, maxEntryBytes, "$.entry", fail);
  }

  // permissions
  const allowed = manifestVersion === 3 ? v3Permissions : v2Permissions;
  if (!Array.isArray(manifest.permissions)) fail("$.permissions", "permissions must be an array.");
  else {
    const seen = new Set<string>();
    manifest.permissions.forEach((permission, index) => {
      if (typeof permission !== "string" || !allowed.includes(permission)) fail(`$.permissions[${index}]`, `Permission ${String(permission)} is not valid for manifestVersion ${String(manifestVersion)}.`);
      else if (seen.has(permission)) fail(`$.permissions[${index}]`, `Duplicate permission ${permission}.`);
      seen.add(String(permission));
    });
  }

  // network
  if (manifest.network !== undefined) {
    const network = manifest.network as Record<string, unknown>;
    if (typeof network !== "object" || network === null || !Array.isArray(network.hosts)) fail("$.network.hosts", "network.hosts must be an array of exact host names.");
    else network.hosts.forEach((host, index) => {
      if (typeof host !== "string" || !/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host) || host.includes("*")) fail(`$.network.hosts[${index}]`, "network hosts must be exact host names (no wildcards).");
    });
    if (Array.isArray((manifest.permissions as unknown[]) ?? []) && !(manifest.permissions as unknown[]).includes("network")) fail("$.network", 'Declaring network.hosts without the "network" permission has no effect.');
  }

  // configSchema
  if (manifest.configSchema !== undefined) {
    const schema = manifest.configSchema as Record<string, unknown>;
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) fail("$.configSchema", "configSchema must be an object.");
    else {
      const allowedTypes = manifestVersion === 3 ? configFieldTypesV3 : configFieldTypesV2;
      for (const [key, field] of Object.entries(schema)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) fail(`$.configSchema.${key}`, "Config field keys must be simple identifiers.");
        if (typeof field !== "object" || field === null) { fail(`$.configSchema.${key}`, "Config field must be an object."); continue; }
        const type = (field as Record<string, unknown>).type;
        if (typeof type !== "string" || !allowedTypes.includes(type)) fail(`$.configSchema.${key}.type`, `Config field type ${String(type)} is not supported for manifestVersion ${String(manifestVersion)}.`);
        if (type === "secret" && (field as Record<string, unknown>).default !== undefined) fail(`$.configSchema.${key}.default`, "Secret config fields must not declare defaults.");
      }
    }
  }

  // v3 assets + panels
  if (manifestVersion !== 3) {
    if (manifest.assets !== undefined) fail("$.assets", "assets need manifestVersion 3.");
    if (manifest.panels !== undefined) fail("$.panels", "panels need manifestVersion 3.");
    return { ok: issues.length === 0, issues };
  }
  if (manifest.assets !== undefined) {
    const assets = manifest.assets as Record<string, unknown>;
    if (typeof assets !== "object" || assets === null) fail("$.assets", "assets must be an object.");
    else {
      for (const [kind, group] of Object.entries(assets)) {
        if (!assetKinds.includes(kind as (typeof assetKinds)[number])) { fail(`$.assets.${kind}`, `Unknown asset kind ${kind}.`); continue; }
        if (typeof group !== "object" || group === null) { fail(`$.assets.${kind}`, `assets.${kind} must be an object.`); continue; }
        for (const [name, declaration] of Object.entries(group as Record<string, unknown>)) {
          const where = `$.assets.${kind}.${name}`;
          if (!assetNamePattern.test(name)) fail(where, "Asset names must be simple lowercase identifiers.");
          if (kind === "sprites") {
            if (!isSpriteDeclaration(declaration)) { fail(where, "Sprite assets require path, frameWidth, frameHeight, frames, and durationMs metadata."); continue; }
            if (!declaration.path.toLowerCase().endsWith(".webp") || declaration.path.startsWith("/") || declaration.path.includes("\\") || declaration.path.split("/").includes("..")) { fail(`${where}.path`, "Sprite path must be a safe relative WebP path."); continue; }
            checkFile(dir, declaration.path, assetMaxBytes.sprites, where, fail);
            const dimensions = readWebpDimensions(join(dir, declaration.path));
            if (!dimensions || dimensions.width !== declaration.frameWidth * declaration.frames || dimensions.height !== declaration.frameHeight) fail(where, "Sprite decoded dimensions must equal frameWidth * frames by frameHeight.");
            continue;
          }
          const relPath = declaration;
          if (typeof relPath !== "string" || relPath.startsWith("/") || relPath.includes("\\") || relPath.split("/").includes("..")) { fail(where, "Asset path must be a safe relative path."); continue; }
          if (!(assetExtensions[kind] ?? []).some((extension) => relPath.toLowerCase().endsWith(extension))) fail(where, `Asset must end with one of ${(assetExtensions[kind] ?? []).join(", ")}.`);
          else checkFile(dir, relPath, assetMaxBytes[kind] ?? 1024 * 1024, where, fail);
        }
      }
    }
  }
  if (manifest.panels !== undefined) {
    const panels = manifest.panels as Record<string, unknown>;
    if (typeof panels !== "object" || panels === null) fail("$.panels", "panels must be an object.");
    else {
      for (const [name, relPath] of Object.entries(panels)) {
        const where = `$.panels.${name}`;
        if (!assetNamePattern.test(name)) fail(where, "Panel names must be simple lowercase identifiers.");
        if (typeof relPath !== "string" || !relPath.toLowerCase().endsWith(".html") || relPath.startsWith("/") || relPath.split("/").includes("..")) { fail(where, "Panel path must be a safe relative .html path."); continue; }
        checkFile(dir, relPath, maxPanelBytes, where, fail);
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

function isSpriteDeclaration(value: unknown): value is { path: string; frameWidth: number; frameHeight: number; frames: number; durationMs: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const frameWidth = item.frameWidth;
  const frameHeight = item.frameHeight;
  const frames = item.frames;
  const durationMs = item.durationMs;
  if (Object.keys(item).some((key) => !["path", "frameWidth", "frameHeight", "frames", "durationMs"].includes(key))) return false;
  return typeof item.path === "string" && typeof frameWidth === "number" && Number.isInteger(frameWidth) && frameWidth >= 32 && frameWidth <= 512 && typeof frameHeight === "number" && Number.isInteger(frameHeight) && frameHeight >= 32 && frameHeight <= 512 && typeof frames === "number" && Number.isInteger(frames) && frames >= 1 && frames <= 16 && typeof durationMs === "number" && Number.isInteger(durationMs) && durationMs >= 100 && durationMs <= 4000;
}

function readWebpDimensions(path: string): { width: number; height: number } | undefined {
  try {
    const bytes = readFileSync(path);
    if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return undefined;
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (chunk === "VP8L" && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
    if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  } catch {}
  return undefined;
}

function checkFile(dir: string, relPath: string, maxBytes: number, where: string, fail: (path: string, message: string) => void): void {
  const filePath = join(dir, relPath);
  if (!existsSync(filePath)) { fail(where, `Referenced file does not exist: ${relPath}`); return; }
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) { fail(where, `Referenced path must be a regular file: ${relPath}`); return; }
  if (stat.size > maxBytes) fail(where, `File is too large (${stat.size} bytes; max ${maxBytes}): ${relPath}`);
}
