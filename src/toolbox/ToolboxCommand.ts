import { randomUUID } from "node:crypto";

import {
  MAX_COMMAND_OUTPUT_BYTES,
  type RunCommandInput,
} from "../domain/toolbox.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type {
  ProviderProcessSnapshot,
  ProviderProcessSupervisor,
} from "../process/ProviderProcess.js";
import { confine } from "./ToolboxFiles.js";

const outcome = (
  snapshot: ProviderProcessSnapshot | null,
): {
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  output_truncated: boolean;
} => ({
  exit_code: snapshot?.exitCode ?? null,
  signal: snapshot?.signal ?? null,
  stdout: snapshot?.stdout.text ?? "",
  stderr: snapshot?.stderr.text ?? "",
  output_truncated:
    snapshot === null ||
    snapshot.diagnosticTruncated === true ||
    snapshot.outputIncomplete === true,
});

/**
 * Runs one shell command line with bash -c in a toolbox folder, as an owned
 * process group: a timeout or cancellation stops the command and everything
 * it started, and a nonzero exit is a result, not a failure. A process REA
 * couldn't clean up is handed to `retain`, which keeps it for a later retry.
 */
export const runToolboxCommand = async (
  roots: readonly string[],
  input: RunCommandInput,
  options: {
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal | undefined;
    readonly retain: (owner: ProviderProcessSupervisor) => void;
  },
) => {
  const cwd = await confine(roots, input.cwd, "cwd");
  const startedAt = performance.now();
  const duration = () => Math.round(performance.now() - startedAt);
  try {
    const snapshot = await runOwnedCommand(
      {
        command: "/bin/bash",
        arguments: ["-c", input.command],
        runId: randomUUID(),
        expectedCommand: null,
        cwd,
        hostEnvironment: {
          ...options.environment,
          ...input.environment,
        } as NodeJS.ProcessEnv,
      },
      {
        timeoutMs: input.timeout_ms,
        diagnosticBytes: MAX_COMMAND_OUTPUT_BYTES,
        acceptNonZeroExit: true,
      },
      {
        signal: options.signal,
        retainCleanup: (owner) => options.retain(owner),
      },
    );
    return {
      command: input.command,
      cwd,
      ...outcome(snapshot),
      stopped: null,
      duration_ms: duration(),
    };
  } catch (cause: unknown) {
    if (!(cause instanceof OwnedCommandFailure)) throw cause;
    // A command ended by a signal (e.g. one that kills its own process group)
    // finished like a nonzero exit: its output and signal are the result.
    const signalled =
      cause.reason === "process" &&
      !cause.collectionFailure &&
      cause.snapshot !== null &&
      cause.snapshot.signal !== null;
    if (cause.reason === "process" && !signalled) throw cause;
    if (cause.cleanupOwner !== undefined) options.retain(cause.cleanupOwner);
    return {
      command: input.command,
      cwd,
      ...outcome(cause.snapshot),
      stopped: signalled ? null : cause.reason,
      duration_ms: duration(),
    };
  }
};
