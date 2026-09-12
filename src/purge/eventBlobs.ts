import { command, escapeIdentifier, existingTables, onCluster, query } from "../clients/clickhouse.js";
import { DELETE_BATCH_SIZE, deleteObjects, listObjects } from "../clients/s3.js";
import { config } from "../config.js";
import { errorMessage, log } from "../logger.js";
import type { ModuleResult } from "../types.js";
import { daysAgo, formatBytes, type ProjectPlan, type RunContext } from "./context.js";
import { toClickhouseDateTime } from "./traces.js";

/**
 * Raw ingestion event blobs.
 *
 * This is the module Langfuse has no equivalent for. Every ingested event is
 * persisted to object storage as a JSON blob and nothing ever removes it. The
 * docs only suggest configuring a bucket lifecycle policy by hand; on a busy
 * instance this is usually the single largest consumer of disk.
 *
 * Two known key layouts sit under LANGFUSE_S3_EVENT_UPLOAD_PREFIX:
 *   1. {projectId}/{entityType}/{eventBodyId}/{eventId}.json
 *   2. otel/{projectId}/yyyy/mm/dd/hh/mm/{eventId}.json
 *
 * Both start with (or contain) the project id, so per-project retention can be
 * applied exactly rather than with one instance-wide cutoff.
 */

/** The `blob_storage_file_log` name is v3.x+; older instances still call it `event_log`. */
const INDEX_TABLES = ["blob_storage_file_log", "event_log"] as const;

export function projectIdFromEventKey(key: string, prefix: string): string | undefined {
  const rest = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
  const segments = rest.split("/");
  if (segments.length < 2) return undefined;
  if (segments[0] === "otel") return segments[1] || undefined;
  return segments[0] || undefined;
}

/**
 * Effective blob cutoff for a project.
 *
 * `retentionDays: null` on the module means "follow the trace retention window".
 * The grace period is a hard floor: recently written blobs are still needed for
 * ingestion retries, so they are never eligible however aggressive the policy is.
 */
export function blobCutoffFor(ctx: RunContext, project: ProjectPlan): Date | null {
  const moduleDays = ctx.policy.modules.eventBlobs.retentionDays;
  const days = moduleDays ?? project.retentionDays;
  if (days === null || days <= 0) return null;

  const cutoff = daysAgo(days, ctx.startedAt);
  const graceFloor = daysAgo(ctx.policy.modules.eventBlobs.minGraceDays, ctx.startedAt);
  return cutoff > graceFloor ? graceFloor : cutoff;
}

interface SweepTally {
  scanned: number;
  matched: number;
  bytes: number;
  unknownProject: number;
}

async function sweepEventBucket(ctx: RunContext, result: ModuleResult): Promise<SweepTally> {
  const target = config.s3.events;
  const { maxObjectsPerRun } = ctx.policy.modules.eventBlobs;

  const cutoffs = new Map<string, Date | null>();
  for (const project of ctx.projects) cutoffs.set(project.id, blobCutoffFor(ctx, project));

  // Blobs for a project Langfuse no longer knows about (hard-deleted project) can
  // never be reclaimed by project rules, so they fall back to the most
  // conservative cutoff any project uses.
  const fallbackCutoff = [...cutoffs.values()].reduce<Date | null>((oldest, c) => {
    if (c === null) return oldest;
    return oldest === null || c < oldest ? c : oldest;
  }, null);

  const tally: SweepTally = { scanned: 0, matched: 0, bytes: 0, unknownProject: 0 };
  let pending: string[] = [];

  const flush = async () => {
    if (pending.length === 0) return;
    if (!ctx.policy.dryRun) {
      const { deleted, errors } = await deleteObjects(target, pending);
      if (errors.length > 0) {
        result.status = "partial";
        result.details.push(`${errors.length} object(s) failed to delete, first: ${errors[0]}`);
      }
      tally.matched += deleted;
    } else {
      tally.matched += pending.length;
    }
    pending = [];
  };

  for await (const obj of listObjects(target)) {
    tally.scanned += 1;

    const projectId = projectIdFromEventKey(obj.key, target.prefix);
    let cutoff = projectId ? cutoffs.get(projectId) : undefined;
    if (cutoff === undefined) {
      tally.unknownProject += 1;
      cutoff = fallbackCutoff;
    }
    if (cutoff === null || cutoff === undefined) continue;
    if (!obj.lastModified || obj.lastModified >= cutoff) continue;

    pending.push(obj.key);
    tally.bytes += obj.size;

    if (pending.length >= DELETE_BATCH_SIZE) await flush();
    if (tally.matched + pending.length >= maxObjectsPerRun) {
      await flush();
      result.status = "partial";
      result.details.push(`Stopped early: hit maxObjectsPerRun (${maxObjectsPerRun}).`);
      return tally;
    }
  }

  await flush();
  return tally;
}

/** Remove the ClickHouse rows that indexed the blobs we just deleted. */
async function pruneIndexTables(ctx: RunContext, result: ModuleResult): Promise<number> {
  const present = await existingTables([...INDEX_TABLES]);
  if (present.size === 0) {
    result.details.push("No blob index table found in ClickHouse; nothing to prune.");
    return 0;
  }

  let totalRows = 0;
  for (const table of INDEX_TABLES) {
    if (!present.has(table)) continue;
    // event_log predates the ReplacingMergeTree rewrite and has no is_deleted column.
    const hasIsDeleted = table === "blob_storage_file_log";

    for (const project of ctx.projects) {
      const cutoff = blobCutoffFor(ctx, project);
      if (cutoff === null) continue;

      const rows = await query<{ c: string }>(
        `SELECT count() AS c FROM ${escapeIdentifier(table)}
          WHERE project_id = {projectId:String}
            AND created_at < {cutoff:DateTime64(3)}
            ${hasIsDeleted ? "AND is_deleted = 0" : ""}`,
        { projectId: project.id, cutoff: toClickhouseDateTime(cutoff) },
      );
      const count = Number(rows[0]?.c ?? 0);
      if (count === 0) continue;
      totalRows += count;

      if (!ctx.policy.dryRun) {
        await command(
          `ALTER TABLE ${escapeIdentifier(table)}${onCluster()} ` +
            `DELETE WHERE project_id = {projectId:String} AND created_at < {cutoff:DateTime64(3)}`,
          { projectId: project.id, cutoff: toClickhouseDateTime(cutoff) },
        );
      }
    }
  }

  if (totalRows > 0) {
    result.details.push(
      `Blob index: ${totalRows} row(s) ${ctx.policy.dryRun ? "would be removed" : "queued for removal"} ` +
        `from ${[...present].join(", ")}.`,
    );
  }
  return totalRows;
}

export async function purgeEventBlobs(ctx: RunContext): Promise<ModuleResult> {
  const started = Date.now();
  const result: ModuleResult = { module: "eventBlobs", status: "ok", items: 0, bytes: 0, details: [], durationMs: 0 };

  try {
    if (!ctx.policy.modules.eventBlobs.enabled) {
      result.status = "skipped";
      result.details.push("Module disabled in policy.");
      return result;
    }

    const tally = await sweepEventBucket(ctx, result);
    result.items = tally.matched;
    result.bytes = tally.bytes;
    result.details.unshift(
      `Scanned ${tally.scanned} object(s) in ${config.s3.events.bucket}/${config.s3.events.prefix}; ` +
        `${tally.matched} expired (${formatBytes(tally.bytes)}) ` +
        `${ctx.policy.dryRun ? "would be deleted" : "deleted"}.`,
    );
    if (tally.unknownProject > 0) {
      result.details.push(
        `${tally.unknownProject} object(s) belong to no known project; the most conservative cutoff was applied.`,
      );
    }

    if (ctx.policy.modules.eventBlobs.pruneClickhouseIndex) {
      await pruneIndexTables(ctx, result);
    }
  } catch (e) {
    result.status = "error";
    result.error = errorMessage(e);
    log.error("eventBlobs module failed", result.error);
  } finally {
    result.durationMs = Date.now() - started;
  }
  return result;
}
