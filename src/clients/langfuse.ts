import { randomUUID } from "node:crypto";

import { config } from "../config.js";
import { errorMessage, log } from "../logger.js";
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

/** The single-organization shorthand, if configured. */
function defaultOrgKeys(): ApiKeyPair | undefined {
  const { orgPublicKey, orgSecretKey } = config.langfuse;
  return orgPublicKey && orgSecretKey ? { publicKey: orgPublicKey, secretKey: orgSecretKey } : undefined;
}

/**
 * Which organization the single-pair shorthand actually belongs to.
 *
 * An org key is scoped to exactly one organization, but the key itself does not
 * say which. Asking the API once and caching the answer lets a multi-org instance
 * use the shorthand safely: it is applied only to its own org's projects rather
 * than wrongly assumed to work everywhere.
 */
let shorthandOrgId: string | null | undefined;

async function resolveShorthandOrg(): Promise<string | null> {
  if (shorthandOrgId !== undefined) return shorthandOrgId;

  const keys = defaultOrgKeys();
  if (!keys) {
    shorthandOrgId = null;
    return null;
  }
  try {
    const response = await request<{ data: LangfuseProject[] }>("/api/public/organizations/projects", keys);
    shorthandOrgId = response.data[0]?.organization?.id ?? null;
    if (shorthandOrgId) log.info("resolved LANGFUSE_ORG_* key to organization", shorthandOrgId);
  } catch (e) {
    log.warn("could not resolve which organization LANGFUSE_ORG_* belongs to", errorMessage(e));
    shorthandOrgId = null;
  }
  return shorthandOrgId;
}

/**
 * The org-scoped key able to act on `orgId`.
 *
 * `singleOrgInstance` lets the shorthand be used without a lookup when the whole
 * instance has exactly one organization — the common case, where insisting on an
 * explicit org id would be pointless ceremony.
 */
async function orgKeysFor(orgId: string | null, singleOrgInstance = false): Promise<ApiKeyPair | undefined> {
  if (orgId && config.langfuse.orgKeys[orgId]) return config.langfuse.orgKeys[orgId];

  const shorthand = defaultOrgKeys();
  if (!shorthand) return undefined;
  if (!orgId || singleOrgInstance) return shorthand;

  return (await resolveShorthandOrg()) === orgId ? shorthand : undefined;
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
 * Every project reachable through the configured API keys.
 *
 * Each organization key sees only its own organization, so all of them are
 * queried and the results merged. This is a fallback path: `discoverProjects()`
 * prefers Postgres, which sees every organization whether or not a key exists
 * for it.
 */
export async function listProjects(): Promise<LangfuseProject[]> {
  const byId = new Map<string, LangfuseProject>();

  // Every configured organization key, since each sees only its own org.
  const orgPairs = [...Object.values(config.langfuse.orgKeys)];
  const shorthand = defaultOrgKeys();
  if (shorthand) orgPairs.push(shorthand);

  for (const keys of orgPairs) {
    try {
      const response = await request<{ data: LangfuseProject[] }>("/api/public/organizations/projects", keys);
      for (const project of response.data) byId.set(project.id, project);
    } catch (e) {
      log.warn(`an organization key could not list its projects: ${errorMessage(e)}`);
    }
  }
  if (byId.size > 0) return [...byId.values()];

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
export async function keysForProject(
  projectId: string,
  orgId: string | null = null,
  singleOrgInstance = false,
): Promise<ApiKeyPair | undefined> {
  const explicit = config.langfuse.projectKeys[projectId];
  if (explicit) return explicit;

  const provisioned = getProvisionedKey(projectId);
  if (provisioned) return provisioned;

  const org = await orgKeysFor(orgId, singleOrgInstance);
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
  return defaultOrgKeys() !== undefined || Object.keys(config.langfuse.orgKeys).length > 0;
}

/** Organizations with an explicitly configured key, for the dashboard's status banner. */
export function configuredOrgIds(): string[] {
  return Object.keys(config.langfuse.orgKeys);
}

export type ProjectKeyStatus = "ready" | "provisionable" | "missing";

/**
 * Whether a project can be purged via the API, without the side effect of
 * minting a key. The dashboard renders this on every page load, so it must stay
 * read-only; `keysForProject` is what actually provisions, at run time.
 */
export async function projectKeyStatus(
  projectId: string,
  orgId: string | null = null,
  singleOrgInstance = false,
): Promise<ProjectKeyStatus> {
  if (config.langfuse.projectKeys[projectId] || getProvisionedKey(projectId)) return "ready";
  if (!config.langfuse.autoProvisionKeys) return "missing";

  // Deliberately async: on a multi-org instance this has to resolve which
  // organization the LANGFUSE_ORG_* shorthand belongs to before it can say
  // whether it covers this project. Guessing optimistically would hide exactly
  // the gap this status exists to reveal. The lookup is cached, so a page full
  // of projects costs one request.
  return (await orgKeysFor(orgId, singleOrgInstance)) ? "provisionable" : "missing";
}
