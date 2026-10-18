import {
  duckdbInputSchemas,
  duckdbResultSchemas,
} from "../../domain/duckdb/duckdbDatabase.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";

/** DuckDB database inspection served by a caller-supplied duckdb CLI. */
export const DUCKDB_TOOL_CONTRACTS = [
  {
    name: "inspect_duckdb_client",
    ...toolContractMetadata("inspect_duckdb_client"),
    description:
      "Inspect the caller-selected duckdb CLI: command, selection source and version. Opens no database. REA never installs DuckDB; select it with an absolute REA_DUCKDB_COMMAND or from PATH.",
    kind: "duckdb-provider",
    inputSchema: duckdbInputSchemas.inspect_duckdb_client,
    outputSchema: evidenceResultOf(duckdbResultSchemas.inspect_duckdb_client),
    examples: [{ title: "Check the duckdb CLI", input: {} }],
  },
  {
    name: "inspect_duckdb_database",
    ...toolContractMetadata("inspect_duckdb_database"),
    description:
      "Inspect an explicit local DuckDB database snapshot and its sibling <path>.wal through an owned copy, without modifying either. Returns observed Evidence with database/WAL SHA-256, storage facts (size, blocks, WAL size), and the table, view, index and sequence inventory. Selecting an exact base table expands its columns, samples rows in storage order (default 20, at most 500; cells in DuckDB's text form, cut at 4096 characters) with an exact row count; summarize adds DuckDB SUMMARIZE statistics over the whole table. No arbitrary SQL, view execution, extension loading or network/file access: the CLI runs read-only with external access disabled and its configuration locked, under prlimit on Linux or a Job Object on Windows. Requires a caller-supplied DuckDB 1.x CLI at least as new as the writer. Supply a quiescent snapshot: a copy of a live database/WAL pair is not atomic.",
    kind: "duckdb-provider",
    inputSchema: duckdbInputSchemas.inspect_duckdb_database,
    outputSchema: evidenceResultOf(duckdbResultSchemas.inspect_duckdb_database),
    examples: [
      {
        title: "Inventory a DuckDB snapshot",
        input: { path: "/artifacts/telemetry.duckdb" },
      },
      {
        title: "Sample rows and column statistics from one table",
        input: {
          path: "/artifacts/telemetry.duckdb",
          table: "device_states",
          columns: ["ts", "ieee", "attribute", "numeric_val"],
          row_limit: 20,
          summarize: true,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
