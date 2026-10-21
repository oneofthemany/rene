import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import { digestSchema } from "../digests.js";

/** Format identity shared by discovery, catalog, and observed DuckDB results. */
export const DUCKDB_PROVIDER_IDENTITY = {
  id: "duckdb",
  name: "DuckDB database inspection",
  version: null,
} as const;

/** Default selected-table sample size. */
export const DUCKDB_ROW_LIMIT_DEFAULT = 20;
/** Rows are evidence samples, not exports. */
export const DUCKDB_ROW_LIMIT_MAX = 500;
/** Each projected cell keeps at most this many characters of its text form. */
export const DUCKDB_CELL_CHARS = 4096;

const nonnegative = z.number().int().nonnegative();
const identifier = z.string().min(1);

const tableSelection = {
  schema: identifier
    .optional()
    .describe("Exact schema of the selected table; default main"),
  table: identifier
    .optional()
    .describe("Exact base-table name; views are not executed"),
  columns: z
    .array(identifier)
    .min(1)
    .optional()
    .describe(
      "Exact row columns in caller-selected order; requires table. Omit to sample every column.",
    ),
  row_limit: z
    .number()
    .int()
    .min(1)
    .max(DUCKDB_ROW_LIMIT_MAX)
    .optional()
    .describe(
      `Selected-table sample size, default ${String(DUCKDB_ROW_LIMIT_DEFAULT)}`,
    ),
  summarize: z
    .boolean()
    .optional()
    .describe(
      "Also return DuckDB SUMMARIZE per-column statistics (min, max, approximate distinct, null percentage) over the whole selected table; requires table",
    ),
  schema_scope: z
    .enum(["inventory", "selected_table", "database"])
    .optional()
    .describe(
      "Default: table inventory without a table, or the selected table's columns with one. database expands every table's columns.",
    ),
};

/** Caller intent for DuckDB inspection through a caller-supplied duckdb CLI. */
export const duckdbInputSchemas = {
  inspect_duckdb_client: z.strictObject({}),
  inspect_duckdb_database: z
    .strictObject({
      path: localPathStringSchema.describe(
        "Absolute path to an offline DuckDB database snapshot; a sibling <path>.wal is copied with it",
      ),
      ...tableSelection,
    })
    .describe("row_limit, columns, summarize and selected_table require table.")
    .superRefine((input, context) => {
      for (const key of [
        "row_limit",
        "columns",
        "summarize",
        "schema",
      ] as const)
        if (input[key] !== undefined && input.table === undefined)
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} requires an explicit table selection`,
          });
      if (input.schema_scope === "selected_table" && input.table === undefined)
        context.addIssue({
          code: "custom",
          path: ["schema_scope"],
          message: "selected_table schema scope requires table",
        });
    })
    .meta({
      dependentRequired: {
        row_limit: ["table"],
        columns: ["table"],
        summarize: ["table"],
        schema: ["table"],
      },
    }),
} as const;

export type DuckdbOperation = keyof typeof duckdbInputSchemas;
export type InspectDuckdbDatabaseInput = z.infer<
  (typeof duckdbInputSchemas)["inspect_duckdb_database"]
>;
export type DuckdbRequest = {
  [Name in DuckdbOperation]: {
    operation: Name;
    input: z.infer<(typeof duckdbInputSchemas)[Name]>;
  };
}[DuckdbOperation];

export const duckdbRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("inspect_duckdb_client"),
    input: duckdbInputSchemas.inspect_duckdb_client,
  }),
  z.strictObject({
    operation: z.literal("inspect_duckdb_database"),
    input: duckdbInputSchemas.inspect_duckdb_database,
  }),
]);

/** The schema scope a request resolves to. */
export const duckdbSchemaScope = (
  input: InspectDuckdbDatabaseInput,
): "inventory" | "selected_table" | "database" =>
  input.schema_scope ??
  (input.table === undefined ? "inventory" : "selected_table");

const client = z.strictObject({
  duckdb_command: z.string().min(1),
  duckdb_source: z.enum(["environment", "path"]),
  duckdb_version: z.string().min(1).nullable(),
});

const fileIdentity = z.strictObject({
  path: localPathStringSchema,
  bytes: nonnegative,
  sha256: digestSchema,
});

const column = z.strictObject({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
  default: z.string().nullable(),
});

const table = z.strictObject({
  schema: z.string(),
  name: z.string(),
  /** DuckDB's own estimate; exact counts are only taken for a selected table. */
  estimated_rows: nonnegative.nullable(),
  column_count: nonnegative,
  has_primary_key: z.boolean(),
  /** Null when the scope did not request this table's columns. */
  columns: z.array(column).nullable(),
});

const summaryColumn = z.strictObject({
  column: z.string(),
  type: z.string(),
  min: z.string().nullable(),
  max: z.string().nullable(),
  approx_unique: nonnegative.nullable(),
  null_percentage: z.number().nullable(),
  count: nonnegative,
});

export const duckdbResultSchemas = {
  inspect_duckdb_client: z.strictObject({ client }),
  inspect_duckdb_database: z.strictObject({
    client,
    artifact: fileIdentity,
    wal: fileIdentity.nullable(),
    storage: z.strictObject({
      database_size: z.string(),
      block_size: nonnegative,
      total_blocks: nonnegative,
      used_blocks: nonnegative,
      free_blocks: nonnegative,
      wal_size: z.string(),
    }),
    schema: z.strictObject({
      scope: z.enum(["inventory", "selected_table", "database"]),
      tables: z.array(table),
      views: z.array(z.strictObject({ schema: z.string(), name: z.string() })),
      indexes: z.array(
        z.strictObject({
          schema: z.string(),
          table: z.string(),
          name: z.string(),
          unique: z.boolean(),
        }),
      ),
      sequences: z.array(
        z.strictObject({ schema: z.string(), name: z.string() }),
      ),
    }),
    rows: z
      .strictObject({
        schema: z.string(),
        table: z.string(),
        columns: z.array(z.string()),
        row_limit: z.number().int().positive(),
        /** Exact count over the whole table. */
        row_count: nonnegative,
        /** Each cell is DuckDB's text form, or null for SQL NULL. */
        rows: z.array(z.array(z.string().nullable())),
        truncated_cells: nonnegative,
        cell_chars: z.number().int().positive(),
      })
      .nullable(),
    summary: z.array(summaryColumn).nullable(),
  }),
} as const;
