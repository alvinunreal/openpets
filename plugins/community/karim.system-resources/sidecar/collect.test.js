import assert from "node:assert/strict";
import { resolveOs } from "../platform.js";
import {
  clampPercent,
  cpuPercentFromSamples,
  parseDfCapacity,
  parseGpuUtilization,
  parseNvidiaSmi,
  parseNumberPercent,
  parseWmicCsvDisk,
} from "./collect.mjs";

assert.equal(clampPercent(9.6), 10);
assert.equal(parseGpuUtilization(`"Device Utilization %"=17`), 17);
assert.equal(parseGpuUtilization(`{"Renderer Utilization %"=44}`), 44);
assert.equal(parseGpuUtilization("  42\n"), 42);
assert.equal(parseGpuUtilization(""), null);
assert.equal(parseNvidiaSmi("15\n88\n"), 88);
assert.equal(parseNumberPercent("  63.4 \n"), 63);

const df = `Filesystem     1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on
/dev/disk3s1s1   482746452  12341272 314377100     4%  458732 3143771000    0%   /
/dev/disk3s5     482746452 129618924 314376332    30% 1573814 3143763320    0%   /System/Volumes/Data
`;
assert.equal(parseDfCapacity(df, "/System/Volumes/Data"), 30);
assert.equal(parseDfCapacity(df, "/"), 4);

const wmic = `Node,FreeSpace,Size
PC,30000000000,100000000000
`;
assert.equal(parseWmicCsvDisk(wmic), 70);

assert.equal(resolveOs("auto", "win32"), "windows");
assert.equal(resolveOs("auto", "linux"), "linux");
assert.equal(resolveOs("mac", "win32"), "mac");

assert.equal(
  cpuPercentFromSamples({ idle: 80, total: 100 }, { idle: 85, total: 200 }),
  95,
);

console.log("sidecar collect: all checks passed.");
