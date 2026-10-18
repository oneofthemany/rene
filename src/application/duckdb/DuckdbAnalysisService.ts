import { isAbsolute } from "node:path";
import type { DuckdbAnalysisPort } from "./DuckdbAnalysisPort.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import {
  duckdbRequestSchema,
  type DuckdbOperation,
} from "../../domain/duckdb/duckdbDatabase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { jsonObjectSchema } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";

/** Shared CLI/MCP admission, execution, and Evidence composition for DuckDB. */
export class DuckdbAnalysisService {
  constructor(readonly provider: DuckdbAnalysisPort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  /** Run one caller-selected request and retain database identity inline. */
  async execute(
    operation: DuckdbOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError(operation));
    const request = duckdbRequestSchema.safeParse({ operation, input });
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
      request.data.operation === "inspect_duckdb_database" &&
      !isAbsolute(request.data.input.path)
    )
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["path"],
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
        confidence: "observed",
      }),
    );
  }
}
