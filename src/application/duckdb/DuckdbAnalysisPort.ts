import type {
  AnalysisExecution,
  ExecutionOptions,
  ProviderAvailability,
} from "../AnalysisProvider.js";
import type { DuckdbRequest } from "../../domain/duckdb/duckdbDatabase.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";

/** DuckDB inspection boundary over a caller-supplied duckdb CLI. */
export interface DuckdbAnalysisPort {
  /** Probe the CLI without opening any database. */
  inspectAvailability(signal?: AbortSignal): Promise<ProviderAvailability>;
  /** Retry cleanup of retained owned commands and database snapshots. */
  close(): Promise<void>;
  execute(
    request: DuckdbRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}
