import type { FastifyInstance } from "fastify";

import {
  authConfigured,
  checkPassword,
  clearSessionCookie,
  isAuthenticated,
  issueToken,
  requireAuth,
  setSessionCookie,
} from "../auth.js";
import { pingClickhouse } from "../clients/clickhouse.js";
import { pingDocker } from "../clients/docker.js";
import { hasOrgKeys, health as langfuseHealth, projectKeyStatus } from "../clients/langfuse.js";
import { pingPostgres } from "../clients/postgres.js";
import { pingS3 } from "../clients/s3.js";
import { config } from "../config.js";
import { errorMessage } from "../logger.js";
import { buildContext, discoverProjects } from "../purge/context.js";
import { expiredTraceCounts } from "../purge/traces.js";
import { currentRun, isRunning, runRetention } from "../purge/runner.js";
import { applySchedule, schedulerStatus } from "../scheduler.js";
import { getPolicy, getRun, getRuns, setPolicy } from "../state.js";
import { invalidateStorageCache, storageSnapshot } from "../storage/stats.js";
import { MIN_RETENTION_DAYS, ValidationError, validatePolicy } from "./policy-validation.js";

export async function registerApi(app: FastifyInstance): Promise<void> {
  // Auth applies to everything under /api except the session endpoints below.
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.url.startsWith("/api/session") || request.url.startsWith("/api/login")) return;
    await requireAuth(request, reply);
  });

  app.get("/api/session", async (request) => ({
    authenticated: isAuthenticated(request),
    authRequired: !config.auth.disabled,
    authConfigured: authConfigured(),
  }));

  app.post("/api/login", async (request, reply) => {
    const body = (request.body ?? {}) as { password?: string };
    if (!authConfigured()) {
      return reply.code(500).send({ error: "RETENTION_ADMIN_PASSWORD is not set on the server." });
    }
    if (!checkPassword(body.password)) {
      return reply.code(401).send({ error: "Incorrect password." });
    }
    setSessionCookie(reply, issueToken());
    return { ok: true };
  });

  app.post("/api/logout", async (_request, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  /** Connectivity and version banner for the dashboard header. */
  app.get("/api/status", async () => {
    const [langfuse, clickhouse, postgres, docker, events, media, exports] = await Promise.all([
      langfuseHealth(),
      pingClickhouse(),
      pingPostgres(),
      pingDocker(),
      pingS3(config.s3.events),
      pingS3(config.s3.media),
      pingS3(config.s3.exports),
    ]);

    return {
      langfuse: { ...langfuse, baseUrl: config.langfuse.baseUrl, orgKeysConfigured: hasOrgKeys() },
      clickhouse,
      postgres,
      docker,
      objectStorage: {
        events: { ...events, bucket: config.s3.events.bucket, prefix: config.s3.events.prefix },
        media: { ...media, bucket: config.s3.media.bucket, prefix: config.s3.media.prefix },
        exports: { ...exports, bucket: config.s3.exports.bucket, prefix: config.s3.exports.prefix },
      },
      scheduler: schedulerStatus(),
      run: { active: isRunning(), current: currentRun() },
      minRetentionDays: MIN_RETENTION_DAYS,
    };
  });

  app.get("/api/policy", async () => getPolicy());

  app.put("/api/policy", async (request, reply) => {
    try {
      const saved = await setPolicy(validatePolicy(request.body));
      applySchedule(saved);
      return saved;
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  /**
   * Projects with their resolved retention window and how much is currently
   * expired. This is the per-project view the policy editor is built around.
   */
  app.get("/api/projects", async (request) => {
    const withCounts = (request.query as { counts?: string }).counts !== "false";
    const policy = getPolicy();
    const ctx = await buildContext(policy);
    const discovered = await discoverProjects();
    const eeRetention = new Map(discovered.map((p) => [p.id, p.retentionDays ?? null]));

    let perTable: Record<string, number> = {};
    let perProject: Record<string, number> = {};
    if (withCounts) {
      try {
        const expired = await expiredTraceCounts(ctx);
        perTable = expired.perTable;
        perProject = expired.perProject;
      } catch (e) {
        request.log.warn(`expired counts unavailable: ${errorMessage(e)}`);
      }
    }

    const projects = ctx.projects.map((p) => ({
      id: p.id,
      name: p.name,
      retentionDays: p.retentionDays,
      cutoff: p.cutoff?.toISOString() ?? null,
      excluded: p.excluded,
      hasOverride: Object.prototype.hasOwnProperty.call(policy.projectOverrides, p.id),
      /** Langfuse's own EE retention setting, shown read-only for comparison. */
      langfuseRetentionDays: eeRetention.get(p.id) ?? null,
      expiredTraces: perProject[p.id] ?? null,
      keyStatus: policy.modules.traces.mode === "api" ? projectKeyStatus(p.id) : null,
    }));

    return { projects, expiredRows: perTable };
  });

  app.get("/api/storage", async (request) => {
    if ((request.query as { refresh?: string }).refresh === "true") invalidateStorageCache();
    return storageSnapshot();
  });

  app.get("/api/runs", async () => ({ runs: getRuns(), active: currentRun() }));

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = getRun(id);
    if (!run) return reply.code(404).send({ error: "No such run." });
    return run;
  });

  /**
   * Start a run.
   *
   * `mode: "preview"` forces a dry run whatever the policy says. `mode: "live"`
   * additionally requires `confirm: "DELETE"` so a stray click cannot start an
   * irreversible sweep.
   */
  app.post("/api/runs", async (request, reply) => {
    const body = (request.body ?? {}) as { mode?: "preview" | "live"; confirm?: string };
    const mode = body.mode === "live" ? "live" : "preview";

    if (isRunning()) return reply.code(409).send({ error: "A run is already in progress." });

    const policy = getPolicy();
    if (mode === "live") {
      if (body.confirm !== "DELETE") {
        return reply.code(400).send({ error: 'Live runs require confirm: "DELETE".' });
      }
      if (policy.dryRun) {
        return reply
          .code(400)
          .send({ error: "Policy is in dry-run mode. Turn dry-run off in Policy before running live." });
      }
    }

    // Kick it off and return immediately; the UI polls /api/runs for progress.
    const started = runRetention({ trigger: "manual", forceDryRun: mode === "preview" });
    started
      .then(() => invalidateStorageCache())
      .catch((e) => request.log.error(`run failed: ${errorMessage(e)}`));

    return reply.code(202).send({ accepted: true, mode });
  });
}
