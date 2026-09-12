import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { config } from "./config.js";
import { errorMessage, log } from "./logger.js";
import type { Policy, RunReport } from "./types.js";

export const DEFAULT_POLICY: Policy = {
  version: 1,
  defaultRetentionDays: 15,
  projectOverrides: {},
  excludedProjects: [],
  dryRun: true,
  schedule: { enabled: true, cron: "0 3 * * *", timezone: "UTC" },
  modules: {
    traces: {
      enabled: true,
      // ClickHouse by default, not the API.
      //
      // This tool exists for installs without an Enterprise licence, and on those
      // the API path needs a project-scoped key pasted in per project: organization
      // keys, which would let it mint those itself, are gated behind the `admin-api`
      // entitlement. Defaulting to API mode would mean a fresh install purges
      // nothing and reports `partial` until someone configures N keys.
      //
      // Direct ClickHouse mode needs no keys, covers every project in every
      // organization, and object storage is unaffected — the blob, media and
      // export modules never use the API either way. The cost is coupling to the
      // ClickHouse schema, which is why table existence is introspected at runtime.
      mode: "clickhouse",
      batchSize: 100,
      maxTracesPerRun: 200_000,
      dropWholePartitions: true,
    },
    eventBlobs: {
      enabled: true,
      retentionDays: null,
      minGraceDays: 2,
      maxObjectsPerRun: 500_000,
      pruneClickhouseIndex: true,
    },
    media: { enabled: true, retentionDays: null },
    batchExports: { enabled: true, retentionDays: 7 },
    postgres: {
      enabled: true,
      auditLogsDays: 180,
      jobExecutionsDays: 30,
      automationExecutionsDays: 30,
      orphanSessions: true,
    },
  },
};

interface PersistedState {
  policy: Policy;
  /** Newest first. Capped. */
  runs: RunReport[];
  /** When the operator accepted the risk notice. Null until they do. */
  riskAcknowledgedAt: string | null;
  /** Project-scoped API keys this tool minted for itself, keyed by project id. */
  provisionedKeys: Record<string, { publicKey: string; secretKey: string; createdAt: string }>;
  cookieSecret: string;
}

const MAX_RUN_HISTORY = 50;

let state: PersistedState;
let writeQueue: Promise<void> = Promise.resolve();

function statePath(): string {
  return join(config.dataDir, "state.json");
}

/** Merge persisted policy over defaults so new options appear after an upgrade. */
function mergePolicy(stored: Partial<Policy> | undefined): Policy {
  if (!stored) return structuredClone(DEFAULT_POLICY);
  const base = structuredClone(DEFAULT_POLICY);
  return {
    ...base,
    ...stored,
    schedule: { ...base.schedule, ...(stored.schedule ?? {}) },
    projectOverrides: stored.projectOverrides ?? base.projectOverrides,
    excludedProjects: stored.excludedProjects ?? base.excludedProjects,
    modules: {
      traces: { ...base.modules.traces, ...(stored.modules?.traces ?? {}) },
      eventBlobs: { ...base.modules.eventBlobs, ...(stored.modules?.eventBlobs ?? {}) },
      media: { ...base.modules.media, ...(stored.modules?.media ?? {}) },
      batchExports: { ...base.modules.batchExports, ...(stored.modules?.batchExports ?? {}) },
      postgres: { ...base.modules.postgres, ...(stored.modules?.postgres ?? {}) },
    },
    version: 1,
  };
}

export async function loadState(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  let stored: Partial<PersistedState> | undefined;
  try {
    stored = JSON.parse(await readFile(statePath(), "utf8")) as PersistedState;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") log.warn("state file unreadable, starting from defaults", errorMessage(e));
  }

  state = {
    policy: mergePolicy(stored?.policy),
    runs: stored?.runs ?? [],
    riskAcknowledgedAt: stored?.riskAcknowledgedAt ?? null,
    provisionedKeys: stored?.provisionedKeys ?? {},
    cookieSecret: config.auth.cookieSecret ?? stored?.cookieSecret ?? randomBytes(32).toString("hex"),
  };

  if (!stored) {
    await persist();
    log.info("initialised new state file", { path: statePath(), retentionDays: state.policy.defaultRetentionDays });
  }
}

/** Serialised, atomic write: temp file then rename, so a crash can't truncate state. */
async function persist(): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const tmp = `${statePath()}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, statePath());
  });
  return writeQueue;
}

export function getPolicy(): Policy {
  return structuredClone(state.policy);
}

export async function setPolicy(policy: Policy): Promise<Policy> {
  state.policy = policy;
  await persist();
  return structuredClone(policy);
}

export function getRuns(limit = MAX_RUN_HISTORY): RunReport[] {
  return structuredClone(state.runs.slice(0, limit));
}

export function getRun(id: string): RunReport | undefined {
  const run = state.runs.find((r) => r.id === id);
  return run ? structuredClone(run) : undefined;
}

export async function saveRun(report: RunReport): Promise<void> {
  const existing = state.runs.findIndex((r) => r.id === report.id);
  if (existing >= 0) state.runs[existing] = report;
  else state.runs.unshift(report);
  state.runs = state.runs.slice(0, MAX_RUN_HISTORY);
  await persist();
}

export function getProvisionedKey(projectId: string): { publicKey: string; secretKey: string } | undefined {
  const entry = state.provisionedKeys[projectId];
  return entry ? { publicKey: entry.publicKey, secretKey: entry.secretKey } : undefined;
}

export async function saveProvisionedKey(
  projectId: string,
  keys: { publicKey: string; secretKey: string },
): Promise<void> {
  state.provisionedKeys[projectId] = { ...keys, createdAt: new Date().toISOString() };
  await persist();
}

export function getCookieSecret(): string {
  return state.cookieSecret;
}

/**
 * Whether the operator has accepted the risk notice.
 *
 * Recorded per installation rather than per browser: it is a statement about
 * this deployment, not a dismissed banner. RETENTION_RISK_ACKNOWLEDGED=true
 * pre-accepts it for deployments that are never driven through the UI.
 */
export function riskAcknowledged(): boolean {
  return config.riskAcknowledged || state.riskAcknowledgedAt !== null;
}

export function riskAcknowledgedAt(): string | null {
  return config.riskAcknowledged ? "set via RETENTION_RISK_ACKNOWLEDGED" : state.riskAcknowledgedAt;
}

export async function acknowledgeRisk(): Promise<string> {
  if (!state.riskAcknowledgedAt) {
    state.riskAcknowledgedAt = new Date().toISOString();
    await persist();
    log.info("risk notice acknowledged", state.riskAcknowledgedAt);
  }
  return state.riskAcknowledgedAt;
}
