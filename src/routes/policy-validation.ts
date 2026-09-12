import cron from "node-cron";

import { DEFAULT_POLICY } from "../state.js";
import type { Policy, TraceDeleteMode } from "../types.js";

export class ValidationError extends Error {}

function num(value: unknown, field: string, { min, max }: { min: number; max: number }): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new ValidationError(`${field} must be a whole number.`);
  if (n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}.`);
  return n;
}

function nullableDays(value: unknown, field: string, min: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = num(value, field, { min: 0, max: 36_500 });
  if (n === 0) return null; // 0 reads as "keep forever"
  if (n < min) throw new ValidationError(`${field} must be at least ${min} days.`);
  return n;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Floor on any trace-facing retention window.
 *
 * Langfuse's own retention feature refuses anything under 3 days, and for good
 * reason: the ingestion pipeline is asynchronous, so a shorter window can delete
 * data that is still being written.
 */
export const MIN_RETENTION_DAYS = 3;

export function validatePolicy(input: unknown): Policy {
  if (typeof input !== "object" || input === null) throw new ValidationError("Policy must be an object.");
  const raw = input as Record<string, any>;
  const base = DEFAULT_POLICY;

  const defaultRetentionDays = num(raw.defaultRetentionDays, "defaultRetentionDays", {
    min: MIN_RETENTION_DAYS,
    max: 36_500,
  });

  const projectOverrides: Record<string, number | null> = {};
  for (const [projectId, value] of Object.entries(raw.projectOverrides ?? {})) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
      throw new ValidationError(`Invalid project id in overrides: ${projectId}`);
    }
    projectOverrides[projectId] = nullableDays(value, `override for ${projectId}`, MIN_RETENTION_DAYS);
  }

  const excludedProjects: string[] = Array.isArray(raw.excludedProjects)
    ? raw.excludedProjects.filter((p: unknown): p is string => typeof p === "string")
    : [];

  const scheduleCron = typeof raw.schedule?.cron === "string" ? raw.schedule.cron : base.schedule.cron;
  if (!cron.validate(scheduleCron)) throw new ValidationError(`Not a valid cron expression: ${scheduleCron}`);

  // An unrecognised value falls back to the shipped default rather than to a
  // hardcoded one, so the two cannot drift apart.
  const requested = raw.modules?.traces?.mode;
  const mode: TraceDeleteMode =
    requested === "clickhouse" || requested === "api" ? requested : base.modules.traces.mode;

  return {
    version: 1,
    defaultRetentionDays,
    projectOverrides,
    excludedProjects,
    dryRun: flag(raw.dryRun, base.dryRun),
    schedule: {
      enabled: flag(raw.schedule?.enabled, base.schedule.enabled),
      cron: scheduleCron,
      timezone: typeof raw.schedule?.timezone === "string" ? raw.schedule.timezone : base.schedule.timezone,
    },
    modules: {
      traces: {
        enabled: flag(raw.modules?.traces?.enabled, base.modules.traces.enabled),
        mode,
        batchSize: num(raw.modules?.traces?.batchSize ?? base.modules.traces.batchSize, "traces.batchSize", {
          min: 1,
          max: 1_000,
        }),
        maxTracesPerRun: num(
          raw.modules?.traces?.maxTracesPerRun ?? base.modules.traces.maxTracesPerRun,
          "traces.maxTracesPerRun",
          { min: 1, max: 10_000_000 },
        ),
        dropWholePartitions: flag(raw.modules?.traces?.dropWholePartitions, base.modules.traces.dropWholePartitions),
      },
      eventBlobs: {
        enabled: flag(raw.modules?.eventBlobs?.enabled, base.modules.eventBlobs.enabled),
        retentionDays: nullableDays(raw.modules?.eventBlobs?.retentionDays, "eventBlobs.retentionDays", 1),
        minGraceDays: num(
          raw.modules?.eventBlobs?.minGraceDays ?? base.modules.eventBlobs.minGraceDays,
          "eventBlobs.minGraceDays",
          { min: 0, max: 365 },
        ),
        maxObjectsPerRun: num(
          raw.modules?.eventBlobs?.maxObjectsPerRun ?? base.modules.eventBlobs.maxObjectsPerRun,
          "eventBlobs.maxObjectsPerRun",
          { min: 1, max: 50_000_000 },
        ),
        pruneClickhouseIndex: flag(
          raw.modules?.eventBlobs?.pruneClickhouseIndex,
          base.modules.eventBlobs.pruneClickhouseIndex,
        ),
      },
      media: {
        enabled: flag(raw.modules?.media?.enabled, base.modules.media.enabled),
        retentionDays: nullableDays(raw.modules?.media?.retentionDays, "media.retentionDays", 1),
      },
      batchExports: {
        enabled: flag(raw.modules?.batchExports?.enabled, base.modules.batchExports.enabled),
        retentionDays: num(
          raw.modules?.batchExports?.retentionDays ?? base.modules.batchExports.retentionDays,
          "batchExports.retentionDays",
          { min: 1, max: 3_650 },
        ),
      },
      postgres: {
        enabled: flag(raw.modules?.postgres?.enabled, base.modules.postgres.enabled),
        auditLogsDays: nullableDays(raw.modules?.postgres?.auditLogsDays, "postgres.auditLogsDays", 1),
        jobExecutionsDays: nullableDays(raw.modules?.postgres?.jobExecutionsDays, "postgres.jobExecutionsDays", 1),
        automationExecutionsDays: nullableDays(
          raw.modules?.postgres?.automationExecutionsDays,
          "postgres.automationExecutionsDays",
          1,
        ),
        orphanSessions: flag(raw.modules?.postgres?.orphanSessions, base.modules.postgres.orphanSessions),
      },
    },
  };
}
