import { command, escapeIdentifier, existingTables, onCluster, query } from "../clients/clickhouse.js";
import { countExpiredTraces, deleteTraces, iterateExpiredTraces, keysForProject } from "../clients/langfuse.js";
import { config } from "../config.js";
import { errorMessage, log } from "../logger.js";
import type { ModuleResult } from "../types.js";
import type { RunContext } from "./context.js";
import { globalSafeCutoff } from "./context.js";
import { estimateBytes, tableFootprints, type TableFootprint } from "./estimate.js";

/** The three entity tables retention applies to, with the column each is aged by. */
const ENTITY_TABLES = [
  { table: "traces", tsColumn: "timestamp" },
  { table: "observations", tsColumn: "start_time" },
  { table: "scores", tsColumn: "timestamp" },
] as const;

export interface ExpiredCounts {
  perTable: Record<string, number>;
  /** Expired rows in `traces` only, keyed by project — what the policy table shows per row. */
  perProject: Record<string, number>;
  total: number;
}

/** ClickHouse DateTime64 literals want `YYYY-MM-DD HH:MM:SS.mmm`, not ISO-8601. */
export function toClickhouseDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

async function countExpired(ctx: RunContext, tables: Set<string>): Promise<ExpiredCounts> {
  const perTable: Record<string, number> = {};
  const perProject: Record<string, number> = {};
  let total = 0;

  for (const { table, tsColumn } of ENTITY_TABLES) {
    if (!tables.has(table)) continue;
    let tableTotal = 0;
    for (const project of ctx.active) {
      const rows = await query<{ c: string }>(
        `SELECT count() AS c FROM ${escapeIdentifier(table)}
          WHERE project_id = {projectId:String}
            AND ${escapeIdentifier(tsColumn)} < {cutoff:DateTime64(3)}
            AND is_deleted = 0`,
        { projectId: project.id, cutoff: toClickhouseDateTime(project.cutoff as Date) },
      );
      const count = Number(rows[0]?.c ?? 0);
      tableTotal += count;
      if (table === "traces") perProject[project.id] = count;
    }
    perTable[table] = tableTotal;
    total += tableTotal;
  }
  return { perTable, perProject, total };
}

/**
 * Delete expired traces through Langfuse's own public API.
 *
 * This is the safe path: DELETE /api/public/traces enqueues the work for
 * langfuse-worker, which removes the trace plus its observations, scores and
 * media from ClickHouse *and* the matching blobs in object storage, via the same
 * code path the Enterprise retention job uses. We never touch the schema.
 */
async function purgeViaApi(ctx: RunContext, result: ModuleResult, footprints: TableFootprint[]): Promise<void> {
  const { batchSize, maxTracesPerRun } = ctx.policy.modules.traces;
  const traceFootprint = footprints.find((f) => f.table === "traces");
  let budget = maxTracesPerRun;

  for (const project of ctx.active) {
    if (budget <= 0) {
      result.details.push(`Stopped early: hit maxTracesPerRun (${maxTracesPerRun}).`);
      result.status = "partial";
      break;
    }

    const keys = await keysForProject(project.id, project.orgId, ctx.singleOrg);
    if (!keys) {
      result.details.push(
        `${project.name}${project.orgName ? ` (org: ${project.orgName})` : ""}: no API key available. ` +
          `Add an organization key for this org via LANGFUSE_ORG_KEYS, or a project key ` +
          `via LANGFUSE_PROJECT_KEYS. Skipped — its data was NOT deleted.`,
      );
      if (result.status === "ok") result.status = "partial";
      continue;
    }

    // A dry run only needs the number, and the list endpoint reports it in one
    // request instead of several hundred pages.
    if (ctx.policy.dryRun) {
      try {
        const expired = Math.min(await countExpiredTraces(keys, project.cutoff as Date), budget);
        result.items += expired;
        result.bytes += estimateBytes(traceFootprint, expired);
        budget -= expired;
        result.details.push(
          `${project.name}: ${expired} traces older than ${project.retentionDays}d would be enqueued for deletion.`,
        );
      } catch (e) {
        result.status = "partial";
        result.details.push(`${project.name}: could not count expired traces — ${errorMessage(e)}`);
      }
      continue;
    }

    let deleted = 0;
    let batch: string[] = [];
    try {
      for await (const trace of iterateExpiredTraces(keys, project.cutoff as Date, batchSize)) {
        batch.push(trace.id);
        if (batch.length >= batchSize) {
          await deleteTraces(keys, batch);
          deleted += batch.length;
          budget -= batch.length;
          batch = [];
          if (budget <= 0) break;
        }
      }
      if (batch.length > 0 && budget > 0) {
        await deleteTraces(keys, batch);
        deleted += batch.length;
        budget -= batch.length;
      }
    } catch (e) {
      result.status = "partial";
      result.details.push(`${project.name}: aborted after ${deleted} traces. ${errorMessage(e)}`);
      log.error("trace purge failed for project", { projectId: project.id, error: errorMessage(e) });
      continue;
    }

    result.items += deleted;
    result.bytes += estimateBytes(traceFootprint, deleted);
    result.details.push(
      `${project.name}: ${deleted} traces older than ${project.retentionDays}d enqueued for deletion.`,
    );
  }

  if (!ctx.policy.dryRun && result.items > 0) {
    result.details.push(
      "Deletion is asynchronous. langfuse-worker drains the queue in the background; " +
        "watch the pending_deletions backlog on the Storage tab.",
    );
  }
}

interface DroppedPartition {
  partition: string;
  rows: number;
  bytes: number;
}

/** Monthly partitions (toYYYYMM) whose final instant is already past the cutoff. */
async function dropExpiredPartitions(table: string, cutoff: Date, dryRun: boolean): Promise<DroppedPartition[]> {
  const partitions = await query<{ partition: string; rows: string; bytes: string }>(
    `SELECT partition, sum(rows) AS rows, sum(bytes_on_disk) AS bytes
       FROM system.parts
      WHERE active AND database = {db:String} AND table = {table:String}
      GROUP BY partition
      ORDER BY partition`,
    { db: config.clickhouse.database, table },
  );

  const cutoffMonth = cutoff.getUTCFullYear() * 100 + (cutoff.getUTCMonth() + 1);
  const dropped: DroppedPartition[] = [];

  for (const p of partitions) {
    const value = Number.parseInt(p.partition, 10);
    // Anything in the cutoff's own month straddles it and must be range-deleted instead.
    if (!Number.isFinite(value) || value >= cutoffMonth) continue;
    if (!dryRun) {
      await command(`ALTER TABLE ${escapeIdentifier(table)}${onCluster()} DROP PARTITION {partition:String}`, {
        partition: p.partition,
      });
    }
    dropped.push({ partition: p.partition, rows: Number(p.rows), bytes: Number(p.bytes) });
  }
  return dropped;
}

/**
 * Delete expired rows directly in ClickHouse.
 *
 * Faster and needs no API keys, but it bypasses Langfuse's own cleanup, so object
 * storage is left entirely to the blob modules. Two phases:
 *   1. DROP PARTITION for months in which every row is expired. Instant, no merge.
 *   2. ALTER ... DELETE for the partial month straddling the cutoff. A mutation.
 */
async function purgeViaClickhouse(
  ctx: RunContext,
  result: ModuleResult,
  tables: Set<string>,
  footprints: TableFootprint[],
): Promise<void> {
  // Counted up front, before anything is dropped, so this is the authoritative
  // item total for the module. Partition drops and the range delete below are two
  // mechanisms working through this same set of rows, not two separate sets.
  const counts = await countExpired(ctx, tables);
  result.items = counts.total;

  const safeCutoff = globalSafeCutoff(ctx);
  const droppedRowsByTable: Record<string, number> = {};

  if (ctx.policy.modules.traces.dropWholePartitions && safeCutoff) {
    for (const { table } of ENTITY_TABLES) {
      if (!tables.has(table)) continue;
      for (const p of await dropExpiredPartitions(table, safeCutoff, ctx.policy.dryRun)) {
        // Partition bytes come from system.parts, so they are measured, not estimated.
        result.bytes += p.bytes;
        droppedRowsByTable[table] = (droppedRowsByTable[table] ?? 0) + p.rows;
        result.details.push(
          `${table}: partition ${p.partition} (${p.rows} rows) ` +
            `${ctx.policy.dryRun ? "would be dropped" : "dropped"}.`,
        );
      }
    }
  } else if (ctx.policy.modules.traces.dropWholePartitions) {
    result.details.push(
      "Partition drops skipped: at least one project has retention turned off, " +
        "so no month is expired instance-wide.",
    );
  }

  for (const { table, tsColumn } of ENTITY_TABLES) {
    if (!tables.has(table)) continue;
    const footprint = footprints.find((f) => f.table === table);
    const rows = counts.perTable[table] ?? 0;

    if (!ctx.policy.dryRun) {
      for (const project of ctx.active) {
        await command(
          `ALTER TABLE ${escapeIdentifier(table)}${onCluster()} ` +
            `DELETE WHERE project_id = {projectId:String} AND ${escapeIdentifier(tsColumn)} < {cutoff:DateTime64(3)}`,
          { projectId: project.id, cutoff: toClickhouseDateTime(project.cutoff as Date) },
        );
      }
    }

    if (rows > 0) {
      result.details.push(
        `${table}: ${rows} expired rows ${ctx.policy.dryRun ? "match" : "queued as a mutation"} ` +
          `across ${ctx.active.length} project(s).`,
      );
      // Only the rows the partition drops did not already account for get an
      // estimate; their bytes were measured exactly above.
      const remainder = Math.max(0, rows - (droppedRowsByTable[table] ?? 0));
      result.bytes += estimateBytes(footprint, remainder);
    }
  }

  if (!ctx.policy.dryRun) {
    result.details.push(
      "ClickHouse mutations run asynchronously; disk is reclaimed as parts merge. " +
        "Progress: SELECT * FROM system.mutations WHERE is_done = 0.",
    );
  }
}

export async function purgeTraces(ctx: RunContext): Promise<ModuleResult> {
  const started = Date.now();
  const result: ModuleResult = { module: "traces", status: "ok", items: 0, bytes: 0, details: [], durationMs: 0 };

  try {
    if (!ctx.policy.modules.traces.enabled) {
      result.status = "skipped";
      result.details.push("Module disabled in policy.");
      return result;
    }
    if (ctx.active.length === 0) {
      result.status = "skipped";
      result.details.push("No project has an active retention window.");
      return result;
    }

    const tables = await existingTables(ENTITY_TABLES.map((t) => t.table));
    const footprints = await tableFootprints();

    if (ctx.policy.modules.traces.mode === "api") {
      await purgeViaApi(ctx, result, footprints);
    } else {
      await purgeViaClickhouse(ctx, result, tables, footprints);
    }
  } catch (e) {
    result.status = "error";
    result.error = errorMessage(e);
    log.error("traces module failed", result.error);
  } finally {
    result.durationMs = Date.now() - started;
  }
  return result;
}

/** Powers the dashboard preview card without running a purge. */
export async function expiredTraceCounts(ctx: RunContext): Promise<ExpiredCounts> {
  const tables = await existingTables(ENTITY_TABLES.map((t) => t.table));
  return countExpired(ctx, tables);
}
