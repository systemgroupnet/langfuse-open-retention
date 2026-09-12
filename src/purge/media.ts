import { deleteObjects } from "../clients/s3.js";
import { pgExec, pgQuery } from "../clients/postgres.js";
import { config } from "../config.js";
import { errorMessage, log } from "../logger.js";
import type { ModuleResult } from "../types.js";
import { daysAgo, formatBytes, type RunContext } from "./context.js";

/**
 * Media assets (multimodal inputs attached to traces and observations).
 *
 * Driven from the Postgres `media` table rather than by sweeping the bucket,
 * because that table is authoritative: it carries the exact bucket/key and the
 * real `content_length`, so the reported reclaim is a measurement rather than an
 * estimate.
 *
 * Media referenced by a dataset item is never deleted. Datasets are explicitly
 * out of scope for retention in Langfuse's own semantics, and a dataset item
 * saved from a trace is expected to outlive that trace.
 */

interface MediaRow {
  id: string;
  project_id: string;
  bucket_name: string;
  bucket_path: string;
  content_length: string;
}

const PAGE_SIZE = 5_000;

export async function purgeMedia(ctx: RunContext): Promise<ModuleResult> {
  const started = Date.now();
  const result: ModuleResult = { module: "media", status: "ok", items: 0, bytes: 0, details: [], durationMs: 0 };

  try {
    if (!ctx.policy.modules.media.enabled) {
      result.status = "skipped";
      result.details.push("Module disabled in policy.");
      return result;
    }

    const moduleDays = ctx.policy.modules.media.retentionDays;
    let totalBytes = 0;
    let totalRows = 0;
    let protectedByDataset = 0;

    const countDatasetHeld = async (projectId: string, cutoff: Date) => {
      const [held] = await pgQuery<{ c: string }>(
        `SELECT count(*) AS c
           FROM media m
          WHERE m.project_id = $1 AND m.created_at < $2
            AND EXISTS (
                  SELECT 1 FROM dataset_item_media dim
                   WHERE dim.project_id = m.project_id AND dim.media_id = m.id
                )`,
        [projectId, cutoff],
      );
      protectedByDataset += Number(held?.c ?? 0);
    };

    for (const project of ctx.projects) {
      const days = moduleDays ?? project.retentionDays;
      if (days === null || days <= 0) continue;
      const cutoff = daysAgo(days, ctx.startedAt);

      // A dry run must report the whole backlog, not one page of it, so the
      // estimate comes from an aggregate rather than from walking pages.
      if (ctx.policy.dryRun) {
        const [summary] = await pgQuery<{ c: string; bytes: string | null }>(
          `SELECT count(*) AS c, sum(m.content_length) AS bytes
             FROM media m
            WHERE m.project_id = $1
              AND m.created_at < $2
              AND NOT EXISTS (
                    SELECT 1 FROM dataset_item_media dim
                     WHERE dim.project_id = m.project_id AND dim.media_id = m.id
                  )`,
          [project.id, cutoff],
        );
        totalRows += Number(summary?.c ?? 0);
        totalBytes += Number(summary?.bytes ?? 0);
        await countDatasetHeld(project.id, cutoff);
        continue;
      }

      for (;;) {
        const rows = await pgQuery<MediaRow>(
          `SELECT m.id, m.project_id, m.bucket_name, m.bucket_path, m.content_length
             FROM media m
            WHERE m.project_id = $1
              AND m.created_at < $2
              AND NOT EXISTS (
                    SELECT 1 FROM dataset_item_media dim
                     WHERE dim.project_id = m.project_id AND dim.media_id = m.id
                  )
            ORDER BY m.created_at
            LIMIT $3`,
          [project.id, cutoff, PAGE_SIZE],
        );
        if (rows.length === 0) break;

        const bytes = rows.reduce((sum, r) => sum + Number(r.content_length ?? 0), 0);
        totalBytes += bytes;
        totalRows += rows.length;

        if (!ctx.policy.dryRun) {
          // Objects first: a crash between the two steps leaves a dangling DB row
          // (harmless, retried next run) rather than an unreachable orphan object.
          const byBucket = new Map<string, string[]>();
          for (const row of rows) {
            const keys = byBucket.get(row.bucket_name) ?? [];
            keys.push(row.bucket_path);
            byBucket.set(row.bucket_name, keys);
          }
          for (const [bucket, keys] of byBucket) {
            const { errors } = await deleteObjects({ ...config.s3.media, bucket }, keys);
            if (errors.length > 0) {
              result.status = "partial";
              result.details.push(`${errors.length} media object(s) failed to delete, first: ${errors[0]}`);
            }
          }

          const ids = rows.map((r) => r.id);
          await pgExec(`DELETE FROM trace_media WHERE project_id = $1 AND media_id = ANY($2::text[])`, [
            project.id,
            ids,
          ]);
          await pgExec(`DELETE FROM observation_media WHERE project_id = $1 AND media_id = ANY($2::text[])`, [
            project.id,
            ids,
          ]);
          await pgExec(`DELETE FROM media WHERE project_id = $1 AND id = ANY($2::text[])`, [project.id, ids]);
        }

        if (rows.length < PAGE_SIZE) break;
      }

      await countDatasetHeld(project.id, cutoff);
    }

    result.items = totalRows;
    result.bytes = totalBytes;
    result.details.push(
      `${totalRows} media asset(s), ${formatBytes(totalBytes)}, ` +
        `${ctx.policy.dryRun ? "would be deleted" : "deleted"} from object storage and Postgres.`,
    );
    if (protectedByDataset > 0) {
      result.details.push(`${protectedByDataset} expired asset(s) kept: still referenced by a dataset item.`);
    }
  } catch (e) {
    result.status = "error";
    result.error = errorMessage(e);
    log.error("media module failed", result.error);
  } finally {
    result.durationMs = Date.now() - started;
  }
  return result;
}
