import { z } from "zod";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";

const count = z.number().int().nonnegative();
const name = z.string();

const inventory = z.strictObject({
  storage: z.strictObject({
    database_size: z.string(),
    block_size: count,
    total_blocks: count,
    used_blocks: count,
    free_blocks: count,
    wal_size: z.string(),
  }),
  tables: z.array(
    z.strictObject({
      schema: name,
      name,
      estimated_rows: count.nullable(),
      column_count: count,
      has_primary_key: z.boolean(),
    }),
  ),
  columns: z.array(
    z.strictObject({
      schema: name,
      table: name,
      name,
      type: z.string(),
      nullable: z.boolean(),
      default: z.string().nullable(),
    }),
  ),
  views: z.array(z.strictObject({ schema: name, name })),
  indexes: z.array(
    z.strictObject({ schema: name, table: name, name, unique: z.boolean() }),
  ),
  sequences: z.array(z.strictObject({ schema: name, name })),
});

const rows = z.strictObject({
  row_count: count,
  rows: z.array(z.array(z.string().nullable())),
  truncated_cells: count,
});

const summary = z.array(
  z.strictObject({
    column: name,
    type: z.string(),
    min: z.string().nullable(),
    max: z.string().nullable(),
    approx_unique: count.nullable(),
    null_percentage: z.number().nullable(),
    count,
  }),
);

export type DuckdbInventory = z.infer<typeof inventory>;
export type DuckdbRows = z.infer<typeof rows>;
export type DuckdbSummary = z.infer<typeof summary>;

/** The single JSON cell every query prints, parsed against its exact shape. */
const parseCell = <T>(
  stdout: string,
  schema: z.ZodType<T>,
  what: string,
): T => {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length !== 1)
    throw new AnalysisProtocolError(
      `duckdb printed ${String(lines.length)} lines for the ${what} query; expected one JSON value`,
    );
  let value: unknown;
  try {
    value = JSON.parse(lines[0] ?? "");
  } catch (cause) {
    throw new AnalysisProtocolError(`duckdb ${what} output is not JSON`, {
      cause,
    });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new AnalysisProtocolError(
      `duckdb ${what} output has an unexpected shape`,
      { cause: parsed.error },
    );
  return parsed.data;
};

export const parseInventory = (stdout: string): DuckdbInventory =>
  parseCell(stdout, inventory, "inventory");
export const parseRows = (stdout: string): DuckdbRows =>
  parseCell(stdout, rows, "rows");
export const parseSummary = (stdout: string): DuckdbSummary =>
  parseCell(stdout, summary, "summarize");
