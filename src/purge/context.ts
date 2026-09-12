import { listProjects, type LangfuseProject } from "../clients/langfuse.js";
import { pgQuery } from "../clients/postgres.js";
import { errorMessage, log } from "../logger.js";
import type { Policy } from "../types.js";

export interface ProjectPlan {
  id: string;
  name: string;
  /** null means "keep forever" — this project is skipped by every time-based module. */
  retentionDays: number | null;
  /** Rows strictly older than this are expired. null when retention is disabled. */
  cutoff: Date | null;
  excluded: boolean;
}

export interface RunContext {
  policy: Policy;
  projects: ProjectPlan[];
  /** Projects that actually have a cutoff — the ones every module iterates. */
  active: ProjectPlan[];
  startedAt: Date;
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
 * Project list, preferring the Langfuse API (gives us names and the EE retention
 * field) and falling back to Postgres so the tool still works when no API key is
 * configured at all.
 */
export async function discoverProjects(): Promise<LangfuseProject[]> {
  try {
    const projects = await listProjects();
    if (projects.length > 0) return projects;
    log.warn("Langfuse API returned no projects; falling back to Postgres");
  } catch (e) {
    log.warn("project discovery via Langfuse API failed; falling back to Postgres", errorMessage(e));
  }

  const rows = await pgQuery<{ id: string; name: string; deleted_at: Date | null }>(
    `SELECT id, name, deleted_at FROM projects ORDER BY name`,
  );
  return rows.filter((r) => !r.deleted_at).map((r) => ({ id: r.id, name: r.name }));
}

export async function buildContext(policy: Policy, now = new Date()): Promise<RunContext> {
  const discovered = await discoverProjects();

  const projects: ProjectPlan[] = discovered.map((p) => {
    const retentionDays = resolveRetention(policy, p.id);
    return {
      id: p.id,
      name: p.name,
      retentionDays,
      cutoff: retentionDays === null ? null : daysAgo(retentionDays, now),
      excluded: policy.excludedProjects.includes(p.id),
    };
  });

  return {
    policy,
    projects,
    active: projects.filter((p) => p.cutoff !== null),
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
