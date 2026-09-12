import { request as httpRequest } from "node:http";

import { config } from "../config.js";

export interface DockerVolumeUsage {
  name: string;
  /** Bytes on disk, or -1 when the daemon did not compute it. */
  size: number;
  mountpoint: string;
  /** Number of containers referencing the volume. */
  refCount: number;
  /** True when the volume belongs to this container's compose project; undefined if unknown. */
  inStack?: boolean;
}

interface SystemDfResponse {
  Volumes?: Array<{
    Name: string;
    Mountpoint: string;
    UsageData?: { Size: number; RefCount: number } | null;
  }>;
}

/** Minimal HTTP-over-unix-socket GET; avoids pulling in a full Docker SDK for one endpoint. */
function dockerGet<T>(path: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath: config.docker.socketPath, path, method: "GET", timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`Docker API ${res.statusCode} on ${path}: ${body.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(new Error(`Docker API returned non-JSON on ${path}: ${(e as Error).message}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Docker API timed out after ${timeoutMs}ms on ${path}`)));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Volume sizes straight from the daemon.
 *
 * `/system/df` is what `docker system df -v` calls. It walks each volume with the
 * equivalent of `du`, so on a multi-GB ClickHouse volume it can take tens of
 * seconds — callers cache the result rather than calling it per page load.
 */
export async function volumeUsage(timeoutMs = 120_000): Promise<DockerVolumeUsage[]> {
  const df = await dockerGet<SystemDfResponse>("/system/df", timeoutMs);
  const sameStack = await volumesInOwnStack();

  return (df.Volumes ?? []).map((v) => ({
    name: v.Name,
    size: v.UsageData?.Size ?? -1,
    mountpoint: v.Mountpoint,
    refCount: v.UsageData?.RefCount ?? 0,
    inStack: sameStack === null ? undefined : sameStack.has(v.Name),
  }));
}

interface ContainerSummary {
  Id: string;
  Labels?: Record<string, string>;
  Mounts?: Array<{ Type: string; Name?: string }>;
}

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/**
 * Volume names belonging to the same compose project as this container.
 *
 * A shared host runs many stacks, and a dashboard that lists someone else's
 * database volume alongside ClickHouse is noise. Returns null when the project
 * cannot be determined (not running under compose, or no socket), in which case
 * callers fall back to matching volume names.
 */
async function volumesInOwnStack(): Promise<Set<string> | null> {
  try {
    // Inside a container the hostname is the short container id by default.
    const self = await dockerGet<ContainerSummary>(`/containers/${process.env.HOSTNAME}/json`, 10_000);
    const project = self.Labels?.[COMPOSE_PROJECT_LABEL];
    if (!project) return null;

    const containers = await dockerGet<ContainerSummary[]>("/containers/json?all=1", 20_000);
    const names = new Set<string>();
    for (const container of containers) {
      if (container.Labels?.[COMPOSE_PROJECT_LABEL] !== project) continue;
      for (const mount of container.Mounts ?? []) {
        if (mount.Type === "volume" && mount.Name) names.add(mount.Name);
      }
    }
    return names;
  } catch {
    return null;
  }
}

export interface DockerPing {
  ok: boolean;
  /** Deliberately switched off, as opposed to failing — the UI shows these differently. */
  disabled?: boolean;
  version?: string;
  error?: string;
}

/**
 * Docker socket reachability, with the failure explained rather than just reported.
 *
 * The three realistic causes look identical in a raw errno, so each gets the
 * sentence that actually resolves it.
 */
export async function pingDocker(): Promise<DockerPing> {
  if (!config.docker.enabled) {
    return {
      ok: false,
      disabled: true,
      error: "Turned off by RETENTION_DOCKER_STATS_ENABLED=false. Named-volume sizes are not collected.",
    };
  }
  try {
    const v = await dockerGet<{ Version: string }>("/version", 5_000);
    return { ok: true, version: v.Version };
  } catch (e) {
    const message = (e as Error).message;
    const code = (e as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      return {
        ok: false,
        error:
          `No socket at ${config.docker.socketPath}. Mount it read-only ` +
          `(-v /var/run/docker.sock:/var/run/docker.sock:ro), or set ` +
          `RETENTION_DOCKER_STATS_ENABLED=false to stop asking.`,
      };
    }
    if (code === "EACCES" || code === "EPERM") {
      return {
        ok: false,
        error:
          `Permission denied on ${config.docker.socketPath}. The container joins the socket's group at ` +
          `start-up, so this usually means the socket was mounted after the container started, or the ` +
          `host uses rootless Docker with a socket elsewhere. Recreate the container; if it persists, ` +
          `check 'ls -ln ${config.docker.socketPath}' inside and outside.`,
      };
    }
    return { ok: false, error: message };
  }
}
