import { realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import type {
  ExecutionOptions,
  ProviderAvailability,
} from "../application/AnalysisProvider.js";
import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../application/AnalysisProvider.js";
import {
  DEFAULT_API_PREFIXES,
  DEFAULT_BLOCKING_SEEDS,
  DEFAULT_CITATION_SUFFIXES,
  DEFAULT_FRONTEND_SUFFIXES,
  DEFAULT_LOOP_PROBES,
  DEFAULT_SKIP_DIRS,
  DEFAULT_SYMBOL_SUFFIXES,
  PYTHON_FINDINGS_DEFAULT,
  PYTHON_PROVIDER_IDENTITY,
  pythonFindingSchema,
  pythonResultSchemas,
  type InspectPythonBlockingCallsInput,
  type InspectPythonDocsDriftInput,
  type PythonOperation,
  type PythonRequest,
} from "../domain/python/pythonSourceAnalysis.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { err, ok, type Result } from "../domain/result.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import {
  runBoundedToolCommand,
  type BoundedToolCommandCleanup,
  type BoundedToolCommandLauncher,
  type BoundedToolFailures,
  type BoundedToolNativeBound,
} from "../process/BoundedToolCommand.js";
import { prepareNativeToolBound } from "../process/NativeToolBound.js";
import { ArtifactAnalysisResources } from "../process/ArtifactAnalysisResources.js";
import { readLinuxResourceLimits } from "../process/LinuxResourceLimits.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { PrivateRuntimeRootUnavailableError } from "../process/PrivateRuntimeRootUnavailableError.js";
import {
  PythonConfigurationFailure,
  PYTHON_COMMAND_ENV,
  parsePythonVersion,
  pythonConfigurationAvailability,
  pythonToolUnavailable,
  resolvePythonTool,
} from "./PythonConfiguration.js";

export { PYTHON_PROVIDER_IDENTITY };

type SourceOperation = Exclude<PythonOperation, "inspect_python_client">;
const OPERATION: SourceOperation = "inspect_python_blocking_calls";
const HELPER = fileURLToPath(
  new URL("../../bridge/python/source_analysis.py", import.meta.url),
);
// -I ignores PYTHON* variables and the user site; -S skips site; -B writes no bytecode.
const ISOLATION = ["-I", "-S", "-B"] as const;
// A YAML mirror needs PyYAML from the interpreter's site-packages, so -S is dropped.
const ISOLATION_WITH_SITE = ["-I", "-B"] as const;

const PYTHON_FAILURES: BoundedToolFailures = {
  toolUnavailable: pythonToolUnavailable,
  label: "Python source analysis",
};

const PYTHON_BOUND = {
  provider: "python",
  operation: OPERATION,
  limiterEnv: "REA_PYTHON_PRLIMIT_COMMAND",
  limits: {
    address_space_bytes: 2 * 1024 ** 3,
    file_bytes: 16 * 1024 ** 2,
    cpu_seconds: 300,
  },
  windowsMemoryBytes: 2 * 1024 ** 3,
  unsupportedHost:
    "Python source analysis requires an enforceable native memory bound: Linux with util-linux prlimit, or Windows with owned Job Objects. This host remains unsupported.",
  limiterUnavailable:
    "Cannot establish the selected Linux resource limiter before reading the source tree.",
} as const;

/** Per-file read cap; generated or vendored modules larger than this are skipped. */
const MAX_FILE_BYTES = 4 * 1024 ** 2;
const MAX_FILES = 50_000;

const blockingReport = z.strictObject({
  python: z.string(),
  files: pythonResultSchemas.inspect_python_blocking_calls.shape.files,
  functions: z.number().int().nonnegative(),
  finding_count: z.number().int().nonnegative(),
  accepted_count: z.number().int().nonnegative(),
  findings: z.array(pythonFindingSchema),
});
const {
  client: _client,
  root: _root,
  truncated: _truncated,
  ...driftShape
} = pythonResultSchemas.inspect_python_docs_drift.shape;
const driftReport = z.strictObject({ python: z.string(), ...driftShape });

const READ_LIMITATIONS = [
  "Source is parsed with the selected interpreter's grammar, never imported or executed; symlinks are not followed",
  "The tree is read in place, not snapshotted; files.sha256 identifies exactly the bytes analysed",
] as const;

const coverage = (
  files: { skipped_count: number },
  shown: number,
  total: number,
): string[] => [
  ...(files.skipped_count > 0
    ? [
        `${String(files.skipped_count)} file(s) were skipped and not analysed; see files.skipped`,
      ]
    : []),
  ...(shown < total
    ? [`Findings were cut at ${String(shown)}; finding_count keeps the total`]
    : []),
];

interface RetainedPythonCommand {
  readonly root: PrivateRuntimeRoot | undefined;
  readonly resources: readonly string[];
  readonly reason: string;
  ownerReleased: boolean;
  failure: ProviderCleanupError | undefined;
}

export interface PythonSourceProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly launcher?: BoundedToolCommandLauncher;
}

const walkerBudget = { max_files: MAX_FILES, max_file_bytes: MAX_FILE_BYTES };
const skipDirs = (extra: readonly string[] | undefined) => [
  ...new Set([...DEFAULT_SKIP_DIRS, ...(extra ?? [])]),
];

const blockingRequest = (
  input: InspectPythonBlockingCallsInput,
  root: string,
) => ({
  analysis: "blocking_calls",
  root,
  skip_dirs: skipDirs(input.skip_dirs),
  blocking: [
    ...(input.default_seeds === false ? [] : DEFAULT_BLOCKING_SEEDS),
    ...(input.blocking ?? []),
  ],
  accepted: input.accepted ?? [],
  loop_methods: input.loop_methods ?? [],
  loop_probes: [
    ...new Set([...DEFAULT_LOOP_PROBES, ...(input.loop_probes ?? [])]),
  ],
  include_accepted: input.include_accepted === true,
  ...walkerBudget,
  max_findings: input.max_findings ?? PYTHON_FINDINGS_DEFAULT,
});

const driftRequest = (input: InspectPythonDocsDriftInput, root: string) => ({
  analysis: "docs_drift",
  root,
  skip_dirs: skipDirs(input.skip_dirs),
  docs_dirs: input.docs_dirs ?? ["docs"],
  api_prefixes: input.api_prefixes ?? [...DEFAULT_API_PREFIXES],
  backend_exclude_dirs: input.backend_exclude_dirs ?? [],
  frontend_suffixes: [...DEFAULT_FRONTEND_SUFFIXES],
  symbol_suffixes: [...DEFAULT_SYMBOL_SUFFIXES],
  citation_suffixes: [...DEFAULT_CITATION_SUFFIXES],
  ignore_symbols: input.ignore_symbols ?? [],
  config_mirrors: input.config_mirrors ?? [],
  undocumented: input.undocumented === true,
  ...walkerBudget,
  max_findings: input.max_findings ?? PYTHON_FINDINGS_DEFAULT,
});

/** Static analyses of a Python application tree via a bundled, owned helper. */
export class PythonSourceProvider {
  readonly #resources = new ArtifactAnalysisResources(
    "python",
    OPERATION,
    readStableArtifact,
    readLinuxResourceLimits,
    {
      message:
        "A Python source analysis is already active; retry after it completes.",
      details: { max_concurrent_inspections: 1 },
    },
  );
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly launcher: BoundedToolCommandLauncher | undefined;
  private readonly roots = new Set<PrivateRuntimeRoot>();
  private readonly commands = new Map<
    ProviderProcessSupervisor,
    RetainedPythonCommand
  >();
  private nativeBound: BoundedToolNativeBound | undefined;
  private nativeLimitations: readonly string[] = [];

  constructor(options: PythonSourceProviderOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.launcher = options.launcher;
  }

  private async run(
    operation: PythonOperation,
    command: string,
    args: readonly string[],
    limits: { timeoutMs: number; maxOutputBytes: number },
    signal: AbortSignal | undefined,
    owned?: PrivateRuntimeRoot,
    inputPath?: string,
  ) {
    let cleanup: BoundedToolCommandCleanup | undefined;
    let retained: RetainedPythonCommand | undefined;
    const output = await runBoundedToolCommand({
      operation,
      command,
      arguments: args,
      limits,
      signal,
      failures: PYTHON_FAILURES,
      environment: this.environment,
      ...(inputPath === undefined ? {} : { inputPath }),
      ...(inputPath === undefined || this.nativeBound === undefined
        ? {}
        : { nativeBound: this.nativeBound }),
      ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
      retain: (owner, resources, reason, capturedOutput) => {
        retained = {
          root: owned,
          resources,
          reason,
          ownerReleased: false,
          failure: undefined,
        };
        this.commands.set(owner, retained);
        cleanup = { reason, resources, capturedOutput };
      },
    });
    if (cleanup !== undefined) {
      const failure = new ProviderCleanupError(
        "python",
        [
          ...new Set([
            ...(owned === undefined ? [] : [owned.path]),
            ...cleanup.resources,
          ]),
        ],
        {
          reason: cleanup.reason,
          previous_error: null,
          captured_output: {
            stdout: output.stdout,
            stderr: output.stderr,
            truncated: cleanup.capturedOutput.truncated,
          },
        },
        { operation },
      );
      if (retained !== undefined) retained.failure = failure;
      throw failure;
    }
    return output;
  }

  private async client(operation: PythonOperation, signal?: AbortSignal) {
    const selection = resolvePythonTool(this.environment);
    const { stdout } = await this.run(
      operation,
      selection.command,
      [...ISOLATION, "--version"],
      { timeoutMs: 20_000, maxOutputBytes: 64 * 1024 },
      signal,
    );
    const version = parsePythonVersion(stdout);
    if (version === null)
      throw new PythonConfigurationFailure(
        "python_version_unresolved",
        `The selected interpreter did not report a Python version. Set ${PYTHON_COMMAND_ENV} to its absolute path.`,
      );
    return {
      python_command: selection.command,
      python_source: selection.source,
      python_version: version,
    };
  }

  async inspectAvailability(
    signal?: AbortSignal,
  ): Promise<ProviderAvailability> {
    const result = await this.#resources.run(async () => {
      try {
        const client = await this.client("inspect_python_client", signal);
        await this.prepareBound();
        return ok<ProviderAvailability>({
          status: "available",
          code: null,
          reason: null,
          diagnostics: client,
        });
      } catch (cause) {
        if (cause instanceof ProviderCleanupError) throw cause;
        if (signal?.aborted || cause instanceof AnalysisCancelledError)
          throw new AnalysisCancelledError("inspect_python_client", { cause });
        if (cause instanceof PythonConfigurationFailure)
          return ok(pythonConfigurationAvailability(cause));
        return ok<ProviderAvailability>({
          status: "unavailable",
          code:
            cause instanceof AnalysisCapabilityUnavailableError
              ? "executable_missing"
              : "version_unresolved",
          reason: cause instanceof Error ? cause.message : String(cause),
          diagnostics: {},
        });
      }
    }, signal);
    if (!result.ok) throw result.error;
    return result.value;
  }

  private async prepareBound(
    operation: PythonOperation = OPERATION,
  ): Promise<void> {
    const prepared = await prepareNativeToolBound(
      { ...PYTHON_BOUND, operation },
      this.environment,
      this.#resources,
    );
    this.nativeBound = prepared.nativeBound;
    this.nativeLimitations = prepared.limitations;
  }

  private async discard(
    root: PrivateRuntimeRoot,
  ): Promise<AnalysisError | undefined> {
    try {
      if (
        [...this.commands.values()].some(
          (c) => c.root === root && !c.ownerReleased,
        )
      )
        throw new Error(
          "An unreleased command still owns the request workspace",
        );
      await root.close();
      this.roots.delete(root);
      return undefined;
    } catch (cause) {
      return new ProviderCleanupError(
        "python",
        [root.path],
        { reason: String(cause) },
        { operation: OPERATION, cause },
      );
    }
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.#resources.close();
    } catch (cause) {
      failures.push(cause);
    }
    for (const [owner, command] of this.commands) {
      if (command.ownerReleased) continue;
      try {
        const result = await owner.stop();
        if (result.status === "incomplete") failures.push(result.reason);
        else if (result.status === "not-owned")
          failures.push("Command ownership remains unresolved");
        else {
          command.ownerReleased = true;
          command.failure?.resolveCleanup();
          if (command.root === undefined) this.commands.delete(owner);
        }
      } catch (cause) {
        failures.push(cause);
      }
    }
    for (const root of this.roots) {
      const failure = await this.discard(root);
      if (failure !== undefined) failures.push(failure);
      else
        for (const [owner, command] of this.commands)
          if (command.root === root) this.commands.delete(owner);
    }
    if (failures.length > 0)
      throw new ProviderCleanupError(
        "python",
        [...this.roots]
          .map((root) => root.path)
          .concat([...this.commands.values()].flatMap((c) => c.resources)),
        { reason: "Owned process or workspace cleanup failed" },
        { operation: "python.close", cause: new AggregateError(failures) },
      );
  }

  async execute(
    request: PythonRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    return this.#resources.run(
      () => this.executeAdmitted(request, options),
      options?.signal,
    );
  }

  private async sourceRoot(
    operation: SourceOperation,
    path: string,
  ): Promise<string> {
    const invalid = (message: string) =>
      new AnalysisInputError(operation, undefined, [
        { path: ["root"], reason: "invalid_value", message },
      ]);
    let resolved: string;
    try {
      resolved = await realpath(path);
    } catch (cause) {
      throw invalid(
        `Cannot resolve ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!(await stat(resolved)).isDirectory())
      throw invalid(`${path} is not a directory; select the source tree root`);
    return resolved;
  }

  private async workspace(
    operation: SourceOperation,
  ): Promise<PrivateRuntimeRoot> {
    try {
      const root = await PrivateRuntimeRoot.create({ prefix: "rea-python-" });
      this.roots.add(root);
      return root;
    } catch (cause) {
      if (cause instanceof PrivateRuntimeRootUnavailableError)
        throw new AnalysisCapabilityUnavailableError(
          "python",
          operation,
          cause.message,
          {
            cause,
            retryable: cause.retryable,
          },
        );
      throw new AnalysisResourceConstraintError(
        operation,
        "file-size",
        "Cannot allocate the owned request workspace",
        null,
        { cause },
      );
    }
  }

  /** Run one analysis over `inputRoot`; the request workspace is adopted before the run. */
  private async runHelper(
    operation: SourceOperation,
    inputRoot: string,
    body: (root: string) => object,
    flags: readonly string[],
    command: string,
    signal: AbortSignal | undefined,
    adopt: (workspace: PrivateRuntimeRoot) => void,
  ): Promise<unknown> {
    const root = await this.sourceRoot(operation, inputRoot);
    await this.prepareBound(operation);
    const workspace = await this.workspace(operation);
    adopt(workspace);
    const requestPath = join(workspace.path, "request.json");
    await writeFile(requestPath, JSON.stringify(body(root)), {
      mode: 0o400,
      flag: "wx",
    });
    const { stdout } = await this.run(
      operation,
      command,
      [...flags, HELPER, requestPath],
      { timeoutMs: 300_000, maxOutputBytes: 32 * 1024 ** 2 },
      signal,
      workspace,
      inputRoot,
    );
    try {
      return JSON.parse(stdout) as unknown;
    } catch (cause) {
      throw new AnalysisProtocolError(
        "The Python helper's report is not JSON",
        { cause },
      );
    }
  }

  private async executeAdmitted(
    request: PythonRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const signal = options?.signal;
    let owned: PrivateRuntimeRoot | undefined;
    let result: Result<AnalysisExecution, AnalysisError>;
    try {
      signal?.throwIfAborted();
      const client = await this.client(request.operation, signal);
      const provider = {
        ...PYTHON_PROVIDER_IDENTITY,
        version: client.python_version,
      };
      if (request.operation === "inspect_python_client")
        result = ok(
          createAnalysisExecution(
            pythonResultSchemas.inspect_python_client.parse({ client }),
            provider,
          ),
        );
      else {
        const run = (
          body: (root: string) => object,
          flags: readonly string[],
        ) =>
          this.runHelper(
            request.operation as SourceOperation,
            request.input.root,
            body,
            flags,
            client.python_command,
            signal,
            (workspace) => {
              owned = workspace;
            },
          );
        const subject = (sha256: string) => ({
          path: request.input.root,
          format: "directory" as const,
          sha256,
        });
        if (request.operation === "inspect_python_blocking_calls") {
          const input = request.input;
          const parsed = blockingReport.parse(
            await run((root) => blockingRequest(input, root), ISOLATION),
          );
          const { python: _python, ...report } = parsed;
          const data = pythonResultSchemas.inspect_python_blocking_calls.parse({
            client,
            root: input.root,
            ...report,
            truncated: parsed.findings.length < parsed.finding_count,
          });
          result = ok(
            createAnalysisExecution(data, provider, {
              subject: subject(parsed.files.sha256),
              limitations: [
                ...this.nativeLimitations,
                ...READ_LIMITATIONS,
                "Static reachability only: a callable reached through a variable, parameter, attribute assignment or dependency injection is invisible; a clean result means no path was found, not that none exists",
                "A function that calls a loop probe chooses its path at runtime and is not propagated",
                ...coverage(
                  parsed.files,
                  parsed.findings.length,
                  parsed.finding_count,
                ),
              ],
            }),
          );
        } else {
          const input = request.input;
          const parsed = driftReport.parse(
            await run(
              (root) => driftRequest(input, root),
              (input.config_mirrors ?? []).length > 0
                ? ISOLATION_WITH_SITE
                : ISOLATION,
            ),
          );
          const { python: _python, ...report } = parsed;
          const data = pythonResultSchemas.inspect_python_docs_drift.parse({
            client,
            root: input.root,
            ...report,
            truncated: parsed.findings.length < parsed.finding_count,
          });
          result = ok(
            createAnalysisExecution(data, provider, {
              subject: subject(parsed.files.sha256),
              limitations: [
                ...this.nativeLimitations,
                ...READ_LIMITATIONS,
                "Routes are FastAPI/Starlette-style decorators with literal or f-string paths and APIRouter(prefix=...); routes registered another way are not seen",
                "Frontend calls are literal paths passed to fetch/api-style helpers; a path built only at runtime is not checked",
                ...(parsed.config.status === "skipped" &&
                parsed.config.reason !== null
                  ? [
                      `Config mirrors were not compared: ${parsed.config.reason}`,
                    ]
                  : []),
                ...((input.config_mirrors ?? []).length > 0
                  ? [
                      "Comparing a YAML mirror runs the interpreter with its site-packages so PyYAML can load; the tree itself is still only parsed",
                    ]
                  : []),
                ...coverage(
                  parsed.files,
                  parsed.findings.length,
                  parsed.finding_count,
                ),
              ],
            }),
          );
        }
      }
    } catch (cause) {
      result = err(
        cause instanceof AnalysisError
          ? cause
          : signal?.aborted
            ? new AnalysisCancelledError(request.operation, { cause })
            : cause instanceof PythonConfigurationFailure
              ? pythonToolUnavailable(request.operation, cause.message, {
                  cause,
                })
              : new AnalysisProtocolError(
                  `Python source analysis failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                  { cause },
                ),
      );
    }
    if (signal?.aborted && result.ok)
      result = err(
        new AnalysisCancelledError(request.operation, { cause: signal.reason }),
      );
    if (owned !== undefined) {
      const pending = [...this.commands.values()].find((c) => c.root === owned);
      if (pending === undefined) {
        const cleanup = await this.discard(owned);
        if (cleanup !== undefined)
          result = err(
            result.ok
              ? cleanup
              : analysisErrorWithCleanupFailure(
                  result.error,
                  cleanup,
                  request.operation,
                ),
          );
      } else if (result.ok || !(result.error instanceof ProviderCleanupError))
        result = err(
          new ProviderCleanupError(
            "python",
            [...new Set([owned.path, ...pending.resources])],
            {
              reason: pending.reason,
              previous_error: result.ok
                ? null
                : projectAnalysisError(result.error),
            },
            { operation: request.operation },
          ),
        );
    }
    return result;
  }
}
