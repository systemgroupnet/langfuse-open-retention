/**
 * Environment configuration.
 *
 * Names deliberately mirror Langfuse's own env vars (LANGFUSE_S3_*, CLICKHOUSE_*,
 * DATABASE_URL) so this service can be dropped into the same compose file and
 * inherit the exact same values via `${VAR}` interpolation.
 */

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** `{"<id>":{"publicKey":"...","secretKey":"..."}}` — used for both project and org key maps. */
function parseKeyMap(
  raw: string | undefined,
  varName: string,
  subject: string,
): Record<string, { publicKey: string; secretKey: string }> {
  if (!raw) return {};
  let parsed: Record<string, { publicKey: string; secretKey: string }>;
  try {
    parsed = JSON.parse(raw) as Record<string, { publicKey: string; secretKey: string }>;
  } catch (e) {
    throw new Error(`${varName} is not valid JSON: ${(e as Error).message}`);
  }
  for (const [id, keys] of Object.entries(parsed)) {
    if (!keys?.publicKey || !keys?.secretKey) {
      throw new Error(`${varName}: entry for ${subject} "${id}" needs both publicKey and secretKey`);
    }
  }
  return parsed;
}

export interface S3Target {
  bucket: string;
  prefix: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/**
 * Connection settings for one of Langfuse's three object-storage use cases.
 *
 * Each falls back to a `LANGFUSE_S3_*` value shared by all three. That fallback
 * is not just brevity: Langfuse's media and batch-export endpoints are often set
 * to a *browser-facing* address (it signs upload URLs with them), which does not
 * resolve from inside a container. Configuring one internally reachable endpoint
 * here avoids inheriting an address that cannot be dialled.
 */
function s3Target(kind: "EVENT_UPLOAD" | "MEDIA_UPLOAD" | "BATCH_EXPORT", defaultPrefix: string): S3Target {
  const p = `LANGFUSE_S3_${kind}_`;
  return {
    bucket: str(`${p}BUCKET`, str("LANGFUSE_S3_BUCKET", "langfuse")),
    prefix: optional(`${p}PREFIX`, defaultPrefix) ?? "",
    endpoint: str(`${p}ENDPOINT`, str("LANGFUSE_S3_ENDPOINT", "http://minio:9000")),
    region: str(`${p}REGION`, str("LANGFUSE_S3_REGION", "auto")),
    accessKeyId: str(`${p}ACCESS_KEY_ID`, str("LANGFUSE_S3_ACCESS_KEY_ID", "minio")),
    secretAccessKey: str(`${p}SECRET_ACCESS_KEY`, str("LANGFUSE_S3_SECRET_ACCESS_KEY", "miniosecret")),
    forcePathStyle: bool(`${p}FORCE_PATH_STYLE`, bool("LANGFUSE_S3_FORCE_PATH_STYLE", true)),
  };
}

/**
 * Parsed once at start-up.
 *
 * A bad value here is a deployment mistake, not a bug, so it is reported as one
 * line and the process exits. Letting the raw throw escape during ESM module
 * evaluation would bury the actual message under a stack trace, before any
 * handler in index.ts could format it.
 */
export const config = (() => {
  try {
    return {
    port: int("PORT", 3050),
    host: str("HOST", "0.0.0.0"),
    /** Where policy + run history are persisted. Mount a volume here. */
    dataDir: str("RETENTION_DATA_DIR", "/data"),
    logLevel: str("LOG_LEVEL", "info"),

    auth: {
      /** Shared admin password for the dashboard. Required unless auth is disabled. */
      password: optional("RETENTION_ADMIN_PASSWORD"),
      disabled: bool("RETENTION_AUTH_DISABLED", false),
      /** Signing secret for session cookies; random per boot if unset (logs everyone out on restart). */
      cookieSecret: optional("RETENTION_COOKIE_SECRET"),
      sessionHours: int("RETENTION_SESSION_HOURS", 12),
    },

    langfuse: {
      /** Internal base URL of langfuse-web, e.g. http://langfuse-web:3000 */
      baseUrl: str("LANGFUSE_BASE_URL", "http://langfuse-web:3000"),
      /**
       * Organization-scoped key, for instances with a single organization.
       * An org key only ever sees its own organization, so a multi-org instance
       * needs one per organization via LANGFUSE_ORG_KEYS below.
       */
      orgPublicKey: optional("LANGFUSE_ORG_PUBLIC_KEY"),
      orgSecretKey: optional("LANGFUSE_ORG_SECRET_KEY"),
      /** Per-organization keys: {"<orgId>":{"publicKey":"pk-lf-...","secretKey":"sk-lf-..."}} */
      orgKeys: parseKeyMap(optional("LANGFUSE_ORG_KEYS"), "LANGFUSE_ORG_KEYS", "organization"),
      /** Explicit per-project keys: {"<projectId>":{"publicKey":"pk-lf-...","secretKey":"sk-lf-..."}} */
      projectKeys: parseKeyMap(optional("LANGFUSE_PROJECT_KEYS"), "LANGFUSE_PROJECT_KEYS", "project"),
      /** Let the tool mint its own project-scoped keys via the org API when one is missing. */
      autoProvisionKeys: bool("LANGFUSE_AUTO_PROVISION_KEYS", true),
      requestTimeoutMs: int("LANGFUSE_REQUEST_TIMEOUT_MS", 60_000),
    },

    clickhouse: {
      url: str("CLICKHOUSE_URL", "http://clickhouse:8123"),
      user: str("CLICKHOUSE_USER", "clickhouse"),
      password: str("CLICKHOUSE_PASSWORD", "clickhouse"),
      database: str("CLICKHOUSE_DB", "default"),
      /** Cluster name for ON CLUSTER DDL; empty means single-node (the compose default). */
      cluster: optional("CLICKHOUSE_CLUSTER_NAME", ""),
    },

    postgres: {
      /** Same DATABASE_URL Langfuse uses. */
      url: str("DATABASE_URL", "postgresql://postgres:postgres@postgres:5432/postgres"),
      maxConnections: int("POSTGRES_MAX_CONNECTIONS", 4),
    },

    s3: {
      events: s3Target("EVENT_UPLOAD", "events/"),
      media: s3Target("MEDIA_UPLOAD", "media/"),
      exports: s3Target("BATCH_EXPORT", "exports/"),
    },

    docker: {
      /** Mount /var/run/docker.sock:/var/run/docker.sock:ro to enable real volume sizes. */
      socketPath: str("DOCKER_SOCKET_PATH", "/var/run/docker.sock"),
      enabled: bool("DOCKER_STATS_ENABLED", true),
      /** `docker system df` walks the volume tree with du; cache it. */
      cacheSeconds: int("DOCKER_STATS_CACHE_SECONDS", 900),
    },

    /**
     * Data directories to measure directly, as `Label=/path` pairs separated by
     * commas. For stacks that bind-mount their data instead of using named Docker
     * volumes, which `docker system df` cannot see. Mount them read-only.
     */
    diskPaths: optional("RETENTION_DISK_PATHS", ""),
    } as const;
  } catch (e) {
    process.stderr.write(`\nConfiguration error: ${(e as Error).message}\n\n`);
    process.exit(1);
  }
})();

export type Config = typeof config;
