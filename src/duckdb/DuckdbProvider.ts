import type {
  ExecutionOptions,
  ProviderAvailability,
} from "../application/AnalysisProvider.js";
import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../application/AnalysisProvider.js";
import {
  DUCKDB_CELL_CHARS,
  DUCKDB_PROVIDER_IDENTITY,
  DUCKDB_ROW_LIMIT_DEFAULT,
  duckdbResultSchemas,
  duckdbSchemaScope,
  type DuckdbOperation,
  type DuckdbRequest,
  type InspectDuckdbDatabaseInput,
} from "../domain/duckdb/duckdbDatabase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisProtocolError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { err, ok, type Result } from "../domain/result.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import {
  runBoundedToolCommand,
  type BoundedToolCommandCleanup,
  type BoundedToolCommandLauncher,
  type BoundedToolFailures,
  type BoundedToolNativeBound,
} from "../process/BoundedToolCommand.js";
import { prepareNativeToolBound } from "../process/NativeToolBound.js";
import { ArtifactAnalysisResources } from "../process/ArtifactAnalysisResources.js";
import { readLinuxResourceLimits } from "../process/LinuxResourceLimits.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import {
  DuckdbConfigurationFailure,
  duckdbConfigurationAvailability,
  duckdbToolUnavailable,
  parseDuckdbVersion,
  resolveDuckdbTool,
  DUCKDB_COMMAND_ENV,
} from "./DuckdbConfiguration.js";
import {
  INVENTORY_QUERY,
  duckdbScript,
  rowsQuery,
  summarizeQuery,
} from "./DuckdbQueries.js";
import {
  parseInventory,
  parseRows,
  parseSummary,
  type DuckdbInventory,
} from "./DuckdbOutput.js";
import { DuckdbSnapshot } from "./DuckdbSnapshot.js";

export { DUCKDB_PROVIDER_IDENTITY };

const DATABASE_OPERATION = "inspect_duckdb_database";

const DUCKDB_FAILURES: BoundedToolFailures = {
  toolUnavailable: duckdbToolUnavailable,
  label: "DuckDB CLI",
  // A newer storage format than the CLI reads is the target's format, not a tool fault.
  unsupportedInput:
    /not a valid DuckDB database file|database file with version number|storage version|Serialization Error/iu,
};

// Two threads and a 512 MB cap (DuckdbQueries) keep DuckDB well inside 2 GiB.
const DUCKDB_BOUND = {
  provider: "duckdb",
  operation: DATABASE_OPERATION,
  limiterEnv: "REA_DUCKDB_PRLIMIT_COMMAND",
  limits: {
    address_space_bytes: 2 * 1024 ** 3,
    file_bytes: 256 * 1024 ** 2,
    cpu_seconds: 300,
  },
  windowsMemoryBytes: 2 * 1024 ** 3,
  unsupportedHost:
    "DuckDB inspection requires an enforceable native memory bound: Linux with util-linux prlimit, or Windows with owned Job Objects. This host remains unsupported.",
  limiterUnavailable:
    "Cannot establish the selected Linux resource limiter before opening the database.",
} as const;

const QUERY_LIMITS = { timeoutMs: 300_000, maxOutputBytes: 32 * 1024 ** 2 };

interface RetainedDuckdbCommand {
  readonly snapshot: DuckdbSnapshot | undefined;
  readonly resources: readonly string[];
  readonly reason: string;
  readonly capturedOutput: BoundedToolCommandCleanup["capturedOutput"];
  ownerReleased: boolean;
  failure: ProviderCleanupError | undefined;
}

export interface DuckdbProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly launcher?: BoundedToolCommandLauncher;
}

const inputIssue = (path: string, message: string) =>
  new AnalysisInputError(DATABASE_OPERATION, undefined, [
    { path: [path], reason: "invalid_value", message },
  ]);

/** Select the exact base table and columns from the database's own catalog. */
const selectTable = (
  inventory: DuckdbInventory,
  input: InspectDuckdbDatabaseInput,
): { schema: string; table: string; columns: string[] } | null => {
  if (input.table === undefined) return null;
  const schema = input.schema ?? "main";
  const found = inventory.tables.find(
    (t) => t.schema === schema && t.name === input.table,
  );
  if (found === undefined) {
    const isView = inventory.views.some(
      (v) => v.schema === schema && v.name === input.table,
    );
    throw inputIssue(
      "table",
      isView
        ? `${schema}.${input.table} is a view; views are not executed`
        : `No base table ${schema}.${input.table}. Tables: ${inventory.tables.map((t) => `${t.schema}.${t.name}`).join(", ") || "none"}`,
    );
  }
  const available = inventory.columns
    .filter((c) => c.schema === schema && c.table === input.table)
    .map((c) => c.name);
  const missing = (input.columns ?? []).filter((c) => !available.includes(c));
  if (missing.length > 0)
    throw inputIssue(
      "columns",
      `${schema}.${input.table} has no column ${missing.join(", ")}. Columns: ${available.join(", ")}`,
    );
  return { schema, table: input.table, columns: input.columns ?? available };
};

/** Inspect saved DuckDB databases through bounded, owned duckdb CLI processes. */
export class DuckdbProvider {
  readonly #resources = new ArtifactAnalysisResources(
    "duckdb",
    DATABASE_OPERATION,
    readStableArtifact,
    readLinuxResourceLimits,
    {
      message:
        "A DuckDB inspection is already active; retry after it completes.",
      details: { max_concurrent_inspections: 1 },
    },
  );
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly launcher: BoundedToolCommandLauncher | undefined;
  private readonly snapshots = new Set<DuckdbSnapshot>();
  private readonly snapshotFailures = new Map<DuckdbSnapshot, AnalysisError>();
  private readonly commands = new Map<
    ProviderProcessSupervisor,
    RetainedDuckdbCommand
  >();
  private nativeBound: BoundedToolNativeBound | undefined;
  private nativeLimitations: readonly string[] = [];

  constructor(options: DuckdbProviderOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.launcher = options.launcher;
  }

  private async run(
    operation: DuckdbOperation,
    command: string,
    args: readonly string[],
    limits: typeof QUERY_LIMITS,
    signal: AbortSignal | undefined,
    snapshot?: DuckdbSnapshot,
    inputPath?: string,
  ) {
    let cleanup: BoundedToolCommandCleanup | undefined;
    let retained: RetainedDuckdbCommand | undefined;
    const output = await runBoundedToolCommand({
      operation,
      command,
      arguments: args,
      limits,
      signal,
      failures: DUCKDB_FAILURES,
      environment:
        snapshot === undefined
          ? this.environment
          : { ...this.environment, HOME: snapshot.homePath },
      ...(inputPath === undefined ? {} : { inputPath }),
      ...(inputPath === undefined || this.nativeBound === undefined
        ? {}
        : { nativeBound: this.nativeBound }),
      ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
      retain: (owner, resources, reason, capturedOutput) => {
        retained = {
          snapshot,
          resources,
          reason,
          capturedOutput,
          ownerReleased: false,
          failure: undefined,
        };
        this.commands.set(owner, retained);
        cleanup = { reason, resources, capturedOutput };
      },
    });
    if (cleanup !== undefined) {
      const failure = new ProviderCleanupError(
        "duckdb",
        [
          ...new Set([
            ...(snapshot === undefined ? [] : [snapshot.path]),
            ...cleanup.resources,
          ]),
        ],
        {
          reason: cleanup.reason,
          previous_error: null,
          captured_output: {
            stdout: output.stdout,
            stderr: output.stderr,
            truncated: cleanup.capturedOutput.truncated,
          },
        },
        { operation },
      );
      if (retained !== undefined) retained.failure = failure;
      throw failure;
    }
    return output;
  }

  private async client(operation: DuckdbOperation, signal?: AbortSignal) {
    const selection = resolveDuckdbTool(this.environment);
    const { stdout } = await this.run(
      operation,
      selection.command,
      ["--version"],
      { timeoutMs: 20_000, maxOutputBytes: 64 * 1024 },
      signal,
    );
    const version = parseDuckdbVersion(stdout);
    if (version === null)
      throw new DuckdbConfigurationFailure(
        "duckdb_version_unresolved",
        `The selected duckdb command did not report a version. Set ${DUCKDB_COMMAND_ENV} to its absolute executable path.`,
      );
    return {
      selection,
      client: {
        duckdb_command: selection.command,
        duckdb_source: selection.source,
        duckdb_version: version,
      },
    };
  }

  async inspectAvailability(
    signal?: AbortSignal,
  ): Promise<ProviderAvailability> {
    const result = await this.#resources.run(
      async () => ok(await this.inspectAvailabilityAdmitted(signal)),
      signal,
    );
    if (!result.ok) throw result.error;
    return result.value;
  }

  private async inspectAvailabilityAdmitted(
    signal?: AbortSignal,
  ): Promise<ProviderAvailability> {
    try {
      const { client } = await this.client("inspect_duckdb_client", signal);
      await this.prepareBound();
      return {
        status: "available",
        code: null,
        reason: null,
        diagnostics: client,
      };
    } catch (cause) {
      if (cause instanceof ProviderCleanupError) throw cause;
      if (signal?.aborted || cause instanceof AnalysisCancelledError)
        throw new AnalysisCancelledError("inspect_duckdb_client", { cause });
      if (cause instanceof DuckdbConfigurationFailure)
        return duckdbConfigurationAvailability(cause);
      return {
        status: "unavailable",
        code:
          cause instanceof AnalysisCapabilityUnavailableError
            ? process.platform !== "linux" && process.platform !== "win32"
              ? "unsupported_host"
              : "executable_missing"
            : "version_unresolved",
        reason: cause instanceof Error ? cause.message : String(cause),
        diagnostics: {},
      };
    }
  }

  private async prepareBound(): Promise<void> {
    const prepared = await prepareNativeToolBound(
      DUCKDB_BOUND,
      this.environment,
      this.#resources,
    );
    this.nativeBound = prepared.nativeBound;
    this.nativeLimitations = prepared.limitations;
  }

  private async discard(
    snapshot: DuckdbSnapshot,
  ): Promise<AnalysisError | undefined> {
    try {
      if (
        [...this.commands.values()].some(
          (command) => command.snapshot === snapshot && !command.ownerReleased,
        )
      )
        throw new Error(
          "An unreleased command still owns the database snapshot",
        );
      await snapshot.close();
      this.snapshots.delete(snapshot);
      this.snapshotFailures.get(snapshot)?.resolveCleanup();
      this.snapshotFailures.delete(snapshot);
      return undefined;
    } catch (cause) {
      return new ProviderCleanupError(
        "duckdb",
        [snapshot.path],
        { reason: String(cause) },
        { operation: DATABASE_OPERATION, cause },
      );
    }
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.#resources.close();
    } catch (cause) {
      failures.push(cause);
    }
    for (const [owner, command] of this.commands) {
      if (command.ownerReleased) continue;
      try {
        const result = await owner.stop();
        if (result.status === "incomplete") failures.push(result.reason);
        else if (result.status === "not-owned")
          failures.push("Command ownership remains unresolved");
        else {
          command.ownerReleased = true;
          if (command.snapshot === undefined) {
            command.failure?.resolveCleanup();
            this.commands.delete(owner);
          }
        }
      } catch (cause) {
        failures.push(cause);
      }
    }
    for (const snapshot of this.snapshots) {
      const failure = await this.discard(snapshot);
      if (failure !== undefined) failures.push(failure);
      else
        for (const [owner, command] of this.commands)
          if (command.snapshot === snapshot) this.commands.delete(owner);
    }
    if (failures.length > 0)
      throw new ProviderCleanupError(
        "duckdb",
        [...this.snapshots]
          .map((snapshot) => snapshot.path)
          .concat([...this.commands.values()].flatMap((c) => c.resources)),
        { reason: "Owned process or snapshot cleanup failed" },
        { operation: "duckdb.close", cause: new AggregateError(failures) },
      );
  }

  async execute(
    request: DuckdbRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    return this.#resources.run(
      () => this.executeAdmitted(request, options),
      options?.signal,
    );
  }

  private async executeAdmitted(
    request: DuckdbRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const signal = options?.signal;
    let snapshot: DuckdbSnapshot | undefined;
    let result: Result<AnalysisExecution, AnalysisError>;
    try {
      signal?.throwIfAborted();
      const { selection, client } = await this.client(
        request.operation,
        signal,
      );
      const provider = {
        ...DUCKDB_PROVIDER_IDENTITY,
        version: client.duckdb_version,
      };
      if (request.operation === "inspect_duckdb_client")
        result = ok(
          createAnalysisExecution(
            duckdbResultSchemas.inspect_duckdb_client.parse({ client }),
            provider,
          ),
        );
      else {
        await this.prepareBound();
        const owned = await DuckdbSnapshot.create();
        snapshot = owned;
        this.snapshots.add(owned);
        const input = request.input;
        const identity = await owned.capture(input.path, signal);
        const query = (sql: string) =>
          this.run(
            DATABASE_OPERATION,
            selection.command,
            [
              "-readonly",
              "-init",
              owned.initPath,
              "-list",
              "-noheader",
              "-c",
              duckdbScript(sql),
              owned.path,
            ],
            QUERY_LIMITS,
            signal,
            owned,
            input.path,
          );
        const inventory = parseInventory((await query(INVENTORY_QUERY)).stdout);
        const selected = selectTable(inventory, input);
        const rowLimit = input.row_limit ?? DUCKDB_ROW_LIMIT_DEFAULT;
        const rows =
          selected === null
            ? null
            : parseRows(
                (
                  await query(
                    rowsQuery(
                      selected.schema,
                      selected.table,
                      selected.columns,
                      rowLimit,
                    ),
                  )
                ).stdout,
              );
        const summary =
          selected === null || input.summarize !== true
            ? null
            : parseSummary(
                (await query(summarizeQuery(selected.schema, selected.table)))
                  .stdout,
              );
        await owned.verify(identity, input.path, signal);
        const scope = duckdbSchemaScope(input);
        const expands = (schema: string, name: string) =>
          scope === "database" ||
          (scope === "selected_table" &&
            schema === selected?.schema &&
            name === selected.table);
        const data = duckdbResultSchemas.inspect_duckdb_database.parse({
          client,
          artifact: { path: input.path, ...identity.database },
          wal:
            identity.wal === null
              ? null
              : { path: `${input.path}.wal`, ...identity.wal },
          storage: inventory.storage,
          schema: {
            scope,
            tables: inventory.tables.map((t) => ({
              ...t,
              columns: expands(t.schema, t.name)
                ? inventory.columns
                    .filter((c) => c.schema === t.schema && c.table === t.name)
                    .map(({ name, type, nullable, default: fallback }) => ({
                      name,
                      type,
                      nullable,
                      default: fallback,
                    }))
                : null,
            })),
            views: inventory.views,
            indexes: inventory.indexes,
            sequences: inventory.sequences,
          },
          rows:
            selected === null || rows === null
              ? null
              : {
                  schema: selected.schema,
                  table: selected.table,
                  columns: selected.columns,
                  row_limit: rowLimit,
                  ...rows,
                  cell_chars: DUCKDB_CELL_CHARS,
                },
          summary,
        });
        result = ok(
          createAnalysisExecution(data, provider, {
            subject: {
              path: input.path,
              format: "file",
              sha256: identity.database.sha256,
            },
            limitations: [
              ...this.nativeLimitations,
              "The duckdb CLI opened an owned copy read-only, with external access, extension loading and configuration changes disabled; the WAL is replayed in memory, never checkpointed",
              "A file copy of a live database and WAL is not an atomic snapshot; supply a quiescent one",
              ...(rows === null
                ? []
                : [
                    "Sample rows are the first rows in storage order, each cell in DuckDB's text form",
                  ]),
              ...(rows !== null && rows.truncated_cells > 0
                ? [
                    `${String(rows.truncated_cells)} cell(s) were cut at ${String(DUCKDB_CELL_CHARS)} characters`,
                  ]
                : []),
              ...(summary === null
                ? []
                : [
                    "approx_unique is DuckDB's HyperLogLog estimate; min and max are cut at 256 characters",
                  ]),
            ],
          }),
        );
      }
    } catch (cause) {
      result = err(
        cause instanceof AnalysisError
          ? cause
          : signal?.aborted
            ? new AnalysisCancelledError(request.operation, { cause })
            : cause instanceof DuckdbConfigurationFailure
              ? duckdbToolUnavailable(request.operation, cause.message, {
                  cause,
                })
              : new AnalysisProtocolError(
                  `DuckDB inspection failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                  { cause },
                ),
      );
    }
    if (signal?.aborted && result.ok)
      result = err(
        new AnalysisCancelledError(request.operation, { cause: signal.reason }),
      );
    const pending =
      snapshot === undefined
        ? undefined
        : [...this.commands.values()].find((c) => c.snapshot === snapshot);
    if (snapshot !== undefined && pending === undefined) {
      const cleanup = await this.discard(snapshot);
      if (cleanup !== undefined)
        result = err(
          result.ok
            ? cleanup
            : analysisErrorWithCleanupFailure(
                result.error,
                cleanup,
                request.operation,
              ),
        );
    }
    if (
      snapshot !== undefined &&
      pending !== undefined &&
      (result.ok || !(result.error instanceof ProviderCleanupError))
    )
      result = err(
        new ProviderCleanupError(
          "duckdb",
          [...new Set([snapshot.path, ...pending.resources])],
          {
            reason: pending.reason,
            previous_error: result.ok
              ? null
              : projectAnalysisError(result.error),
          },
          { operation: request.operation },
        ),
      );
    if (
      snapshot !== undefined &&
      this.snapshots.has(snapshot) &&
      !result.ok &&
      result.error.cleanupIncomplete
    )
      this.snapshotFailures.set(snapshot, result.error);
    return result;
  }
}
