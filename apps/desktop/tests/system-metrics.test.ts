import assert from "node:assert/strict";

import {
  createStaleWhileRevalidateCache,
  diskUsedPercentFromStatFs,
  gpuPercentFromIoreg,
  readExtendedSystemMetrics,
  type ExtendedSystemMetrics,
} from "../src/system-metrics.js";

// The SDK exposes aggregate, bounded values only: unavailable hardware omits a metric.
assert.equal(diskUsedPercentFromStatFs({ blocks: 100, bfree: 25 }), 75);
assert.equal(diskUsedPercentFromStatFs({ blocks: 0, bfree: 0 }), undefined);
// macOS APFS statfs("/") reports shared System/Data container capacity, not
// the sealed System snapshot's per-volume `df` usage.
const apfsVolumeGroupStat = {
  type: 26,
  bsize: 4096,
  blocks: 122_061_322,
  bfree: 59_471_280,
  bavail: 59_471_280,
};
assert.equal(diskUsedPercentFromStatFs(apfsVolumeGroupStat), 51);
assert.equal(gpuPercentFromIoreg('"Device Utilization %" = 41'), 41);
assert.equal(gpuPercentFromIoreg('"Device Utilization %" = 201'), undefined);
assert.equal(gpuPercentFromIoreg('"Device Utilization % at cur p-state" = 68'), undefined);
assert.equal(gpuPercentFromIoreg("unavailable"), undefined);

{
  const calls: Array<{ command: string; args: string[] }> = [];
  let volumePath = "";
  const metrics = await readExtendedSystemMetrics({
    platform: "darwin",
    run: async (command, args) => {
      calls.push({ command, args });
      return args.at(-1) === "IOGPU" ? "no aggregate utilization" : '"Renderer Utilization %" = 37';
    },
    statfs: async (path) => {
      volumePath = path;
      return { blocks: 100, bfree: 23 };
    },
    readDirectory: async () => [],
    readFile: async () => "",
  });
  assert.deepEqual(metrics, { gpuPercent: 37, diskUsedPercent: 77 });
  assert.deepEqual(calls, [
    { command: "ioreg", args: ["-r", "-d", "2", "-w", "0", "-c", "IOGPU"] },
    { command: "ioreg", args: ["-r", "-d", "2", "-w", "0", "-c", "IOAccelerator"] },
  ]);
  assert.equal(volumePath, "/");
}

{
  const metrics = await readExtendedSystemMetrics({
    platform: "darwin",
    run: async (_, args) => args.at(-1) === "IOGPU"
      ? ""
      : '"Device Utilization % at cur p-state" = 68, "Device Unit 0 Utilization %" = 68, "Device Utilization %" = 201',
    statfs: async () => ({ blocks: 100, bfree: 23 }),
    readDirectory: async () => [],
    readFile: async () => "",
  });
  assert.deepEqual(metrics, { diskUsedPercent: 77 });
}

{
  const metrics = await readExtendedSystemMetrics({
    platform: "linux",
    run: async () => { throw new Error("nvidia-smi is unavailable"); },
    statfs: async () => ({ blocks: 200, bfree: 50 }),
    readDirectory: async () => ["card0", "card1", "renderD128"],
    readFile: async (path) => {
      if (path === "/sys/class/drm/card0/device/gpu_busy_percent") return "37\n";
      if (path === "/sys/class/drm/card1/device/gpu_busy_percent") return "63\n";
      throw new Error(`Unexpected path: ${path}`);
    },
  });
  assert.deepEqual(metrics, { gpuPercent: 50, diskUsedPercent: 75 });
}

{
  let volumePath = "";
  const metrics = await readExtendedSystemMetrics({
    platform: "win32",
    run: async (command, args) => {
      assert.equal(command, "nvidia-smi");
      assert.deepEqual(args, ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"]);
      return "61\n";
    },
    statfs: async (path) => {
      volumePath = path;
      return { blocks: 100, bfree: 40 };
    },
    readDirectory: async () => [],
    readFile: async () => "",
  });
  assert.deepEqual(metrics, { gpuPercent: 61, diskUsedPercent: 60 });
  assert.equal(volumePath, `${process.env.SystemDrive || "C:"}\\`);
}

function deferred<T>() {
  let resolveValue!: (value: T) => void;
  let rejectValue!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

async function settlePromises() {
  await Promise.resolve();
  await Promise.resolve();
}

{
  let now = 0;
  let calls = 0;
  const first = deferred<ExtendedSystemMetrics>();
  const cache = createStaleWhileRevalidateCache(
    () => {
      calls += 1;
      return first.promise;
    },
    { ttlMs: 5, now: () => now },
  );

  assert.deepEqual(cache(), {});
  assert.equal(calls, 1);
  first.resolve({ diskUsedPercent: 51 });
  await first.promise;
  await settlePromises();
}

{
  let now = 0;
  let calls = 0;
  const refresh = deferred<ExtendedSystemMetrics>();
  const cache = createStaleWhileRevalidateCache(
    () => {
      calls += 1;
      return calls === 1 ? Promise.resolve({ diskUsedPercent: 51 }) : refresh.promise;
    },
    { ttlMs: 5, now: () => now },
  );

  assert.deepEqual(cache(), {});
  await settlePromises();
  now = 6;
  assert.deepEqual(cache(), { diskUsedPercent: 51 });
  assert.equal(calls, 2);
  refresh.resolve({ diskUsedPercent: 52 });
  await refresh.promise;
  await settlePromises();
}

{
  let now = 0;
  let calls = 0;
  const refresh = deferred<ExtendedSystemMetrics>();
  const cache = createStaleWhileRevalidateCache(
    () => {
      calls += 1;
      return calls === 1 ? Promise.resolve({ diskUsedPercent: 51 }) : refresh.promise;
    },
    { ttlMs: 5, now: () => now },
  );

  cache();
  await settlePromises();
  now = 6;
  cache();
  refresh.resolve({ diskUsedPercent: 49 });
  await refresh.promise;
  await settlePromises();
  assert.deepEqual(cache(), { diskUsedPercent: 49 });
}

{
  let now = 0;
  let calls = 0;
  const failedRefresh = deferred<ExtendedSystemMetrics>();
  const cache = createStaleWhileRevalidateCache(
    () => {
      calls += 1;
      return calls === 1 ? Promise.resolve({ diskUsedPercent: 51 }) : failedRefresh.promise;
    },
    { ttlMs: 5, now: () => now },
  );

  cache();
  await settlePromises();
  now = 6;
  assert.deepEqual(cache(), { diskUsedPercent: 51 });
  failedRefresh.reject(new Error("probe failed"));
  await failedRefresh.promise.catch(() => undefined);
  await settlePromises();
  assert.deepEqual(cache(), { diskUsedPercent: 51 });
}

{
  let now = 0;
  const cache = createStaleWhileRevalidateCache(
    () => Promise.resolve({ diskUsedPercent: 51 }),
    { ttlMs: 5, now: () => now },
  );

  cache();
  await settlePromises();
  assert.deepEqual(cache(), { diskUsedPercent: 51 });
  assert.equal(cache().gpuPercent, undefined);
  now = 6;
  assert.deepEqual(cache(), { diskUsedPercent: 51 });
}

console.log("system metrics: all checks passed.");
