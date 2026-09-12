import { createClient, type ClickHouseClient } from "@clickhouse/client";

import { config } from "../config.js";
import { log } from "../logger.js";

let client: ClickHouseClient | undefined;

export function clickhouse(): ClickHouseClient {
  if (!client) {
    client = createClient({
      url: config.clickhouse.url,
      username: config.clickhouse.user,
      password: config.clickhouse.password,
      database: config.clickhouse.database,
      clickhouse_settings: {
        // Retention mutations are fire-and-forget; we report the mutation id instead
        // of holding the HTTP request open for what can be a multi-minute merge.
        mutations_sync: "0",
      },
    });
  }
  return client;
}

export async function closeClickhouse(): Promise<void> {
  await client?.close();
  client = undefined;
}

/** `ON CLUSTER x` when a cluster name is configured; empty for the single-node compose default. */
export function onCluster(): string {
  return config.clickhouse.cluster ? ` ON CLUSTER ${escapeIdentifier(config.clickhouse.cluster)}` : "";
}

export function escapeIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to interpolate unsafe ClickHouse identifier: ${name}`);
  }
  return name;
}

export async function query<T>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
  const result = await clickhouse().query({
    query: sql,
    query_params: params,
    format: "JSONEachRow",
  });
  return result.json<T>();
}

export async function command(sql: string, params?: Record<string, unknown>): Promise<void> {
  log.debug("clickhouse command", sql);
  await clickhouse().command({ query: sql, query_params: params });
}

/**
 * Which of the tables we know how to prune actually exist on this instance.
 * Langfuse renamed `event_log` to `blob_storage_file_log` mid-v3 and dropped
 * `event_log` entirely in v4, so nothing is assumed — we introspect.
 */
export async function existingTables(candidates: string[]): Promise<Set<string>> {
  const rows = await query<{ name: string }>(
    `SELECT name FROM system.tables WHERE database = {db:String} AND name IN ({names:Array(String)})`,
    { db: config.clickhouse.database, names: candidates },
  );
  return new Set(rows.map((r) => r.name));
}

export async function pingClickhouse(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const rows = await query<{ version: string }>("SELECT version() AS version");
    return { ok: true, version: rows[0]?.version };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
