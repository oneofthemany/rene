import { DUCKDB_CELL_CHARS } from "../domain/duckdb/duckdbDatabase.js";

/**
 * Applied before every query, then locked so no later statement can undo
 * them. External access off refuses file, ATTACH, extension and network I/O;
 * two threads and a memory cap keep DuckDB inside the prlimit address space.
 */
export const DUCKDB_SESSION_SETTINGS = [
  "SET enable_external_access=false",
  "SET autoload_known_extensions=false",
  "SET autoinstall_known_extensions=false",
  "SET allow_community_extensions=false",
  "SET threads=2",
  "SET memory_limit='512MB'",
  "SET lock_configuration=true",
] as const;

/** One statement whose single result cell is a JSON document. */
export const duckdbScript = (query: string): string =>
  `${DUCKDB_SESSION_SETTINGS.join("; ")}; ${query}`;

/** A quoted identifier; only ever applied to names read back from the catalog. */
export const quoteIdentifier = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;

const own = "database_name = current_database() AND NOT internal";

/** Storage facts and the full catalog of the attached database, as one JSON value. */
export const INVENTORY_QUERY = `SELECT to_json({
  storage: (SELECT {database_size: database_size, block_size: block_size,
      total_blocks: total_blocks, used_blocks: used_blocks,
      free_blocks: free_blocks, wal_size: wal_size}
    FROM pragma_database_size() WHERE database_name = current_database()),
  tables: (SELECT coalesce(list({schema: schema_name, name: table_name,
      estimated_rows: estimated_size, column_count: column_count,
      has_primary_key: has_primary_key} ORDER BY schema_name, table_name), [])
    FROM duckdb_tables() WHERE ${own} AND NOT temporary),
  columns: (SELECT coalesce(list({schema: schema_name, "table": table_name,
      name: column_name, "type": data_type, nullable: is_nullable,
      "default": column_default} ORDER BY schema_name, table_name, column_index), [])
    FROM duckdb_columns() WHERE ${own} AND table_oid IN
      (SELECT table_oid FROM duckdb_tables() WHERE ${own} AND NOT temporary)),
  views: (SELECT coalesce(list({schema: schema_name, name: view_name}
      ORDER BY schema_name, view_name), [])
    FROM duckdb_views() WHERE ${own} AND NOT temporary),
  indexes: (SELECT coalesce(list({schema: schema_name, "table": table_name,
      name: index_name, "unique": is_unique} ORDER BY schema_name, table_name, index_name), [])
    FROM duckdb_indexes() WHERE database_name = current_database()),
  sequences: (SELECT coalesce(list({schema: schema_name, name: sequence_name}
      ORDER BY schema_name, sequence_name), [])
    FROM duckdb_sequences() WHERE database_name = current_database() AND NOT temporary)
})`;

const qualified = (schema: string, table: string) =>
  `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

/**
 * The first `limit` rows in storage order, each cell cast to its text form
 * and cut at DUCKDB_CELL_CHARS, plus the exact row count and how many cells
 * were cut.
 */
export const rowsQuery = (
  schema: string,
  table: string,
  columns: readonly string[],
  limit: number,
): string => {
  const cast = columns
    .map(
      (name, i) => `CAST(${quoteIdentifier(name)} AS VARCHAR) AS c${String(i)}`,
    )
    .join(", ");
  const cells = columns
    .map((_, i) => `left(c${String(i)}, ${String(DUCKDB_CELL_CHARS)})`)
    .join(", ");
  const cut = columns
    .map(
      (_, i) =>
        `(coalesce(length(c${String(i)}), 0) > ${String(DUCKDB_CELL_CHARS)})::INTEGER`,
    )
    .join(" + ");
  return `WITH sample AS (SELECT ${cast} FROM ${qualified(schema, table)} LIMIT ${String(limit)})
SELECT to_json({
  row_count: (SELECT count(*) FROM ${qualified(schema, table)}),
  rows: (SELECT coalesce(list([${cells}]), []) FROM sample),
  truncated_cells: (SELECT coalesce(sum(${cut}), 0) FROM sample)
})`;
};

/** DuckDB's SUMMARIZE over the whole table, with long extremes cut. */
export const summarizeQuery = (schema: string, table: string): string =>
  `SELECT to_json(coalesce(list({"column": column_name, "type": column_type,
  "min": left(CAST("min" AS VARCHAR), 256), "max": left(CAST("max" AS VARCHAR), 256),
  approx_unique: approx_unique, null_percentage: CAST(null_percentage AS DOUBLE),
  "count": "count"}), [])) FROM (SUMMARIZE ${qualified(schema, table)})`;
