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
import { err, ok, type Result } from "../domain/result.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type {
  BoundedToolCommandLauncher,
  BoundedToolFailures,
  BoundedToolNativeBound,
} from "../process/BoundedToolCommand.js";
import { prepareNativeToolBound } from "../process/NativeToolBound.js";
import { ArtifactAnalysisResources } from "../process/ArtifactAnalysisResources.js";
import { OwnedToolCommands } from "../process/OwnedToolCommands.js";
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
  readonly #commands = new OwnedToolCommands<PrivateRuntimeRoot>(
    "python",
    OPERATION,
    this.#resources,
    "request workspace",
  );
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly launcher: BoundedToolCommandLauncher | undefined;
  private nativeBound: BoundedToolNativeBound | undefined;
  private nativeLimitations: readonly string[] = [];

  constructor(options: PythonSourceProviderOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.launcher = options.launcher;
  }

  private run(
    operation: PythonOperation,
    command: string,
    args: readonly string[],
    limits: { timeoutMs: number; maxOutputBytes: number },
    signal: AbortSignal | undefined,
    owned?: PrivateRuntimeRoot,
    inputPath?: string,
  ) {
    return this.#commands.runClean(
      {
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
      },
      owned,
    );
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

  close(): Promise<void> {
    return this.#commands.close();
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
      return this.#commands.adopt(
        await PrivateRuntimeRoot.create({ prefix: "rea-python-" }),
      );
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
    return this.#commands.settle({
      operation: request.operation,
      result,
      workspace: owned,
      signal,
    });
  }
}
