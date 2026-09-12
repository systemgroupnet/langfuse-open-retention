import { DELETE_BATCH_SIZE, deleteObjects, listObjects } from "../clients/s3.js";
import { pgExec } from "../clients/postgres.js";
import { config } from "../config.js";
import { errorMessage, log } from "../logger.js";
import type { ModuleResult } from "../types.js";
import { daysAgo, formatBytes, type RunContext } from "./context.js";

/**
 * Batch export artifacts.
 *
 * These are one-off CSV/JSON dumps a user asked for. They are already stale the
 * day after they are downloaded, so they get their own short window independent
 * of trace retention. Swept by LastModified: the `batch_exports` row carries a
 * URL rather than a bucket key, so the object itself is the source of truth.
 */
export async function purgeBatchExports(ctx: RunContext): Promise<ModuleResult> {
  const started = Date.now();
  const result: ModuleResult = {
    module: "batchExports",
    status: "ok",
    items: 0,
    bytes: 0,
    details: [],
    durationMs: 0,
  };

  try {
    const moduleConfig = ctx.policy.modules.batchExports;
    if (!moduleConfig.enabled) {
      result.status = "skipped";
      result.details.push("Module disabled in policy.");
      return result;
    }
    if (moduleConfig.retentionDays <= 0) {
      result.status = "skipped";
      result.details.push("Retention disabled for batch exports.");
      return result;
    }

    const cutoff = daysAgo(moduleConfig.retentionDays, ctx.startedAt);
    const target = config.s3.exports;

    let scanned = 0;
    let pending: string[] = [];

    const flush = async () => {
      if (pending.length === 0) return;
      if (!ctx.policy.dryRun) {
        const { deleted, errors } = await deleteObjects(target, pending);
        result.items += deleted;
        if (errors.length > 0) {
          result.status = "partial";
          result.details.push(`${errors.length} export(s) failed to delete, first: ${errors[0]}`);
        }
      } else {
        result.items += pending.length;
      }
      pending = [];
    };

    for await (const obj of listObjects(target)) {
      scanned += 1;
      if (!obj.lastModified || obj.lastModified >= cutoff) continue;
      pending.push(obj.key);
      result.bytes += obj.size;
      if (pending.length >= DELETE_BATCH_SIZE) await flush();
    }
    await flush();

    result.details.push(
      `Scanned ${scanned} export artifact(s) in ${target.bucket}/${target.prefix}; ` +
        `${result.items} older than ${moduleConfig.retentionDays}d (${formatBytes(result.bytes)}) ` +
        `${ctx.policy.dryRun ? "would be deleted" : "deleted"}.`,
    );

    // The bookkeeping rows are tiny, but leaving them behind means the UI keeps
    // offering download links to objects that no longer exist.
    if (!ctx.policy.dryRun) {
      const rows = await pgExec(
        `DELETE FROM batch_exports WHERE created_at < $1 AND status IN ('COMPLETED', 'FAILED', 'EXPIRED')`,
        [cutoff],
      );
      if (rows > 0) result.details.push(`Removed ${rows} finished batch_exports row(s).`);
    }
  } catch (e) {
    result.status = "error";
    result.error = errorMessage(e);
    log.error("batchExports module failed", result.error);
  } finally {
    result.durationMs = Date.now() - started;
  }
  return result;
}
