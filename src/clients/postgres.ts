import pg from "pg";

import { config } from "../config.js";

let pool: pg.Pool | undefined;

export function postgres(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.postgres.url,
      max: config.postgres.maxConnections,
      // Retention sweeps are chatty but short-lived; don't hold connections open.
      idleTimeoutMillis: 30_000,
      statement_timeout: 120_000,
    });
  }
  return pool;
}

export async function closePostgres(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export async function pgQuery<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await postgres().query<T>(sql, params);
  return result.rows;
}

/** Returns the number of rows affected, without materialising them. */
export async function pgExec(sql: string, params: unknown[] = []): Promise<number> {
  const result = await postgres().query(sql, params);
  return result.rowCount ?? 0;
}

export async function pingPostgres(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const rows = await pgQuery<{ version: string }>("SELECT version() AS version");
    return { ok: true, version: rows[0]?.version?.split(",")[0] };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
