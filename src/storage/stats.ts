import { query } from "../clients/clickhouse.js";
import { volumeUsage, type DockerVolumeUsage } from "../clients/docker.js";
import { pgQuery } from "../clients/postgres.js";
import { listObjects } from "../clients/s3.js";
import { config, type S3Target } from "../config.js";
import { errorMessage, log } from "../logger.js";
import { tableFootprints, type TableFootprint } from "../purge/estimate.js";
import {
  filesystemUsage,
  measureDirectory,
  parseDiskPaths,
  type FilesystemUsage,
} from "./disk.js";

export interface SizedEntry {
  name: string;
  bytes: number;
  /** Secondary metric: rows for tables, object count for buckets. */
  count?: number;
  detail?: string;
}

export interface StorageSnapshot {
  generatedAt: string;
  /** Wall-clock cost of building this snapshot, so the UI can explain a slow refresh. */
  tookMs: number;
  volumes: {
    available: boolean;
    error?: string;
    entries: SizedEntry[];
    total: number;
    /** How the entries were measured, so the UI can title the card honestly. */
    source: "docker" | "disk" | "both" | "none";
  };
  /** Free space on the filesystems behind the configured data directories. */
  filesystems: FilesystemUsage[];
  clickhouse: { available: boolean; error?: string; entries: SizedEntry[]; total: number; uncompressedTotal: number };
  objectStorage: { available: boolean; error?: string; entries: SizedEntry[]; total: number; objectCount: number };
  postgres: { available: boolean; error?: string; entries: SizedEntry[]; total: number };
  backlog: {
    pendingDeletions: number | null;
    runningMutations: number | null;
    error?: string;
  };
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

async function cached<T>(key: string, ttlSeconds: number, producer: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await producer();
  cache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  return value;
}

export function invalidateStorageCache(): void {
  cache.clear();
}

/** Volumes Langfuse's own compose file declares, so we can label unknown ones. */
const KNOWN_VOLUME_HINTS: Array<[RegExp, string]> = [
  [/clickhouse_logs/i, "ClickHouse server logs"],
  [/clickhouse/i, "ClickHouse data (traces, observations, scores)"],
  [/minio/i, "MinIO (raw events, media, exports)"],
  [/postgres/i, "Postgres (projects, config, media index)"],
  [/redis/i, "Redis (queues, cache)"],
];

function describeVolume(name: string): string | undefined {
  return KNOWN_VOLUME_HINTS.find(([pattern]) => pattern.test(name))?.[1];
}

async function collectDockerVolumes(): Promise<{ entries: SizedEntry[]; error?: string }> {
  if (!config.docker.enabled) {
    return { entries: [], error: "Docker stats disabled (DOCKER_STATS_ENABLED=false)." };
  }
  try {
    const volumes = await cached<DockerVolumeUsage[]>("docker:volumes", config.docker.cacheSeconds, () =>
      volumeUsage(),
    );
    // A shared host runs other people's stacks. Prefer volumes from this compose
    // project; where that cannot be determined, fall back to recognisable
    // Langfuse volume names so the list stays about Langfuse either way.
    const scoped = volumes.filter((v) => (v.inStack === undefined ? Boolean(describeVolume(v.name)) : v.inStack));
    const chosen = scoped.length > 0 ? scoped : volumes.filter((v) => describeVolume(v.name));

    return {
      entries: chosen.map<SizedEntry>((v) => ({
        name: v.name,
        bytes: v.size,
        detail: describeVolume(v.name) ?? `${v.refCount} container(s)`,
      })),
    };
  } catch (e) {
    return {
      entries: [],
      error: `${errorMessage(e)} Mount /var/run/docker.sock:ro to enable volume sizes.`,
    };
  }
}

async function collectDiskPaths(): Promise<{ entries: SizedEntry[]; error?: string }> {
  const targets = parseDiskPaths(config.diskPaths);
  if (targets.length === 0) return { entries: [] };

  try {
    const sizes = await cached("disk:paths", config.docker.cacheSeconds, () =>
      Promise.all(targets.map(measureDirectory)),
    );
    return {
      entries: sizes.map<SizedEntry>((s) => ({
        name: s.label,
        bytes: s.error ? -1 : s.bytes,
        count: s.files,
        detail: s.error
          ? `${s.path} — ${s.error}`
          : [
              s.path,
              s.truncated ? "partial: entry cap reached" : "",
              s.unreadableDirs > 0
                ? `at least ${s.unreadableDirs} dir(s) unreadable — this is a lower bound`
                : "",
            ]
              .filter(Boolean)
              .join(" · "),
      })),
    };
  } catch (e) {
    return { entries: [], error: errorMessage(e) };
  }
}

/**
 * One "what is on disk" view, whichever way the stack stores its data.
 *
 * Named volumes come from the Docker daemon; bind-mounted data directories are
 * measured directly. The two never overlap — a bind mount is not a Docker volume
 * — so when both are present they simply concatenate.
 */
async function collectVolumes(): Promise<StorageSnapshot["volumes"]> {
  const [docker, disk] = await Promise.all([collectDockerVolumes(), collectDiskPaths()]);
  const entries = [...disk.entries, ...docker.entries].sort((a, b) => b.bytes - a.bytes);

  const source: StorageSnapshot["volumes"]["source"] =
    disk.entries.length > 0 && docker.entries.length > 0
      ? "both"
      : disk.entries.length > 0
        ? "disk"
        : docker.entries.length > 0
          ? "docker"
          : "none";

  return {
    available: entries.length > 0,
    error: entries.length > 0 ? undefined : [disk.error, docker.error].filter(Boolean).join(" "),
    entries,
    total: entries.reduce((sum, e) => sum + Math.max(0, e.bytes), 0),
    source,
  };
}

async function collectClickhouse(): Promise<StorageSnapshot["clickhouse"]> {
  try {
    const footprints = await cached<TableFootprint[]>("clickhouse:tables", 60, tableFootprints);
    const entries = footprints.map<SizedEntry>((f) => ({
      name: f.table,
      bytes: f.bytesOnDisk,
      count: f.rows,
      detail:
        f.uncompressedBytes > 0
          ? `${(f.uncompressedBytes / Math.max(1, f.bytesOnDisk)).toFixed(1)}x compression`
          : undefined,
    }));
    return {
      available: true,
      entries,
      total: entries.reduce((sum, e) => sum + e.bytes, 0),
      uncompressedTotal: footprints.reduce((sum, f) => sum + f.uncompressedBytes, 0),
    };
  } catch (e) {
    return { available: false, error: errorMessage(e), entries: [], total: 0, uncompressedTotal: 0 };
  }
}

/**
 * Object storage, grouped by the prefix each Langfuse use-case writes to.
 *
 * There is no cheap size API in S3, so this walks the listing. On a bucket with
 * millions of event blobs it takes a while, which is exactly why it is cached and
 * refreshed explicitly rather than on every page load.
 */
async function collectObjectStorage(): Promise<StorageSnapshot["objectStorage"]> {
  const targets: Array<{ label: string; target: S3Target }> = [
    { label: "Raw ingestion events", target: config.s3.events },
    { label: "Media assets", target: config.s3.media },
    { label: "Batch exports", target: config.s3.exports },
  ];

  try {
    return await cached("s3:sizes", 900, async () => {
      const entries: SizedEntry[] = [];
      // Distinct bucket+prefix pairs only: the default compose points all three at
      // one bucket with different prefixes, but they can be split.
      const seen = new Set<string>();

      for (const { label, target } of targets) {
        const key = `${target.bucket}/${target.prefix}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let bytes = 0;
        let count = 0;
        let oldest: Date | undefined;
        for await (const obj of listObjects(target)) {
          bytes += obj.size;
          count += 1;
          if (obj.lastModified && (!oldest || obj.lastModified < oldest)) oldest = obj.lastModified;
        }
        entries.push({
          name: key,
          bytes,
          count,
          detail: oldest ? `${label} · oldest ${oldest.toISOString().slice(0, 10)}` : label,
        });
      }

      entries.sort((a, b) => b.bytes - a.bytes);
      return {
        available: true,
        entries,
        total: entries.reduce((sum, e) => sum + e.bytes, 0),
        objectCount: entries.reduce((sum, e) => sum + (e.count ?? 0), 0),
      };
    });
  } catch (e) {
    return { available: false, error: errorMessage(e), entries: [], total: 0, objectCount: 0 };
  }
}

async function collectPostgres(): Promise<StorageSnapshot["postgres"]> {
  try {
    const rows = await cached("postgres:tables", 60, () =>
      pgQuery<{ name: string; bytes: string; rows: string }>(
        `SELECT c.relname                              AS name,
                pg_total_relation_size(c.oid)          AS bytes,
                GREATEST(c.reltuples, 0)::bigint       AS rows
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND n.nspname = 'public'
          ORDER BY pg_total_relation_size(c.oid) DESC
          LIMIT 20`,
      ),
    );
    const entries = rows.map<SizedEntry>((r) => ({
      name: r.name,
      bytes: Number(r.bytes),
      count: Number(r.rows),
      detail: "estimated row count",
    }));

    const [dbSize] = await pgQuery<{ bytes: string }>(`SELECT pg_database_size(current_database()) AS bytes`);
    return { available: true, entries, total: Number(dbSize?.bytes ?? 0) };
  } catch (e) {
    return { available: false, error: errorMessage(e), entries: [], total: 0 };
  }
}

/**
 * How much deletion work is still queued.
 *
 * API-mode trace deletion is asynchronous: the endpoint returns immediately and
 * langfuse-worker drains `pending_deletions`. A backlog that never shrinks means
 * the worker is stuck, which is the difference between "retention ran" and
 * "retention worked".
 */
async function collectBacklog(): Promise<StorageSnapshot["backlog"]> {
  const backlog: StorageSnapshot["backlog"] = { pendingDeletions: null, runningMutations: null };
  try {
    const [pending] = await pgQuery<{ c: string }>(
      `SELECT count(*) AS c FROM pending_deletions WHERE is_deleted = false`,
    );
    backlog.pendingDeletions = Number(pending?.c ?? 0);
  } catch (e) {
    // Older Langfuse versions have no pending_deletions table.
    backlog.error = errorMessage(e);
  }
  try {
    const [mutations] = await query<{ c: string }>(
      `SELECT count() AS c FROM system.mutations WHERE is_done = 0 AND database = {db:String}`,
      { db: config.clickhouse.database },
    );
    backlog.runningMutations = Number(mutations?.c ?? 0);
  } catch (e) {
    backlog.error = backlog.error ?? errorMessage(e);
  }
  return backlog;
}

export async function storageSnapshot(): Promise<StorageSnapshot> {
  const started = Date.now();
  const [volumes, clickhouse, objectStorage, postgres, backlog, filesystems] = await Promise.all([
    collectVolumes(),
    collectClickhouse(),
    collectObjectStorage(),
    collectPostgres(),
    collectBacklog(),
    filesystemUsage(parseDiskPaths(config.diskPaths)),
  ]);

  const snapshot: StorageSnapshot = {
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - started,
    volumes,
    filesystems,
    clickhouse,
    objectStorage,
    postgres,
    backlog,
  };
  log.debug("storage snapshot built", { tookMs: snapshot.tookMs });
  return snapshot;
}
