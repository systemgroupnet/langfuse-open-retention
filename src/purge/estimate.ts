import { config } from "../config.js";
import { query } from "../clients/clickhouse.js";

export interface TableFootprint {
  table: string;
  rows: number;
  bytesOnDisk: number;
  uncompressedBytes: number;
}

export async function tableFootprints(): Promise<TableFootprint[]> {
  const rows = await query<{
    table: string;
    rows: string;
    bytesOnDisk: string;
    uncompressedBytes: string;
  }>(
    `SELECT table,
            sum(rows)                    AS rows,
            sum(bytes_on_disk)           AS bytesOnDisk,
            sum(data_uncompressed_bytes) AS uncompressedBytes
       FROM system.parts
      WHERE active AND database = {db:String}
      GROUP BY table
      ORDER BY bytesOnDisk DESC`,
    { db: config.clickhouse.database },
  );

  // ClickHouse returns 64-bit aggregates as strings in JSON to avoid precision loss.
  return rows.map((r) => ({
    table: r.table,
    rows: Number(r.rows),
    bytesOnDisk: Number(r.bytesOnDisk),
    uncompressedBytes: Number(r.uncompressedBytes),
  }));
}

/**
 * Disk bytes attributable to a subset of rows.
 *
 * ClickHouse cannot report the compressed size of an arbitrary row subset, so we
 * scale the table's on-disk size by the fraction of rows that are expired. It is
 * an estimate and is labelled as one in the UI: good enough to answer "is this
 * run worth doing", not a precise figure.
 */
export function estimateBytes(footprint: TableFootprint | undefined, expiredRows: number): number {
  if (!footprint || footprint.rows <= 0 || expiredRows <= 0) return 0;
  const ratio = Math.min(1, expiredRows / footprint.rows);
  return Math.round(footprint.bytesOnDisk * ratio);
}
