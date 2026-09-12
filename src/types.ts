export type ModuleName =
  | "traces"
  | "eventBlobs"
  | "media"
  | "batchExports"
  | "postgres";

export type TraceDeleteMode = "api" | "clickhouse";

export interface PostgresModuleConfig {
  enabled: boolean;
  /** Langfuse's own retention explicitly never touches audit logs, so these are opt-in windows. */
  auditLogsDays: number | null;
  jobExecutionsDays: number | null;
  automationExecutionsDays: number | null;
  /** Delete trace_sessions rows whose traces are all gone from ClickHouse. */
  orphanSessions: boolean;
}

export interface Policy {
  version: 1;
  /** Retention window applied to every project without an override. */
  defaultRetentionDays: number;
  /** projectId -> retention days. 0 or null means "keep forever". */
  projectOverrides: Record<string, number | null>;
  /** Projects excluded from every module. */
  excludedProjects: string[];
  /** When true, nothing is deleted anywhere; runs only report what they would do. */
  dryRun: boolean;
  schedule: {
    enabled: boolean;
    /** Standard 5-field cron expression. */
    cron: string;
    timezone: string;
  };
  modules: {
    traces: {
      enabled: boolean;
      mode: TraceDeleteMode;
      /** Trace IDs per DELETE /api/public/traces call. */
      batchSize: number;
      /** Safety valve: stop after this many traces in one run. */
      maxTracesPerRun: number;
      /**
       * ClickHouse mode only. Drop whole monthly partitions once every row in them
       * is expired (instant, no merge cost), then range-delete the straddling remainder.
       */
      dropWholePartitions: boolean;
    };
    eventBlobs: {
      enabled: boolean;
      /**
       * Retention for raw ingestion event blobs in MinIO. Null = follow the trace
       * retention window. Langfuse never cleans these up on its own.
       */
      retentionDays: number | null;
      /** Never delete blobs newer than this, regardless of the window (ingestion retries). */
      minGraceDays: number;
      maxObjectsPerRun: number;
      /** Also prune the matching blob_storage_file_log / event_log rows in ClickHouse. */
      pruneClickhouseIndex: boolean;
    };
    media: {
      enabled: boolean;
      retentionDays: number | null;
    };
    batchExports: {
      enabled: boolean;
      retentionDays: number;
    };
    postgres: PostgresModuleConfig;
  };
}

export type ModuleStatus = "ok" | "skipped" | "error" | "partial";

export interface ModuleResult {
  module: ModuleName;
  status: ModuleStatus;
  /** Rows / objects / traces affected (or that would be, in dry-run). */
  items: number;
  /** Bytes freed (or that would be). -1 when the module cannot estimate it. */
  bytes: number;
  details: string[];
  error?: string;
  durationMs: number;
}

export interface RunReport {
  id: string;
  trigger: "manual" | "schedule" | "startup";
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  status: "running" | "ok" | "error" | "partial";
  modules: ModuleResult[];
  totals: { items: number; bytes: number };
  /** Cutoff actually applied, per project. */
  cutoffs: Record<string, { retentionDays: number | null; cutoff: string | null; name?: string }>;
  error?: string;
}
