import { listProjects, type LangfuseProject } from "../clients/langfuse.js";
import { config } from "../config.js";
import { pgQuery } from "../clients/postgres.js";
import { errorMessage, log } from "../logger.js";
import type { Policy } from "../types.js";

export interface ProjectPlan {
  id: string;
  name: string;
  /** Which organization owns this project — decides which org key can mint its API key. */
  orgId: string | null;
  orgName: string | null;
  /** null means "keep forever" — this project is skipped by every time-based module. */
  retentionDays: number | null;
  /** Langfuse's own Enterprise retention setting, carried through read-only for comparison. */
  langfuseRetentionDays: number | null;
  /** Rows strictly older than this are expired. null when retention is disabled. */
  cutoff: Date | null;
  excluded: boolean;
}

export interface RunContext {
  policy: Policy;
  projects: ProjectPlan[];
  /** Projects that actually have a cutoff — the ones every module iterates. */
  active: ProjectPlan[];
  /** True when every project belongs to one organization, so an org key needs no disambiguation. */
  singleOrg: boolean;
  startedAt: Date;
}

/** Whether every known project belongs to the same organization. */
export function isSingleOrg(projects: Array<{ orgId: string | null }>): boolean {
  const ids = new Set(projects.map((p) => p.orgId).filter((id): id is string => Boolean(id)));
  return ids.size <= 1;
}

export function daysAgo(days: number, from = new Date()): Date {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
}

function resolveRetention(policy: Policy, projectId: string): number | null {
  if (policy.excludedProjects.includes(projectId)) return null;
  if (Object.prototype.hasOwnProperty.call(policy.projectOverrides, projectId)) {
    const override = policy.projectOverrides[projectId];
    // 0, null and a malformed entry all read as "never expire this project".
    return typeof override === "number" && override > 0 ? override : null;
  }
  return policy.defaultRetentionDays > 0 ? policy.defaultRetentionDays : null;
}

/**
 * Every project on the instance, across every organization.
 *
 * Postgres is queried first and deliberately: an organization-scoped API key can
 * only ever see its *own* organization, so discovering through
 * `GET /api/public/organizations/projects` would silently omit every project in
 * every other org — retention would appear to run correctly while half the
 * instance grew forever. Postgres has no such blind spot.
 *
 * The API is the fallback for when Postgres is unreachable, and it is the only
 * source for the Enterprise `retentionDays` field, which is merged in when
 * available.
 */
export async function discoverProjects(): Promise<LangfuseProject[]> {
  try {
    const rows = await pgQuery<{
      id: string;
      name: string;
      org_id: string;
      org_name: string;
      retention_days: number | null;
    }>(
      `SELECT p.id, p.name, p.org_id, o.name AS org_name, p.retention_days
         FROM projects p
         JOIN organizations o ON o.id = p.org_id
        WHERE p.deleted_at IS NULL
        ORDER BY o.name, p.name`,
    );
    if (rows.length > 0) {
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        organization: { id: r.org_id, name: r.org_name },
        retentionDays: r.retention_days,
      }));
    }
    log.warn("Postgres reported no projects; falling back to the Langfuse API");
  } catch (e) {
    log.warn("project discovery via Postgres failed; falling back to the Langfuse API", errorMessage(e));
  }

  // Fallback only. On a multi-org instance this sees one organization.
  const projects = await listProjects();
  if (projects.length > 0 && (config.langfuse.orgPublicKey || Object.keys(config.langfuse.orgKeys).length > 0)) {
    log.warn(
      "using API project discovery — on a multi-org instance this covers only the organizations whose keys are configured",
    );
  }
  return projects;
}

export async function buildContext(policy: Policy, now = new Date()): Promise<RunContext> {
  const discovered = await discoverProjects();

  const projects: ProjectPlan[] = discovered.map((p) => {
    const retentionDays = resolveRetention(policy, p.id);
    return {
      id: p.id,
      name: p.name,
      orgId: p.organization?.id ?? null,
      orgName: p.organization?.name ?? null,
      retentionDays,
      langfuseRetentionDays: p.retentionDays ?? null,
      cutoff: retentionDays === null ? null : daysAgo(retentionDays, now),
      excluded: policy.excludedProjects.includes(p.id),
    };
  });

  return {
    policy,
    projects,
    active: projects.filter((p) => p.cutoff !== null),
    singleOrg: isSingleOrg(projects),
    startedAt: now,
  };
}

/**
 * The most generous cutoff across active projects — the boundary before which
 * *every* project agrees data is expired.
 *
 * Returns null when any project keeps data forever, which makes instance-wide
 * operations (dropping a whole ClickHouse partition) unsafe.
 */
export function globalSafeCutoff(ctx: RunContext): Date | null {
  if (ctx.projects.some((p) => p.cutoff === null)) return null;
  if (ctx.active.length === 0) return null;
  return ctx.active.reduce<Date>((oldest, p) => (p.cutoff! < oldest ? p.cutoff! : oldest), ctx.active[0]!.cutoff!);
}

export function formatBytes(bytes: number): string {
  if (bytes < 0) return "n/a";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
