import { randomUUID } from "node:crypto";
import type { z } from "zod";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, type Result } from "../../domain/result.js";
import {
  editFileInputSchema,
  editFileResultSchema,
  findFilesInputSchema,
  findFilesResultSchema,
  readFileInputSchema,
  readFileResultSchema,
  recordTopicInputSchema,
  recordTopicResultSchema,
  type RecordTopicInput,
  runCommandInputSchema,
  runCommandResultSchema,
  searchTextInputSchema,
  searchTextResultSchema,
  writeFileInputSchema,
  writeFileResultSchema,
} from "../../domain/toolbox.js";
import type { ProviderProcessSupervisor } from "../../process/ProviderProcess.js";
import { runToolboxCommand } from "../../toolbox/ToolboxCommand.js";
import {
  editTextFile,
  findFiles,
  readTextFile,
  searchText,
  toolboxRoots,
  ToolboxRefusal,
  writeTextFile,
} from "../../toolbox/ToolboxFiles.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

export const TOOLBOX_PROVIDER_IDENTITY = {
  id: "rea-toolbox",
  name: "REA agent toolbox",
  version: "1",
} as const;

export const TOOLBOX_OPERATIONS = [
  "read_file",
  "write_file",
  "edit_file",
  "find_files",
  "search_text",
  "run_command",
  "record_topic",
] as const;
export type ToolboxOperation = (typeof TOOLBOX_OPERATIONS)[number];

interface OperationSpec {
  readonly input: z.ZodType;
  readonly result: z.ZodType;
  /** The path the Evidence locates, if the operation acts on one. */
  readonly location: (result: Record<string, unknown>) => string | undefined;
  readonly limitations: readonly string[];
}

/** A topic declaration: validated, given an id when new, and returned. */
const declareTopic = (input: RecordTopicInput) => ({
  topic_id: input.topic_id ?? randomUUID(),
  title: input.title,
  kind: input.kind,
  parent_id: input.parent_id,
  status: input.status,
  relations: input.relations,
  summary: input.summary,
  declared_at: new Date().toISOString(),
  created: input.topic_id === undefined,
});

const SPECS: Readonly<Record<ToolboxOperation, OperationSpec>> = {
  read_file: {
    input: readFileInputSchema,
    result: readFileResultSchema,
    location: (result) => String(result.path),
    limitations: [
      "At most 4 MiB of the file is decoded as UTF-8; the SHA-256 covers the whole file.",
      "A file with a NUL byte in its first 8 KiB is reported as binary without text.",
    ],
  },
  write_file: {
    input: writeFileInputSchema,
    result: writeFileResultSchema,
    location: (result) => String(result.path),
    limitations: [],
  },
  edit_file: {
    input: editFileInputSchema,
    result: editFileResultSchema,
    location: (result) => String(result.path),
    limitations: [],
  },
  find_files: {
    input: findFilesInputSchema,
    result: findFilesResultSchema,
    location: (result) => String(result.root),
    limitations: [
      "Symbolic links are listed but not followed; excluded folders are listed in excluded_folders, not searched.",
    ],
  },
  search_text: {
    input: searchTextInputSchema,
    result: searchTextResultSchema,
    location: (result) => String(result.root),
    limitations: [
      "Files over 2 MiB and files with a NUL byte in their first 8 KiB are skipped and counted, not searched.",
      "Matches are per line; a match spanning lines isn't found.",
    ],
  },
  run_command: {
    input: runCommandInputSchema,
    result: runCommandResultSchema,
    location: (result) => String(result.cwd),
    limitations: [
      "stdout and stderr keep at most 1 MiB together; output_truncated says when bytes were dropped.",
      "The command runs where REA runs (its container when started from the workbench), with the current user's permissions.",
    ],
  },
  record_topic: {
    input: recordTopicInputSchema,
    result: recordTopicResultSchema,
    location: () => undefined,
    limitations: [
      "A declaration is what the caller states about the conversation; the latest declaration of a topic_id is its current state.",
    ],
  },
};

/**
 * Input validation, root confinement and Evidence for the agent toolbox,
 * shared by MCP and CLI. Process owners whose cleanup failed are retained
 * and stopped again on close.
 */
export class ToolboxService {
  readonly #retained = new Set<ProviderProcessSupervisor>();

  constructor(
    readonly environment: Readonly<Record<string, string | undefined>>,
  ) {}

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.#retained].map(async (owner) => {
        const stopped = await owner.stop();
        if (stopped.status !== "incomplete") this.#retained.delete(owner);
      }),
    );
  }

  async execute(
    operation: ToolboxOperation,
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(operation, { cause: options.signal.reason }),
      );
    const spec = SPECS[operation];
    const parsed = spec.input.safeParse(rawInput);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(operation, parsed.error.issues, rawInput, {
          cause: parsed.error,
        }),
      );
    const input = parsed.data as never;
    let result: Record<string, unknown>;
    try {
      const roots = await toolboxRoots(this.environment);
      result = await this.#run(operation, roots, input, options);
    } catch (cause: unknown) {
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(operation, { cause }));
      const message = cause instanceof Error ? cause.message : String(cause);
      return err(
        new AnalysisInputError(
          operation,
          { cause, userMessage: `${operation}: ${message}` },
          cause instanceof ToolboxRefusal
            ? [{ path: [cause.field], reason: "invalid_value", message }]
            : [],
        ),
      );
    }
    const report = spec.result.parse(result) as Record<string, unknown>;
    return completeProviderEvidence(
      createEvidence(undefined, TOOLBOX_PROVIDER_IDENTITY, {
        operation,
        parameters: parsed.data as Readonly<Record<string, JsonValue>>,
        result: report as JsonValue,
        confidence: "observed",
        limitations: [...spec.limitations],
        locations: ((path) =>
          path === undefined ? [] : [{ kind: "artifact-path" as const, path }])(
          spec.location(report),
        ),
      }),
      options?.signal,
    );
  }

  #run(
    operation: ToolboxOperation,
    roots: readonly string[],
    input: never,
    options?: ExecutionOptions,
  ): Promise<Record<string, unknown>> {
    switch (operation) {
      case "read_file":
        return readTextFile(roots, input);
      case "write_file":
        return writeTextFile(roots, input);
      case "edit_file":
        return editTextFile(roots, input);
      case "find_files":
        return findFiles(roots, input);
      case "search_text":
        return searchText(roots, input);
      case "run_command":
        return runToolboxCommand(roots, input, {
          environment: this.environment,
          signal: options?.signal,
          retain: (owner) => this.#retained.add(owner),
        });
      case "record_topic":
        return Promise.resolve(declareTopic(input));
    }
  }
}
