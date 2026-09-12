import { randomUUID } from "node:crypto";

import { errorMessage, log } from "../logger.js";
import { getPolicy, saveRun } from "../state.js";
import type { ModuleResult, Policy, RunReport } from "../types.js";
import { buildContext, type RunContext } from "./context.js";
import { purgeBatchExports } from "./batchExports.js";
import { purgeEventBlobs } from "./eventBlobs.js";
import { purgeMedia } from "./media.js";
import { purgePostgres } from "./postgresCleanup.js";
import { purgeTraces } from "./traces.js";

/**
 * Module order matters.
 *
 * Traces go first so Langfuse's worker gets a chance to clean up its own blobs
 * and index rows; the blob and media modules then sweep whatever it left behind
 * or never knew about. Postgres housekeeping runs last because orphan-session
 * detection wants the ClickHouse deletes already in flight.
 */
const MODULES: Array<(ctx: RunContext) => Promise<ModuleResult>> = [
  purgeTraces,
  purgeEventBlobs,
  purgeMedia,
  purgeBatchExports,
  purgePostgres,
];

let activeRun: RunReport | null = null;

export function currentRun(): RunReport | null {
  return activeRun ? structuredClone(activeRun) : null;
}

export function isRunning(): boolean {
  return activeRun !== null;
}

function rollUpStatus(modules: ModuleResult[]): RunReport["status"] {
  if (modules.some((m) => m.status === "error")) return "error";
  if (modules.some((m) => m.status === "partial")) return "partial";
  return "ok";
}

export interface RunOptions {
  trigger: RunReport["trigger"];
  /** Force a dry run regardless of the saved policy — what the Preview button uses. */
  forceDryRun?: boolean;
  policyOverride?: Policy;
}

export async function runRetention(options: RunOptions): Promise<RunReport> {
  if (activeRun) throw new Error("A retention run is already in progress.");

  const policy = options.policyOverride ?? getPolicy();
  const effective: Policy = options.forceDryRun ? { ...policy, dryRun: true } : policy;
  const startedAt = new Date();

  const report: RunReport = {
    id: randomUUID(),
    trigger: options.trigger,
    dryRun: effective.dryRun,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: 0,
    status: "running",
    modules: [],
    totals: { items: 0, bytes: 0 },
    cutoffs: {},
  };
  activeRun = report;

  log.info("retention run started", { id: report.id, trigger: report.trigger, dryRun: report.dryRun });

  try {
    const ctx = await buildContext(effective, startedAt);
    for (const project of ctx.projects) {
      report.cutoffs[project.id] = {
        name: project.name,
        retentionDays: project.retentionDays,
        cutoff: project.cutoff?.toISOString() ?? null,
      };
    }

    for (const moduleFn of MODULES) {
      const result = await moduleFn(ctx);
      report.modules.push(result);
      report.totals.items += Math.max(0, result.items);
      if (result.bytes > 0) report.totals.bytes += result.bytes;
    }

    report.status = rollUpStatus(report.modules);
  } catch (e) {
    report.status = "error";
    report.error = errorMessage(e);
    log.error("retention run failed", report.error);
  } finally {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt.getTime();
    activeRun = null;
    await saveRun(report);
    log.info("retention run finished", {
      id: report.id,
      status: report.status,
      items: report.totals.items,
      bytes: report.totals.bytes,
      durationMs: report.durationMs,
    });
  }

  return report;
}
