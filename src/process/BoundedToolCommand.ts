import { randomUUID } from "node:crypto";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  OwnedCommandFailure,
  ownedCommandResources,
  runOwnedCommand,
} from "./OwnedCommand.js";
import type { ProviderProcessSupervisor } from "./ProviderProcess.js";
import { prepareProcessOwnershipInspection } from "./ProcessOwnershipObservation.js";
import {
  isWindowsBatchFile,
  windowsBatchCommand,
  WindowsBatchCommandError,
} from "./WindowsBatchCommand.js";

export type BoundedToolCommandLauncher = NonNullable<
  Parameters<typeof runOwnedCommand>[2]
>["launcher"];

export interface BoundedToolCommandCleanup {
  readonly reason: string;
  readonly resources: readonly string[];
  readonly capturedOutput: {
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated: boolean;
  };
}

export interface BoundedToolCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly cleanup?: BoundedToolCommandCleanup;
}

export interface BoundedToolCommandLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/** How one caller-supplied tool's failures are named for the analyst. */
export interface BoundedToolFailures {
  /** The selected executable cannot run, or cannot report its version. */
  readonly toolUnavailable: (
    operation: string,
    reason: string,
    options: AnalysisErrorOptions,
  ) => AnalysisError;
  /** Prefix of a protocol failure, e.g. "Packet capture tool". */
  readonly label: string;
  /** A diagnostic that means the input is not this tool's format. */
  readonly unsupportedInput?: RegExp;
}

export interface BoundedToolNativeBound {
  readonly limiter?: { command: string; arguments: readonly string[] };
  readonly memoryLimitBytes?: number;
}

/** Owned process execution for one caller-supplied analysis tool. */
export const runBoundedToolCommand = async (options: {
  readonly operation: string;
  readonly command: string;
  readonly arguments: readonly string[];
  readonly limits: BoundedToolCommandLimits;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal | undefined;
  readonly failures: BoundedToolFailures;
  readonly inputPath?: string;
  readonly nativeBound?: BoundedToolNativeBound;
  readonly launcher?: BoundedToolCommandLauncher;
  readonly retain: (
    owner: ProviderProcessSupervisor,
    resources: readonly string[],
    reason: string,
    capturedOutput: BoundedToolCommandCleanup["capturedOutput"],
  ) => void;
}): Promise<BoundedToolCommandOutput> => {
  const { operation, command, limits, signal, failures } = options;
  if (signal?.aborted)
    throw new AnalysisCancelledError(operation, { cause: signal.reason });
  const hostEnvironment = {
    ...process.env,
    ...options.environment,
    LC_ALL: "C",
    LANG: "C",
  };
  let cleanup: BoundedToolCommandCleanup | undefined;
  try {
    const batch = process.platform === "win32" && isWindowsBatchFile(command);
    const invocation = batch
      ? windowsBatchCommand({
          environment: hostEnvironment,
          batchPath: command,
          arguments: options.arguments,
        })
      : { command, arguments: options.arguments };
    const boundedInvocation =
      options.nativeBound?.limiter === undefined
        ? invocation
        : {
            command: options.nativeBound.limiter.command,
            arguments: [
              ...options.nativeBound.limiter.arguments,
              invocation.command,
              ...invocation.arguments,
            ],
          };
    // Native ownership preparation has its own bounded compiler lifecycle;
    // do not spend the tool's execution deadline rebuilding a cold SDK cache.
    await prepareProcessOwnershipInspection(signal);
    const output = await runOwnedCommand(
      {
        ...boundedInvocation,
        runId: randomUUID(),
        hostEnvironment,
        windowsVerbatimArguments: batch,
        expectedCommand: null,
        ...(options.nativeBound?.memoryLimitBytes === undefined
          ? {}
          : { memoryLimitBytes: options.nativeBound.memoryLimitBytes }),
      },
      { timeoutMs: limits.timeoutMs, diagnosticBytes: limits.maxOutputBytes },
      {
        ...(signal === undefined ? {} : { signal }),
        ...(options.launcher === undefined
          ? {}
          : { launcher: options.launcher }),
        retainCleanup: (owner, stopped) => {
          const resources =
            owner.launch.ownership === undefined
              ? ["owned-process"]
              : ownedCommandResources(owner.launch.ownership);
          const snapshot = owner.snapshot();
          const capturedOutput = {
            stdout: snapshot.stdout.text,
            stderr: snapshot.stderr.text,
            truncated:
              snapshot.diagnosticTruncated === true ||
              snapshot.outputIncomplete === true,
          };
          options.retain(owner, resources, stopped.reason, capturedOutput);
          cleanup = { reason: stopped.reason, resources, capturedOutput };
        },
      },
    );
    return {
      stdout: output.stdout.text,
      stderr: output.stderr.text,
      ...(cleanup === undefined ? {} : { cleanup }),
    };
  } catch (cause) {
    if (cause instanceof AnalysisError) throw cause;
    if (
      cause instanceof OwnedCommandFailure &&
      cause.cleanupOwner !== undefined
    )
      options.retain(
        cause.cleanupOwner,
        cause.resources,
        cause.cleanupFailure ?? cause.message,
        cause.snapshot === null
          ? { stdout: "", stderr: "", truncated: true }
          : {
              stdout: cause.snapshot.stdout.text,
              stderr: cause.snapshot.stderr.text,
              truncated:
                cause.snapshot.diagnosticTruncated === true ||
                cause.snapshot.outputIncomplete === true,
            },
      );
    const details = {
      cause,
      ...(cause instanceof OwnedCommandFailure && cause.snapshot !== null
        ? {
            capturedOutput: {
              stdout: cause.snapshot.stdout.text,
              stderr: cause.snapshot.stderr.text,
              truncated:
                cause.snapshot.diagnosticTruncated === true ||
                cause.snapshot.outputIncomplete === true,
              exit_code: cause.snapshot.exitCode ?? null,
              signal: cause.snapshot.signal ?? null,
            },
          }
        : {}),
      ...(cause instanceof OwnedCommandFailure && cause.cleanupFailure !== null
        ? {
            cleanup: {
              reason: cause.cleanupFailure,
              resources: cause.resources,
            },
          }
        : {}),
    };
    if (
      signal?.aborted ||
      (cause instanceof OwnedCommandFailure && cause.reason === "cancelled")
    )
      throw new AnalysisCancelledError(operation, details);
    if (
      cause instanceof OwnedCommandFailure &&
      cause.snapshot?.memoryLimitReached === true
    )
      throw new AnalysisResourceConstraintError(
        operation,
        "memory",
        "The owned Windows tool tree reached its enforced committed-memory limit.",
        {
          process_memory_limit_bytes:
            options.nativeBound?.memoryLimitBytes ?? null,
        },
        details,
      );
    if (
      cause instanceof OwnedCommandFailure &&
      (cause.snapshot?.signal === "SIGXCPU" ||
        cause.snapshot?.signal === "SIGXFSZ")
    )
      throw new AnalysisResourceConstraintError(
        operation,
        cause.snapshot.signal === "SIGXCPU" ? "cpu" : "file-size",
        `Producer terminated with ${cause.snapshot.signal}; its exact cause is not independently established.`,
        null,
        details,
      );
    if (cause instanceof OwnedCommandFailure && cause.reason === "timeout")
      throw new AnalysisTimeoutError(operation, limits.timeoutMs, details);
    if (cause instanceof OwnedCommandFailure && cause.reason === "output-limit")
      throw new AnalysisResourceConstraintError(
        operation,
        "memory",
        "Tool output exceeded its complete-output budget",
        { max_output_bytes: limits.maxOutputBytes },
        details,
      );
    if (
      cause instanceof WindowsBatchCommandError ||
      (cause instanceof Error &&
        "code" in cause &&
        (cause.code === "ENOENT" || cause.code === "EACCES"))
    )
      throw failures.toolUnavailable(
        operation,
        `Cannot run selected tool ${command}: ${cause.message}`,
        details,
      );
    const diagnostic =
      cause instanceof OwnedCommandFailure
        ? cause.snapshot?.stderr.text.trim() || cause.message
        : cause instanceof Error
          ? cause.message
          : String(cause);
    if (options.inputPath === undefined)
      throw failures.toolUnavailable(
        operation,
        `The selected tool ${command} cannot report its version: ${diagnostic}`,
        details,
      );
    if (failures.unsupportedInput?.test(diagnostic) === true)
      throw new AnalysisUnsupportedTargetError(
        operation,
        options.inputPath,
        diagnostic,
        details,
      );
    throw new AnalysisProtocolError(
      `${failures.label} ${command} failed: ${diagnostic}`,
      details,
    );
  }
};
