import { randomUUID } from "node:crypto";

import { config } from "../config.js";
import { log } from "../logger.js";
import { getProvisionedKey, saveProvisionedKey } from "../state.js";

export interface LangfuseProject {
  id: string;
  name: string;
  organization?: { id: string; name: string };
  metadata?: Record<string, unknown>;
  /** EE-only retention setting, surfaced read-only so the dashboard can show it. */
  retentionDays?: number | null;
}

export interface ApiKeyPair {
  publicKey: string;
  secretKey: string;
}

export interface TraceSummary {
  id: string;
  timestamp: string;
  sessionId?: string | null;
  projectId?: string;
}

function basicAuth(keys: ApiKeyPair): string {
  return `Basic ${Buffer.from(`${keys.publicKey}:${keys.secretKey}`).toString("base64")}`;
}

class LangfuseApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`Langfuse API ${status} on ${path}: ${body.slice(0, 500)}`);
    this.name = "LangfuseApiError";
  }
}

async function request<T>(
  path: string,
  keys: ApiKeyPair,
  init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  const url = new URL(path, config.langfuse.baseUrl);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: basicAuth(keys),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(config.langfuse.requestTimeoutMs),
  });

  if (!response.ok) {
    throw new LangfuseApiError(response.status, url.pathname, await response.text());
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function orgKeys(): ApiKeyPair | undefined {
  const { orgPublicKey, orgSecretKey } = config.langfuse;
  return orgPublicKey && orgSecretKey ? { publicKey: orgPublicKey, secretKey: orgSecretKey } : undefined;
}

export async function health(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const url = new URL("/api/public/health", config.langfuse.baseUrl);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    // /health answers 503 with a body while the worker is degraded; the version is still useful.
    const body = (await response.json().catch(() => ({}))) as { version?: string; status?: string };
    return { ok: response.ok, version: body.version, error: response.ok ? undefined : body.status ?? String(response.status) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Every project this tool can see.
 *
 * With an org-scoped key we get the whole organization. Otherwise we fall back to
 * whatever explicit project keys were configured, each of which resolves exactly
 * one project via GET /api/public/projects.
 */
export async function listProjects(): Promise<LangfuseProject[]> {
  const org = orgKeys();
  if (org) {
    const response = await request<{ data: LangfuseProject[] }>("/api/public/organizations/projects", org);
    return response.data;
  }

  const projects: LangfuseProject[] = [];
  for (const [projectId, keys] of Object.entries(config.langfuse.projectKeys)) {
    try {
      const response = await request<{ data: LangfuseProject[] }>("/api/public/projects", keys);
      projects.push(...response.data);
    } catch (e) {
      log.warn(`could not resolve project ${projectId} from its API key`, (e as Error).message);
      projects.push({ id: projectId, name: projectId });
    }
  }
  return projects;
}

/**
 * A project-scoped key for `projectId`, in priority order:
 *   1. explicitly configured via LANGFUSE_PROJECT_KEYS
 *   2. one this tool minted earlier and persisted
 *   3. a fresh one minted through the org-scoped API (idempotent: we supply the key pair)
 */
export async function keysForProject(projectId: string): Promise<ApiKeyPair | undefined> {
  const explicit = config.langfuse.projectKeys[projectId];
  if (explicit) return explicit;

  const provisioned = getProvisionedKey(projectId);
  if (provisioned) return provisioned;

  const org = orgKeys();
  if (!org || !config.langfuse.autoProvisionKeys) return undefined;

  const keys: ApiKeyPair = {
    publicKey: `pk-lf-${randomUUID()}`,
    secretKey: `sk-lf-${randomUUID()}`,
  };
  await request(`/api/public/projects/${encodeURIComponent(projectId)}/apiKeys`, org, {
    method: "POST",
    body: { note: "langfuse-open-retention (managed)", ...keys },
  });
  await saveProvisionedKey(projectId, keys);
  log.info("provisioned a managed API key for project", { projectId, publicKey: keys.publicKey });
  return keys;
}

/**
 * Trace IDs with `timestamp` strictly before `cutoff`, oldest first.
 *
 * Deliberately requests `fields=core` — we only need ids, and pulling input/output
 * for hundreds of thousands of traces would be gigabytes of wasted transfer.
 *
 * Pages are walked with a moving `toTimestamp` rather than an increasing `page`
 * number: rows vanish underneath us as we delete, which makes offset paging skip
 * records. Anchoring on the timestamp of the last trace seen is stable.
 */
export async function* iterateExpiredTraces(
  keys: ApiKeyPair,
  cutoff: Date,
  pageSize: number,
): AsyncGenerator<TraceSummary> {
  let toTimestamp = cutoff;
  const seen = new Set<string>();

  for (;;) {
    const response = await request<{ data: TraceSummary[]; meta: { totalItems: number } }>(
      "/api/public/traces",
      keys,
      {
        query: {
          toTimestamp: toTimestamp.toISOString(),
          limit: pageSize,
          page: 1,
          orderBy: "timestamp.desc",
          fields: "core",
        },
      },
    );

    if (response.data.length === 0) return;

    let oldest: Date | null = null;
    for (const trace of response.data) {
      if (seen.has(trace.id)) continue;
      seen.add(trace.id);
      yield trace;
      const ts = new Date(trace.timestamp);
      if (!oldest || ts < oldest) oldest = ts;
    }

    if (response.data.length < pageSize) return;

    // A full page of traces we had all seen before means the anchor cannot move
    // without skipping rows. Stop; the remainder is still expired and is picked
    // up by the next run.
    if (!oldest) return;

    // `toTimestamp` is exclusive, so stepping to `oldest + 1ms` keeps that exact
    // instant in range and `seen` absorbs the overlap. When that would not
    // advance the window (a whole page sharing one timestamp), fall back to the
    // exclusive bound to guarantee forward progress.
    const next = new Date(oldest.getTime() + 1);
    toTimestamp = next < toTimestamp ? next : oldest;
  }
}

/**
 * How many traces are older than `cutoff`, from the API's own pagination total.
 *
 * A dry run needs the count, not the ids, and paging a six-figure backlog just to
 * measure it would cost hundreds of requests for a number the first response
 * already carries.
 */
export async function countExpiredTraces(keys: ApiKeyPair, cutoff: Date): Promise<number> {
  const response = await request<{ meta: { totalItems: number } }>("/api/public/traces", keys, {
    query: { toTimestamp: cutoff.toISOString(), limit: 1, page: 1, fields: "core" },
  });
  return response.meta?.totalItems ?? 0;
}

/** Enqueues deletion of up to a few hundred traces; the Langfuse worker performs it asynchronously. */
export async function deleteTraces(keys: ApiKeyPair, traceIds: string[]): Promise<void> {
  if (traceIds.length === 0) return;
  await request("/api/public/traces", keys, { method: "DELETE", body: { traceIds } });
}

export function hasOrgKeys(): boolean {
  return orgKeys() !== undefined;
}

export type ProjectKeyStatus = "ready" | "provisionable" | "missing";

/**
 * Whether a project can be purged via the API, without the side effect of
 * minting a key. The dashboard renders this on every page load, so it must stay
 * read-only; `keysForProject` is what actually provisions, at run time.
 */
export function projectKeyStatus(projectId: string): ProjectKeyStatus {
  if (config.langfuse.projectKeys[projectId] || getProvisionedKey(projectId)) return "ready";
  if (orgKeys() && config.langfuse.autoProvisionKeys) return "provisionable";
  return "missing";
}
