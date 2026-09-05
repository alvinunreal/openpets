import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const commandTimeoutMs = 2_500;

export type ExtendedSystemMetrics = {
  /** Aggregate GPU utilisation when the platform exposes it. */
  gpuPercent?: number;
  /** Used capacity of the system volume, not a per-app or per-file measurement. */
  diskUsedPercent?: number;
};

export function createStaleWhileRevalidateCache(
  read: () => Promise<ExtendedSystemMetrics>,
  options: { ttlMs: number; now?: () => number },
): () => ExtendedSystemMetrics {
  const clock = options.now ?? Date.now;
  let cached: { expiresAt: number; value: ExtendedSystemMetrics } | undefined;
  let inFlight: Promise<void> | undefined;

  return () => {
    if (cached && cached.expiresAt > clock()) return cached.value;
    if (!inFlight) {
      inFlight = read()
        .then((value) => {
          cached = { value, expiresAt: clock() + options.ttlMs };
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = undefined;
        });
    }
    return cached?.value ?? {};
  };
}

type CommandRunner = (command: string, args: string[], timeoutMs?: number) => Promise<string>;
type StatFsReader = (path: string) => Promise<{ blocks: number | bigint; bfree: number | bigint }>;
type TextFileReader = (path: string) => Promise<string>;
type DirectoryReader = (path: string) => Promise<string[]>;

function clampPercent(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseIoregPercent(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0 || value > 100) return undefined;
  return Math.round(value);
}

function averagePercentFromText(text: string): number | undefined {
  const values = text.match(/\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) ?? [];
  if (values.length === 0) return undefined;
  return clampPercent(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function gpuPercentFromIoreg(text: string): number | undefined {
  const match = text.match(/(?:Device|Renderer) Utilization %"?\s*=\s*(\d+(?:\.\d+)?)/);
  return match ? parseIoregPercent(Number(match[1])) : undefined;
}

export function diskUsedPercentFromStatFs(stat: { blocks: number | bigint; bfree: number | bigint }): number | undefined {
  const blocks = Number(stat.blocks);
  const free = Number(stat.bfree);
  if (!Number.isFinite(blocks) || !Number.isFinite(free) || blocks <= 0) return undefined;
  return clampPercent(((blocks - free) / blocks) * 100);
}

async function defaultRun(command: string, args: string[], timeoutMs = commandTimeoutMs): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 });
  return String(stdout ?? "");
}

async function linuxGpuPercent(readFile: TextFileReader, readDirectory: DirectoryReader): Promise<number | undefined> {
  try {
    const percents = await Promise.all(
      (await readDirectory("/sys/class/drm"))
        .filter((entry) => /^card\d+$/.test(entry))
        .map((entry) => readFile(`/sys/class/drm/${entry}/device/gpu_busy_percent`).then(averagePercentFromText).catch(() => undefined)),
    );
    const available = percents.filter((percent): percent is number => percent !== undefined);
    return available.length > 0 ? Math.round(available.reduce((sum, percent) => sum + percent, 0) / available.length) : undefined;
  } catch {
    return undefined;
  }
}

async function gpuPercentForPlatform(
  platform: NodeJS.Platform,
  run: CommandRunner,
  readFile: TextFileReader,
  readDirectory: DirectoryReader,
): Promise<number | undefined> {
  if (platform === "darwin") {
    const [ioGpu, ioAccelerator] = await Promise.all([
      run("ioreg", ["-r", "-d", "2", "-w", "0", "-c", "IOGPU"]).then(gpuPercentFromIoreg).catch(() => undefined),
      run("ioreg", ["-r", "-d", "2", "-w", "0", "-c", "IOAccelerator"]).then(gpuPercentFromIoreg).catch(() => undefined),
    ]);
    return ioGpu ?? ioAccelerator;
  }

  const nvidia = run("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"])
    .then(averagePercentFromText)
    .catch(() => undefined);

  if (platform === "win32") {
    const command = [
      "$c = Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue;",
      "if (-not $c) { exit 0 };",
      "$samples = $c.CounterSamples | Where-Object { $_.InstanceName -match 'engtype_3D' };",
      "if (-not $samples) { $samples = $c.CounterSamples };",
      "($samples | Measure-Object -Property CookedValue -Average).Average",
    ].join(" ");
    const windows = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command])
      .then(averagePercentFromText)
      .catch(() => undefined);
    const [nvidiaPercent, windowsPercent] = await Promise.all([nvidia, windows]);
    return nvidiaPercent ?? windowsPercent;
  }

  if (platform !== "linux") return undefined;
  const [nvidiaPercent, linuxPercent] = await Promise.all([nvidia, linuxGpuPercent(readFile, readDirectory)]);
  return nvidiaPercent ?? linuxPercent;
}

export async function readExtendedSystemMetrics(
  options: {
    platform?: NodeJS.Platform;
    run?: CommandRunner;
    statfs?: StatFsReader;
    readFile?: TextFileReader;
    readDirectory?: DirectoryReader;
  } = {},
): Promise<ExtendedSystemMetrics> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRun;
  const statfs = options.statfs ?? ((path) => fs.statfs(path));
  const readFile = options.readFile ?? ((path) => fs.readFile(path, "utf8"));
  const readDirectory = options.readDirectory ?? ((path) => fs.readdir(path));
  const volumePath = platform === "win32" ? `${process.env.SystemDrive || "C:"}\\` : "/";

  const [gpu, disk] = await Promise.all([
    gpuPercentForPlatform(platform, run, readFile, readDirectory),
    statfs(volumePath).then(diskUsedPercentFromStatFs).catch(() => undefined),
  ]);

  return {
    ...(gpu === undefined ? {} : { gpuPercent: gpu }),
    ...(disk === undefined ? {} : { diskUsedPercent: disk }),
  };
}
