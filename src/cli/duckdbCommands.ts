import { z } from "incur";
import { DuckdbAnalysisService } from "../application/duckdb/DuckdbAnalysisService.js";
import type { DuckdbAnalysisPort } from "../application/duckdb/DuckdbAnalysisPort.js";
import { createDuckdbAnalysisProvider } from "../composition/duckdb.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { DuckdbOperation } from "../domain/duckdb/duckdbDatabase.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Expose the same explicit DuckDB requests through one-shot CLI commands. */
export const registerDuckdbCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  provider: DuckdbAnalysisPort = createDuckdbAnalysisProvider(environment),
): void => {
  const service = new DuckdbAnalysisService(provider);
  const execute = (name: string, operation: DuckdbOperation, input: unknown) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, name, () =>
        finishAnalysisCommand(
          () => service.execute(operation, input, { signal }),
          service,
          "duckdb",
          operation,
          signal,
        ),
      ),
    );

  cli.command(CLI_COMMANDS.inspectDuckdbClient, {
    description:
      "Inspect the caller-selected duckdb CLI without opening a database",
    args: z.object({}),
    run: () =>
      execute(CLI_COMMANDS.inspectDuckdbClient, "inspect_duckdb_client", {}),
  });
  cli.command(CLI_COMMANDS.inspectDuckdbDatabase, {
    description:
      "Inspect DuckDB storage, schema and optional base-table rows and statistics from a local snapshot",
    args: z.object({
      path: z.string().min(1).describe("Local DuckDB database snapshot"),
    }),
    options: z.object({
      schema: z
        .string()
        .optional()
        .describe("Exact schema of the table; default main"),
      table: z.string().optional().describe("Exact base table name to read"),
      column: z
        .array(z.string())
        .optional()
        .describe(
          "Repeat to select exact row columns in order; requires table",
        ),
      rowLimit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Rows to sample, default 20, at most 500; requires table"),
      summarize: z
        .boolean()
        .optional()
        .describe(
          "Add SUMMARIZE column statistics over the whole table; requires table",
        ),
      schemaScope: z
        .enum(["inventory", "selected_table", "database"])
        .optional()
        .describe(
          "Inventory by default; database expands every table's columns",
        ),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.inspectDuckdbDatabase, "inspect_duckdb_database", {
        path: absoluteCallerPath(args.path),
        ...(options.schema === undefined ? {} : { schema: options.schema }),
        ...(options.table === undefined ? {} : { table: options.table }),
        ...(options.column === undefined ? {} : { columns: options.column }),
        ...(options.rowLimit === undefined
          ? {}
          : { row_limit: options.rowLimit }),
        ...(options.summarize === undefined
          ? {}
          : { summarize: options.summarize }),
        ...(options.schemaScope === undefined
          ? {}
          : { schema_scope: options.schemaScope }),
      }),
  });
};
