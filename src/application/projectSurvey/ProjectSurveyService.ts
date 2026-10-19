import { isAbsolute } from "node:path";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import {
  projectSurveySchema,
  surveyProjectDirectoryInputSchema,
  type ProjectSurvey,
  type SurveyProjectDirectoryInput,
} from "../../domain/projectSurvey.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const OPERATION = "survey_project_directory";

export const PROJECT_SURVEY_PROVIDER_IDENTITY = {
  id: "rea-project-survey",
  name: "REA project directory survey",
  version: "1",
} as const;

/** Walks a directory: (input, signal) -> survey. */
export type ProjectSurveyWalker = (
  input: SurveyProjectDirectoryInput,
  signal?: AbortSignal,
) => Promise<ProjectSurvey>;

/** Shared input validation and Evidence for the project directory survey. */
export class ProjectSurveyService {
  constructor(readonly walk: ProjectSurveyWalker) {}

  async survey(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    const input = surveyProjectDirectoryInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    let surveyed: ProjectSurvey;
    try {
      surveyed = await this.walk(input.data, options?.signal);
    } catch (cause: unknown) {
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(OPERATION, { cause }));
      return err(
        new AnalysisInputError(OPERATION, {
          cause,
          userMessage: `survey_project_directory could not read ${input.data.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      );
    }
    const report = projectSurveySchema.safeParse(surveyed);
    if (!report.success)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "The directory survey produced a malformed report.",
        ),
      );
    return completeProviderEvidence(
      createEvidence(undefined, PROJECT_SURVEY_PROVIDER_IDENTITY, {
        operation: OPERATION,
        parameters: input.data,
        result: report.data,
        // The listing is observed; name-decided types and tool applicability
        // are derived from it.
        confidence: "derived",
        limitations: report.data.limitations,
        locations: [{ kind: "artifact-path", path: report.data.root }],
      }),
      options?.signal,
    );
  }
}
