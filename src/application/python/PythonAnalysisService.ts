import { isAbsolute } from "node:path";
import type { PythonAnalysisPort } from "./PythonAnalysisPort.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import {
  pythonRequestSchema,
  type PythonOperation,
} from "../../domain/python/pythonSourceAnalysis.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { jsonObjectSchema } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";

/** Shared CLI/MCP admission, execution, and Evidence composition for Python source. */
export class PythonAnalysisService {
  constructor(readonly provider: PythonAnalysisPort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  async execute(
    operation: PythonOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError(operation));
    const request = pythonRequestSchema.safeParse({ operation, input });
    if (!request.success)
      return err(
        analysisInputErrorFromIssues(
          operation,
          request.error.issues.map((issue) => ({
            ...issue,
            path: issue.path[0] === "input" ? issue.path.slice(1) : issue.path,
          })),
          input,
          { cause: request.error },
        ),
      );
    if (
      request.data.operation !== "inspect_python_client" &&
      !isAbsolute(request.data.input.root)
    )
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["root"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const executed = await this.provider.execute(request.data, options);
    if (!executed.ok) return executed;
    const execution = executed.value;
    return ok(
      createEvidence(execution.subject ?? undefined, execution.provider, {
        operation,
        parameters: jsonObjectSchema.parse(request.data.input),
        result: execution.result,
        rawResult: execution.rawResult,
        limitations: execution.limitations,
        locations: execution.locations,
        // Source analyses infer from parsed text, not from runtime observation.
        confidence:
          operation === "inspect_python_client" ? "observed" : "derived",
      }),
    );
  }
}
