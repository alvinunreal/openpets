import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

export async function readBoundedRegularFile(path: string, maxBytes: number, label: string): Promise<Buffer> {
  const resolved = resolve(path);
  const stats = await lstat(resolved);
  if (stats.isSymbolicLink()) throw new Error(`${label} cannot be a symlink.`);
  if (!stats.isFile()) throw new Error(`${label} must be a file.`);
  if (stats.size <= 0 || stats.size > maxBytes) throw new Error(`${label} size is invalid.`);
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStats = await file.stat();
    if (!openedStats.isFile() || openedStats.size !== stats.size || openedStats.size <= 0 || openedStats.size > maxBytes) throw new Error(`${label} size is invalid.`);
    return await file.readFile();
  } finally {
    await file.close();
  }
}
