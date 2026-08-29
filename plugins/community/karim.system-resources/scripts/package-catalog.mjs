import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const STAGING = path.join(DIST, "catalog");
const FORBIDDEN = ["package.json", "scripts/", "sidecar/", "test.js", "node_modules/", "dist/"];

export function catalogPackageFiles(manifest, root = ROOT) {
  const files = ["openpets.plugin.json", manifest.entry, "LICENSE"];
  for (const lang of ["en", "nl", "fr", "de"]) files.push(`locales/${lang}.json`);
  for (const group of Object.values(manifest.assets ?? {})) {
    if (!group || typeof group !== "object") continue;
    for (const rel of Object.values(group)) {
      if (typeof rel === "string") files.push(rel);
    }
  }
  return [...new Set(files)].sort();
}

export function assertCatalogAllowlist(files) {
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    if (FORBIDDEN.some((prefix) => normalized === prefix || normalized.startsWith(prefix))) {
      throw new Error(`Catalog ZIP must not include ${normalized}`);
    }
  }
}

function zipCommand(outFile) {
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path * -DestinationPath "${outFile}" -Force`,
      ],
    };
  }
  return { command: "zip", args: ["-X", "-r", "-q", outFile, "."] };
}

export function packageCatalog(root = ROOT) {
  const manifest = JSON.parse(readFileSync(path.join(root, "openpets.plugin.json"), "utf8"));
  const files = catalogPackageFiles(manifest, root);
  assertCatalogAllowlist(files);

  const zipName = `${manifest.id}-${manifest.version}.zip`;
  const zipPath = path.join(DIST, zipName);
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });

  for (const rel of files) {
    const from = path.join(root, rel);
    const to = path.join(STAGING, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  }

  const spec = zipCommand(zipPath);
  const packed = spawnSync(spec.command, spec.args, { cwd: STAGING, stdio: "inherit", windowsHide: true });
  if (packed.status !== 0) throw new Error(`zip failed with status ${packed.status}`);

  const bytes = readFileSync(zipPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(path.join(DIST, `${zipName}.sha256`), `${sha256}  ${zipName}\n`);
  rmSync(STAGING, { recursive: true, force: true });

  return { zipPath, zipName, sha256, files, version: manifest.version, id: manifest.id };
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const result = packageCatalog();
  console.log(`Catalog ZIP ${result.zipName}`);
  console.log(`SHA-256 ${result.sha256}`);
  console.log(`Files:\n${result.files.map((file) => `- ${file}`).join("\n")}`);
}
