import { isAbsolute } from "node:path";

import type { ProviderAvailability } from "../application/AnalysisProvider.js";
import type { AnalysisErrorOptions } from "../domain/analysisErrorBase.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** Environment key selecting the caller's Python interpreter. */
export const PYTHON_COMMAND_ENV = "REA_PYTHON_COMMAND";

const TOOL_REMEDIATION = `Supply Python 3.8 or newer as python3 on PATH or through an absolute ${PYTHON_COMMAND_ENV}; REA does not install it. Source parses with the interpreter's own grammar, so use one at least as new as the target code.`;

export const pythonToolUnavailable = (
  operation: string,
  reason: string,
  options?: AnalysisErrorOptions,
): AnalysisCapabilityUnavailableError =>
  new AnalysisCapabilityUnavailableError("python", operation, reason, {
    ...options,
    userMessage: `${/[.!?]$/u.test(reason) ? reason : `${reason}.`} ${TOOL_REMEDIATION}`,
  });

export interface PythonToolSelection {
  readonly command: string;
  readonly source: "environment" | "path";
}

export type PythonConfigurationFailureCode =
  | "python_not_absolute"
  | "python_version_unresolved"
  | "python_version_unsupported";

export class PythonConfigurationFailure extends Error {
  constructor(
    readonly code: PythonConfigurationFailureCode,
    message: string,
    readonly diagnostics: Readonly<Record<string, JsonValue>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** An absolute environment path, else python3 from PATH. */
export const resolvePythonTool = (
  environment: Readonly<Record<string, string | undefined>>,
): PythonToolSelection => {
  const configured = environment[PYTHON_COMMAND_ENV];
  if (configured === undefined || configured.trim() === "")
    return { command: "python3", source: "path" };
  if (!isAbsolute(configured))
    throw new PythonConfigurationFailure(
      "python_not_absolute",
      `${PYTHON_COMMAND_ENV} must be an absolute path to a Python interpreter`,
      { configured },
    );
  return { command: configured, source: "environment" };
};

/** `python3 --version` prints `Python 3.14.8`; the helper needs 3.8+. */
export const parsePythonVersion = (stdout: string): string | null => {
  const line = stdout.trim().split(/\r?\n/u)[0]?.trim() ?? "";
  const parsed = /^Python (\d+)\.(\d+)\.\d+/u.exec(line);
  if (parsed === null) return null;
  if (parsed[1] !== "3" || Number(parsed[2]) < 8)
    throw new PythonConfigurationFailure(
      "python_version_unsupported",
      "Python source analysis requires Python 3.8 or newer.",
      { version: line },
    );
  return line;
};

export const pythonConfigurationAvailability = (
  cause: PythonConfigurationFailure,
): ProviderAvailability => ({
  status: "unavailable",
  code:
    cause.code === "python_version_unsupported"
      ? "unsupported_version"
      : cause.code === "python_not_absolute"
        ? "not_configured"
        : "version_unresolved",
  reason: cause.message,
  diagnostics: { ...cause.diagnostics },
});
