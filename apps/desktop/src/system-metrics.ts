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

type CommandRunner = (command: string, args: string[], timeoutMs?: number) => Promise<string>;
type StatFsReader = (path: string) => Promise<{ blocks: number | bigint; bfree: number | bigint }>;
type TextFileReader = (path: string) => Promise<string>;
type DirectoryReader = (path: string) => Promise<string[]>;

function clampPercent(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function percentFromText(text: string): number | undefined {
  const values = text.match(/\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) ?? [];
  if (values.length === 0) return undefined;
  return clampPercent(Math.max(...values));
}

export function gpuPercentFromIoreg(text: string): number | undefined {
  const match = text.match(/(?:Device|Renderer) Utilization %"?\s*=\s*(\d+(?:\.\d+)?)/);
  return match ? clampPercent(Number(match[1])) : undefined;
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

async function gpuPercentForPlatform(
  platform: NodeJS.Platform,
  run: CommandRunner,
  readFile: TextFileReader,
  readDirectory: DirectoryReader,
): Promise<number | undefined> {
  if (platform === "darwin") {
    try {
      const percent = gpuPercentFromIoreg(await run("ioreg", ["-r", "-d", "2", "-w", "0", "-c", "IOGPU"]));
      if (percent !== undefined) return percent;
    } catch {}
    try {
      return gpuPercentFromIoreg(await run("ioreg", ["-r", "-d", "2", "-w", "0", "-c", "IOAccelerator"]));
    } catch {
      return undefined;
    }
  }

  try {
    const nvidia = percentFromText(await run("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"]));
    if (nvidia !== undefined) return nvidia;
  } catch {}

  if (platform === "win32") {
    const command = [
      "$c = Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue;",
      "if (-not $c) { exit 0 };",
      "$samples = $c.CounterSamples | Where-Object { $_.InstanceName -match 'engtype_3D' };",
      "if (-not $samples) { $samples = $c.CounterSamples };",
      "($samples | Measure-Object -Property CookedValue -Maximum).Maximum",
    ].join(" ");
    try {
      return percentFromText(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], 4_000));
    } catch {
      return undefined;
    }
  }

  if (platform !== "linux") return undefined;
  try {
    const percents: number[] = [];
    for (const entry of await readDirectory("/sys/class/drm")) {
      if (!/^card\d+$/.test(entry)) continue;
      try {
        const percent = percentFromText(await readFile(`/sys/class/drm/${entry}/device/gpu_busy_percent`));
        if (percent !== undefined) percents.push(percent);
      } catch {}
    }
    return percents.length > 0 ? Math.max(...percents) : undefined;
  } catch {
    return undefined;
  }
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
