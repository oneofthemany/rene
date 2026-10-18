import type { DuckdbAnalysisPort } from "../application/duckdb/DuckdbAnalysisPort.js";
import { DuckdbProvider } from "../duckdb/DuckdbProvider.js";

/** Construct one DuckDB provider bound to the caller-selected CLI. */
export const createDuckdbAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DuckdbAnalysisPort => new DuckdbProvider({ environment });
