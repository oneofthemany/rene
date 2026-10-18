import type {
  AnalysisExecution,
  ExecutionOptions,
  ProviderAvailability,
} from "../AnalysisProvider.js";
import type { PythonRequest } from "../../domain/python/pythonSourceAnalysis.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";

/** Python source analysis boundary over a caller-supplied interpreter. */
export interface PythonAnalysisPort {
  /** Probe the interpreter without reading any source. */
  inspectAvailability(signal?: AbortSignal): Promise<ProviderAvailability>;
  /** Retry cleanup of retained owned commands and request workspaces. */
  close(): Promise<void>;
  execute(
    request: PythonRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}
