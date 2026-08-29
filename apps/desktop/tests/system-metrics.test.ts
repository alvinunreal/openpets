import assert from "node:assert/strict";

import { diskUsedPercentFromStatFs, gpuPercentFromIoreg, readExtendedSystemMetrics } from "../src/system-metrics.js";

// The SDK exposes aggregate, bounded values only: unavailable hardware omits a metric.
assert.equal(diskUsedPercentFromStatFs({ blocks: 100, bfree: 25 }), 75);
assert.equal(diskUsedPercentFromStatFs({ blocks: 0, bfree: 0 }), undefined);
assert.equal(gpuPercentFromIoreg('"Device Utilization %" = 41'), 41);
assert.equal(gpuPercentFromIoreg("unavailable"), undefined);

{
  const metrics = await readExtendedSystemMetrics({
    platform: "linux",
    run: async () => { throw new Error("nvidia-smi is unavailable"); },
    statfs: async () => ({ blocks: 200, bfree: 50 }),
    readDirectory: async () => ["card0", "renderD128"],
    readFile: async (path) => {
      assert.equal(path, "/sys/class/drm/card0/device/gpu_busy_percent");
      return "37\n";
    },
  });
  assert.deepEqual(metrics, { gpuPercent: 37, diskUsedPercent: 75 });
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

console.log("system metrics: all checks passed.");
