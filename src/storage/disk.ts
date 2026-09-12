import { readdir, lstat, statfs } from "node:fs/promises";
import { join } from "node:path";

import { errorMessage } from "../logger.js";

/**
 * Direct filesystem measurement, for stacks that bind-mount their data
 * directories instead of using named Docker volumes.
 *
 * `docker system df` only knows about named volumes, so on a compose file that
 * mounts e.g. /mnt/data/langfuse/clickhouse/_data the volumes card would be
 * empty. Pointing RETENTION_DISK_PATHS at those directories (mounted read-only
 * into this container) measures them directly, and reports the free space on the
 * filesystem holding them — usually the number people actually care about.
 */

export interface DiskPath {
  label: string;
  path: string;
}

export interface DirectorySize {
  label: string;
  path: string;
  bytes: number;
  files: number;
  error?: string;
  /** True when the walk hit the entry cap and the size is a lower bound. */
  truncated?: boolean;
  /**
   * Directories the walk could not read, usually because the data belongs to
   * another uid (ClickHouse runs as 101:101 with a 0750 data dir, Postgres as
   * 0700). Any non-zero value means the byte total is a lower bound, so it is
   * surfaced rather than silently swallowed.
   */
  unreadableDirs: number;
}

export interface FilesystemUsage {
  /** The mount point label, derived from the paths that resolve to it. */
  label: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

/** `Label=/path` pairs, comma-separated. A bare path is labelled by its last segment. */
export function parseDiskPaths(raw: string | undefined): DiskPath[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const split = entry.indexOf("=");
      if (split < 0) {
        const segments = entry.replace(/\/+$/, "").split("/");
        return { label: segments[segments.length - 1] || entry, path: entry };
      }
      return { label: entry.slice(0, split).trim(), path: entry.slice(split + 1).trim() };
    })
    .filter((p) => p.path.length > 0);
}

/** Stop walking a pathological tree rather than hanging the storage snapshot. */
const MAX_ENTRIES = 2_000_000;

export async function measureDirectory(target: DiskPath): Promise<DirectorySize> {
  const result: DirectorySize = { label: target.label, path: target.path, bytes: 0, files: 0, unreadableDirs: 0 };
  const queue: string[] = [target.path];

  try {
    // Confirm the root exists before walking, so a typo reports clearly rather
    // than silently measuring zero.
    await lstat(target.path);
  } catch (e) {
    result.error = errorMessage(e);
    return result;
  }

  while (queue.length > 0) {
    const dir = queue.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // An unreadable subdirectory shouldn't void the whole measurement, but it
      // does make the total a lower bound, so it is counted and reported.
      result.unreadableDirs += 1;
      continue;
    }

    for (const entry of entries) {
      if (result.files >= MAX_ENTRIES) {
        result.truncated = true;
        return result;
      }
      const full = join(dir, entry.name);
      // Symlinks are skipped rather than followed: ClickHouse and MinIO both use
      // them internally and following would double-count or loop.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stats = await lstat(full);
        result.bytes += stats.size;
        result.files += 1;
      } catch {
        // File vanished mid-walk (ClickHouse merges do this constantly).
      }
    }
  }
  return result;
}

/**
 * Free space per distinct filesystem behind the configured paths.
 *
 * Several paths usually share one mount, so results are de-duplicated by
 * total-size + free-size, and the labels are merged.
 */
export async function filesystemUsage(paths: DiskPath[]): Promise<FilesystemUsage[]> {
  const byFilesystem = new Map<string, FilesystemUsage>();

  for (const target of paths) {
    try {
      const stats = await statfs(target.path);
      const blockSize = Number(stats.bsize);
      const totalBytes = Number(stats.blocks) * blockSize;
      // bavail, not bfree: bfree includes blocks reserved for root.
      const freeBytes = Number(stats.bavail) * blockSize;
      const usedBytes = totalBytes - freeBytes;
      const key = `${totalBytes}:${stats.blocks}`;

      const existing = byFilesystem.get(key);
      if (existing) {
        if (!existing.label.includes(target.label)) existing.label += `, ${target.label}`;
        continue;
      }
      byFilesystem.set(key, {
        label: target.label,
        path: target.path,
        totalBytes,
        freeBytes,
        usedBytes,
        usedPercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
      });
    } catch {
      // statfs is unsupported on some platforms; free space is a bonus, not a
      // requirement, so a failure here never breaks the snapshot.
    }
  }

  return [...byFilesystem.values()];
}
