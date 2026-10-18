import { readFile } from "node:fs/promises";
import { z } from "incur";
import { PythonAnalysisService } from "../application/python/PythonAnalysisService.js";
import type { PythonAnalysisPort } from "../application/python/PythonAnalysisPort.js";
import { createPythonAnalysisProvider } from "../composition/python.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { PythonOperation } from "../domain/python/pythonSourceAnalysis.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { err } from "../domain/result.js";

/** Project settings from a JSON file; an unreadable or non-object file is an input error. */
const readSettings = async (
  command: string,
  option: string,
  path: string,
): Promise<object> => {
  const refuse = (message: string) =>
    new AnalysisInputError(command, undefined, [
      { path: [option], reason: "invalid_value", message },
    ]);
  let text: string;
  try {
    text = await readFile(absoluteCallerPath(path), "utf8");
  } catch (cause) {
    throw refuse(
      `Cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw refuse(
      `${path} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw refuse(`${path} must hold a JSON object`);
  return value;
};

/** Expose the same explicit Python source requests through one-shot CLI commands. */
export const registerPythonCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  provider: PythonAnalysisPort = createPythonAnalysisProvider(environment),
): void => {
  const service = new PythonAnalysisService(provider);
  const execute = (
    name: string,
    operation: PythonOperation,
    input: () => Promise<unknown>,
  ) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, name, () =>
        finishAnalysisCommand(
          async () => {
            let resolved: unknown;
            try {
              resolved = await input();
            } catch (cause) {
              if (cause instanceof AnalysisInputError) return err(cause);
              throw cause;
            }
            return service.execute(operation, resolved, { signal });
          },
          service,
          "python",
          operation,
          signal,
        ),
      ),
    );

  cli.command(CLI_COMMANDS.inspectPythonClient, {
    description:
      "Inspect the caller-selected Python interpreter without reading source",
    args: z.object({}),
    run: () =>
      execute(CLI_COMMANDS.inspectPythonClient, "inspect_python_client", () =>
        Promise.resolve({}),
      ),
  });
  cli.command(CLI_COMMANDS.inspectPythonBlockingCalls, {
    description:
      "Find blocking calls reachable from the asyncio event loop in a Python source tree",
    args: z.object({
      root: z.string().min(1).describe("Python source tree root"),
    }),
    options: z.object({
      seeds: z
        .string()
        .optional()
        .describe(
          "JSON file with project settings: blocking, accepted, loop_methods, loop_probes, skip_dirs",
        ),
      includeAccepted: z
        .boolean()
        .optional()
        .describe("Also list accepted-by-design paths"),
      maxFindings: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Findings to return, default 200"),
      noDefaultSeeds: z
        .boolean()
        .optional()
        .describe("Use only the seeds from --seeds"),
    }),
    run: ({ args, options }) =>
      execute(
        CLI_COMMANDS.inspectPythonBlockingCalls,
        "inspect_python_blocking_calls",
        async () => ({
          ...(options.seeds === undefined
            ? {}
            : await readSettings(
                CLI_COMMANDS.inspectPythonBlockingCalls,
                "seeds",
                options.seeds,
              )),
          root: absoluteCallerPath(args.root),
          ...(options.includeAccepted === undefined
            ? {}
            : { include_accepted: options.includeAccepted }),
          ...(options.maxFindings === undefined
            ? {}
            : { max_findings: options.maxFindings }),
          ...(options.noDefaultSeeds === true ? { default_seeds: false } : {}),
        }),
      ),
  });
  cli.command(CLI_COMMANDS.inspectPythonDocsDrift, {
    description:
      "Cross-check docs, frontend calls and backend routes of a Python web app for drift",
    args: z.object({
      root: z.string().min(1).describe("Application tree root"),
    }),
    options: z.object({
      settings: z
        .string()
        .optional()
        .describe(
          "JSON file with project settings: docs_dirs, api_prefixes, backend_exclude_dirs, skip_dirs, ignore_symbols, config_mirrors",
        ),
      undocumented: z
        .boolean()
        .optional()
        .describe("Also list routes nothing mentions"),
      maxFindings: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Findings to return, default 200"),
    }),
    run: ({ args, options }) =>
      execute(
        CLI_COMMANDS.inspectPythonDocsDrift,
        "inspect_python_docs_drift",
        async () => ({
          ...(options.settings === undefined
            ? {}
            : await readSettings(
                CLI_COMMANDS.inspectPythonDocsDrift,
                "settings",
                options.settings,
              )),
          root: absoluteCallerPath(args.root),
          ...(options.undocumented === undefined
            ? {}
            : { undocumented: options.undocumented }),
          ...(options.maxFindings === undefined
            ? {}
            : { max_findings: options.maxFindings }),
        }),
      ),
  });
};
