import { escapeIdentifier, query } from "../clients/clickhouse.js";
import { pgExec, pgQuery } from "../clients/postgres.js";
import { errorMessage, log } from "../logger.js";
import type { ModuleResult } from "../types.js";
import { daysAgo, type RunContext } from "./context.js";
import { toClickhouseDateTime } from "./traces.js";

/**
 * Postgres housekeeping.
 *
 * None of these tables are covered by Langfuse's own retention (audit logs are
 * explicitly excluded), yet they all grow without bound on a busy instance.
 * Windows are configured separately from trace retention because audit logs in
 * particular often need to outlive the traces they describe.
 */

interface SweepSpec {
  table: string;
  column: string;
  days: number | null;
  label: string;
}

async function sweepByAge(spec: SweepSpec, dryRun: boolean, now: Date): Promise<{ rows: number; line: string } | null> {
  if (spec.days === null || spec.days <= 0) return null;
  const cutoff = daysAgo(spec.days, now);
  const table = escapeIdentifier(spec.table);
  const column = escapeIdentifier(spec.column);

  if (dryRun) {
    const rows = await pgQuery<{ c: string }>(`SELECT count(*) AS c FROM ${table} WHERE ${column} < $1`, [cutoff]);
    const count = Number(rows[0]?.c ?? 0);
    return { rows: count, line: `${spec.label}: ${count} row(s) older than ${spec.days}d would be deleted.` };
  }

  // Chunked so a large backlog never holds one long transaction open against the
  // database Langfuse itself is serving from.
  let deleted = 0;
  for (;;) {
    const removed = await pgExec(
      `DELETE FROM ${table}
        WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${column} < $1 LIMIT 10000)`,
      [cutoff],
    );
    deleted += removed;
    if (removed < 10_000) break;
  }
  return { rows: deleted, line: `${spec.label}: deleted ${deleted} row(s) older than ${spec.days}d.` };
}

/**
 * `trace_sessions` rows have no foreign key to traces (those live in ClickHouse),
 * so a session outlives every trace in it. We only drop a session once ClickHouse
 * confirms it holds no traces at all.
 */
async function sweepOrphanSessions(ctx: RunContext, result: ModuleResult): Promise<number> {
  const BATCH = 2_000;
  let removed = 0;

  for (const project of ctx.active) {
    let offset = 0;
    for (;;) {
      const candidates = await pgQuery<{ id: string }>(
        `SELECT id FROM trace_sessions
          WHERE project_id = $1 AND created_at < $2
          ORDER BY created_at
          LIMIT $3 OFFSET $4`,
        [project.id, project.cutoff, BATCH, offset],
      );
      if (candidates.length === 0) break;

      const ids = candidates.map((c) => c.id);
      const stillUsed = await query<{ session_id: string }>(
        `SELECT DISTINCT session_id FROM traces
          WHERE project_id = {projectId:String}
            AND session_id IN ({ids:Array(String)})
            AND is_deleted = 0`,
        { projectId: project.id, ids },
      );
      const used = new Set(stillUsed.map((r) => r.session_id));
      const orphans = ids.filter((id) => !used.has(id));

      if (orphans.length > 0) {
        if (!ctx.policy.dryRun) {
          await pgExec(`DELETE FROM trace_sessions WHERE project_id = $1 AND id = ANY($2::text[])`, [
            project.id,
            orphans,
          ]);
        }
        removed += orphans.length;
      }

      // In dry-run nothing is deleted, so the window has to advance manually.
      if (ctx.policy.dryRun) offset += candidates.length;
      else offset += candidates.length - orphans.length;

      if (candidates.length < BATCH) break;
    }
  }

  if (removed > 0) {
    result.details.push(
      `trace_sessions: ${removed} orphaned session(s) ` +
        `${ctx.policy.dryRun ? "would be removed" : "removed"} (no traces left in ClickHouse).`,
    );
  }
  return removed;
}

export async function purgePostgres(ctx: RunContext): Promise<ModuleResult> {
  const started = Date.now();
  const result: ModuleResult = {
    module: "postgres",
    status: "ok",
    items: 0,
    // Row counts translate poorly to bytes here; the Storage tab reports the real
    // table sizes instead of guessing.
    bytes: -1,
    details: [],
    durationMs: 0,
  };

  try {
    const moduleConfig = ctx.policy.modules.postgres;
    if (!moduleConfig.enabled) {
      result.status = "skipped";
      result.details.push("Module disabled in policy.");
      return result;
    }

    const specs: SweepSpec[] = [
      { table: "audit_logs", column: "created_at", days: moduleConfig.auditLogsDays, label: "audit_logs" },
      { table: "job_executions", column: "created_at", days: moduleConfig.jobExecutionsDays, label: "job_executions" },
      {
        table: "automation_executions",
        column: "created_at",
        days: moduleConfig.automationExecutionsDays,
        label: "automation_executions",
      },
    ];

    for (const spec of specs) {
      try {
        const outcome = await sweepByAge(spec, ctx.policy.dryRun, ctx.startedAt);
        if (!outcome) continue;
        result.items += outcome.rows;
        result.details.push(outcome.line);
      } catch (e) {
        // automation_executions only exists on newer Langfuse versions.
        const message = errorMessage(e);
        if (/does not exist/i.test(message)) {
          result.details.push(`${spec.label}: table not present on this Langfuse version, skipped.`);
        } else {
          result.status = "partial";
          result.details.push(`${spec.label}: ${message}`);
        }
      }
    }

    if (moduleConfig.orphanSessions) {
      result.items += await sweepOrphanSessions(ctx, result);
    }

    if (result.details.length === 0) result.details.push("Nothing expired.");
  } catch (e) {
    result.status = "error";
    result.error = errorMessage(e);
    log.error("postgres module failed", result.error);
  } finally {
    result.durationMs = Date.now() - started;
  }
  return result;
}
