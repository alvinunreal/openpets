import os from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveOs } from "../platform.js";

const execFileAsync = promisify(execFile);

let lastCpu = null;

export const METRICS_PORT = 37647;

export function clampPercent(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

export function cpuPercentFromSamples(previous, current) {
  if (!previous || !current) return null;
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0) return null;
  return clampPercent(100 - (idleDelta / totalDelta) * 100);
}

export function memUsedPercent() {
  const total = os.totalmem();
  if (!total) return null;
  return clampPercent(((total - os.freemem()) / total) * 100);
}

export function parseGpuUtilization(text) {
  if (typeof text !== "string" || !text) return null;
  const device = text.match(/"Device Utilization %"\s*=\s*(\d+)/);
  if (device) return clampPercent(Number(device[1]));
  const renderer = text.match(/"Renderer Utilization %"\s*=\s*(\d+)/);
  if (renderer) return clampPercent(Number(renderer[1]));
  return parseNvidiaSmi(text);
}

export function parseNvidiaSmi(text) {
  if (typeof text !== "string" || !text) return null;
  const values = text
    .split(/\n+/)
    .map((line) => clampPercent(line.trim().replace(/%/g, "")))
    .filter((value) => value != null);
  if (!values.length) return null;
  return Math.max(...values);
}

export function parseDfCapacity(text, preferredMount) {
  if (typeof text !== "string" || !text) return null;
  const lines = text.trim().split(/\n+/);
  let fallback = null;
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const mount = parts[parts.length - 1];
    const percent = clampPercent(String(parts[4]).replace("%", ""));
    if (percent == null) continue;
    if (preferredMount && mount === preferredMount) return percent;
    if (mount === "/") fallback = percent;
    if (fallback == null) fallback = percent;
  }
  return fallback;
}

export function parseWmicCsvDisk(text) {
  if (typeof text !== "string" || !text) return null;
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0].split(",").map((cell) => cell.trim().toLowerCase());
  const sizeIdx = header.indexOf("size");
  const freeIdx = header.indexOf("freespace");
  if (sizeIdx < 0 || freeIdx < 0) return null;
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const size = Number(cells[sizeIdx]);
    const free = Number(cells[freeIdx]);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(free)) continue;
    return clampPercent(((size - free) / size) * 100);
  }
  return null;
}

export function parseNumberPercent(text) {
  if (typeof text !== "string" || !text) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  return clampPercent(Number(match[0]));
}

async function run(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    timeout: 2500,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
  return String(stdout ?? "");
}

async function sampleNvidiaGpu() {
  const text = await run("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"]);
  return parseNvidiaSmi(text);
}

async function sampleMacGpu() {
  try {
    const text = await run("ioreg", ["-r", "-d", "2", "-w", "0", "-c", "IOGPU"]);
    const percent = parseGpuUtilization(text);
    if (percent != null) return { percent, source: "ioreg-iogpu" };
  } catch {}
  const text = await run("ioreg", ["-r", "-d", "2", "-w", "0", "-c", "IOAccelerator"]);
  return { percent: parseGpuUtilization(text), source: "ioreg-accelerator" };
}

async function sampleWindowsGpu() {
  try {
    const percent = await sampleNvidiaGpu();
    if (percent != null) return { percent, source: "nvidia-smi" };
  } catch {}

  const ps = [
    "$c = Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue;",
    "if (-not $c) { exit 0 };",
    "$samples = $c.CounterSamples | Where-Object { $_.InstanceName -match 'engtype_3D' };",
    "if (-not $samples) { $samples = $c.CounterSamples };",
    "($samples | Measure-Object -Property CookedValue -Average).Average",
  ].join(" ");
  try {
    const text = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 4000 });
    const percent = parseNumberPercent(text);
    if (percent != null) return { percent, source: "gpu-engine" };
  } catch {}
  return { percent: null, source: null };
}

async function sampleLinuxGpu() {
  try {
    const percent = await sampleNvidiaGpu();
    if (percent != null) return { percent, source: "nvidia-smi" };
  } catch {}

  try {
    const drmRoot = "/sys/class/drm";
    const entries = await readdir(drmRoot);
    const percents = [];
    for (const name of entries) {
      if (!/^card\d+$/.test(name)) continue;
      try {
        const raw = await readFile(`${drmRoot}/${name}/device/gpu_busy_percent`, "utf8");
        const percent = parseNumberPercent(raw);
        if (percent != null) percents.push(percent);
      } catch {}
    }
    if (percents.length) return { percent: Math.max(...percents), source: "sysfs-gpu-busy" };
  } catch {}
  return { percent: null, source: null };
}

async function sampleMacSsd() {
  try {
    const data = await run("df", ["-k", "/System/Volumes/Data"]);
    const percent = parseDfCapacity(data, "/System/Volumes/Data");
    if (percent != null) return { percent, source: "df-data" };
  } catch {}
  const root = await run("df", ["-Pk", "/"]);
  return { percent: parseDfCapacity(root, "/"), source: "df-root" };
}

async function sampleWindowsSsd() {
  const drive = `${(process.env.SystemDrive || "C:").replace(/\\/g, "")}`;
  try {
    const text = await run("wmic", [
      "logicaldisk",
      "where",
      `DeviceID='${drive}'`,
      "get",
      "FreeSpace,Size",
      "/format:csv",
    ]);
    const percent = parseWmicCsvDisk(text);
    if (percent != null) return { percent, source: "wmic" };
  } catch {}

  const ps = `$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'"; if ($d -and $d.Size) { [int]((($d.Size - $d.FreeSpace) / $d.Size) * 100) }`;
  const text = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  return { percent: parseNumberPercent(text), source: "cim-logicaldisk" };
}

async function sampleLinuxSsd() {
  const root = await run("df", ["-Pk", "/"]);
  return { percent: parseDfCapacity(root, "/"), source: "df-root" };
}

export async function sampleGpu(osId) {
  try {
    if (osId === "mac") return await sampleMacGpu();
    if (osId === "windows") return await sampleWindowsGpu();
    if (osId === "linux") return await sampleLinuxGpu();
  } catch {}
  return { percent: null, source: null };
}

export async function sampleSsd(osId) {
  try {
    if (osId === "mac") return await sampleMacSsd();
    if (osId === "windows") return await sampleWindowsSsd();
    if (osId === "linux") return await sampleLinuxSsd();
  } catch {}
  return { percent: null, source: null };
}

export function sampleCpu() {
  const current = cpuTimes();
  const percent = cpuPercentFromSamples(lastCpu, current);
  lastCpu = current;
  return percent;
}

export function resetCpuSample() {
  lastCpu = null;
}

export async function collectMetrics(options = {}) {
  const osId = resolveOs(options.platform, process.platform);
  const cpu = sampleCpu();
  const mem = memUsedPercent();
  const [gpu, ssd] = await Promise.all([sampleGpu(osId), sampleSsd(osId)]);
  return {
    cpuPercent: cpu,
    memUsedPercent: mem,
    gpuPercent: gpu.percent,
    ssdUsedPercent: ssd.percent,
    platform: osId,
    sources: { gpu: gpu.source, ssd: ssd.source },
    sampledAt: Date.now(),
  };
}
