import { isAbsolute } from "node:path";

import type { ProviderAvailability } from "../application/AnalysisProvider.js";
import type { AnalysisErrorOptions } from "../domain/analysisErrorBase.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** Environment key selecting the caller's duckdb CLI. */
export const DUCKDB_COMMAND_ENV = "REA_DUCKDB_COMMAND";

const TOOL_REMEDIATION = `Supply the DuckDB 1.x CLI on PATH or through an absolute ${DUCKDB_COMMAND_ENV}; REA does not install it. Use a CLI at least as new as the DuckDB that wrote the database.`;

/** Host-tool refusals concern the caller's DuckDB installation, not the target. */
export const duckdbToolUnavailable = (
  operation: string,
  reason: string,
  options?: AnalysisErrorOptions,
): AnalysisCapabilityUnavailableError =>
  new AnalysisCapabilityUnavailableError("duckdb", operation, reason, {
    ...options,
    userMessage: `${/[.!?]$/u.test(reason) ? reason : `${reason}.`} ${TOOL_REMEDIATION}`,
  });

export interface DuckdbToolSelection {
  readonly command: string;
  readonly source: "environment" | "path";
}

export type DuckdbConfigurationFailureCode =
  | "duckdb_not_absolute"
  | "duckdb_version_unresolved"
  | "duckdb_version_unsupported";

export class DuckdbConfigurationFailure extends Error {
  constructor(
    readonly code: DuckdbConfigurationFailureCode,
    message: string,
    readonly diagnostics: Readonly<Record<string, JsonValue>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** An absolute environment path, else PATH resolution. REA never installs DuckDB. */
export const resolveDuckdbTool = (
  environment: Readonly<Record<string, string | undefined>>,
): DuckdbToolSelection => {
  const configured = environment[DUCKDB_COMMAND_ENV];
  if (configured === undefined || configured.trim() === "")
    return { command: "duckdb", source: "path" };
  if (!isAbsolute(configured))
    throw new DuckdbConfigurationFailure(
      "duckdb_not_absolute",
      `${DUCKDB_COMMAND_ENV} must be an absolute path to the duckdb binary`,
      { configured },
    );
  return { command: configured, source: "environment" };
};

/**
 * Recognise `duckdb --version` output: `v1.5.4 (Variegata) 08e34c447b`.
 * The queries rely on 1.x catalog functions and settings.
 */
export const parseDuckdbVersion = (stdout: string): string | null => {
  const line = stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  const parsed = line === undefined ? null : /^v(\d+)\.\d+\.\d+\b/u.exec(line);
  if (parsed === null || line === undefined) return null;
  if (parsed[1] !== "1")
    throw new DuckdbConfigurationFailure(
      "duckdb_version_unsupported",
      "DuckDB inspection requires a 1.x duckdb CLI.",
      { version: line },
    );
  return line;
};

const rejectionCodeOf = (code: DuckdbConfigurationFailureCode) =>
  code === "duckdb_version_unsupported"
    ? ("unsupported_version" as const)
    : code === "duckdb_not_absolute"
      ? ("not_configured" as const)
      : ("version_unresolved" as const);

export const duckdbConfigurationAvailability = (
  cause: DuckdbConfigurationFailure,
): ProviderAvailability => ({
  status: "unavailable",
  code: rejectionCodeOf(cause.code),
  reason: cause.message,
  diagnostics: { ...cause.diagnostics },
});
