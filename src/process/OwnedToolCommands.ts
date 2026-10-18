import type { AnalysisExecution } from "../application/AnalysisProvider.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type {
  AnalysisError,
  AnalysisPartialObservation,
} from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, type Result } from "../domain/result.js";
import type { ArtifactAnalysisResources } from "./ArtifactAnalysisResources.js";
import {
  runBoundedToolCommand,
  type BoundedToolCommandCleanup,
  type BoundedToolCommandOutput,
} from "./BoundedToolCommand.js";
import type { ProviderProcessSupervisor } from "./ProviderProcess.js";

/** A private directory or copy that owned commands read; closing removes it. */
export interface OwnedWorkspace {
  readonly path: string;
  close(): Promise<void>;
}

interface RetainedCommand<W extends OwnedWorkspace> {
  readonly workspace: W | undefined;
  readonly resources: readonly string[];
  readonly reason: string;
  readonly capturedOutput: BoundedToolCommandCleanup["capturedOutput"];
  ownerReleased: boolean;
  failure: ProviderCleanupError | undefined;
}

/**
 * One provider's caller-supplied tool processes and the workspaces they read.
 *
 * A command whose process-tree cleanup was not confirmed stays retained, with
 * its workspace, until close() stops it; a workspace is only removed once no
 * unreleased command still owns it. settle() folds those outcomes into the
 * operation's result so a success never hides unconfirmed cleanup.
 */
export class OwnedToolCommands<W extends OwnedWorkspace> {
  private readonly workspaces = new Set<W>();
  private readonly workspaceFailures = new Map<W, AnalysisError>();
  private readonly commands = new Map<
    ProviderProcessSupervisor,
    RetainedCommand<W>
  >();

  constructor(
    private readonly provider: string,
    /** The operation that owns workspaces, named when one cannot be removed. */
    private readonly operation: string,
    private readonly resources: ArtifactAnalysisResources,
    /** Names a workspace in refusals, e.g. "capture snapshot". */
    private readonly noun: string,
  ) {}

  adopt(workspace: W): W {
    this.workspaces.add(workspace);
    return workspace;
  }

  /** Run one bounded command; an unconfirmed cleanup is retained and reported in `cleanup`. */
  async run(
    options: Omit<Parameters<typeof runBoundedToolCommand>[0], "retain">,
    workspace?: W,
  ): Promise<
    BoundedToolCommandOutput & { readonly retained?: RetainedCommand<W> }
  > {
    let retained: RetainedCommand<W> | undefined;
    const output = await runBoundedToolCommand({
      ...options,
      retain: (owner, resources, reason, capturedOutput) => {
        retained = {
          workspace,
          resources,
          reason,
          capturedOutput,
          ownerReleased: false,
          failure: undefined,
        };
        this.commands.set(owner, retained);
      },
    });
    return retained === undefined ? output : { ...output, retained };
  }

  /** The cleanup refusal for a command that finished but left its tree unconfirmed. */
  cleanupError(
    operation: string,
    workspace: W | undefined,
    output: BoundedToolCommandOutput & {
      readonly cleanup: BoundedToolCommandCleanup;
    },
    partialObservation?: AnalysisPartialObservation,
  ): ProviderCleanupError {
    const { cleanup } = output;
    return new ProviderCleanupError(
      this.provider,
      [
        ...new Set([
          ...(workspace === undefined ? [] : [workspace.path]),
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
      {
        operation,
        ...(partialObservation === undefined ? {} : { partialObservation }),
      },
    );
  }

  /** Run, and refuse the output when its cleanup was not confirmed. */
  async runClean(
    options: Omit<Parameters<typeof runBoundedToolCommand>[0], "retain">,
    workspace?: W,
  ): Promise<BoundedToolCommandOutput> {
    const output = await this.run(options, workspace);
    if (output.cleanup === undefined) return output;
    const failure = this.cleanupError(options.operation, workspace, {
      ...output,
      cleanup: output.cleanup,
    });
    if (output.retained !== undefined) output.retained.failure = failure;
    throw failure;
  }

  private async discard(workspace: W): Promise<AnalysisError | undefined> {
    try {
      if (
        [...this.commands.values()].some(
          (command) =>
            command.workspace === workspace && !command.ownerReleased,
        )
      )
        throw new Error(`An unreleased command still owns the ${this.noun}`);
      await workspace.close();
      this.workspaces.delete(workspace);
      this.workspaceFailures.get(workspace)?.resolveCleanup();
      this.workspaceFailures.delete(workspace);
      return undefined;
    } catch (cause) {
      return new ProviderCleanupError(
        this.provider,
        [workspace.path],
        { reason: String(cause) },
        { operation: this.operation, cause },
      );
    }
  }

  /**
   * Fold workspace and retained-command cleanup into an operation's result.
   * `partial` turns a success into the observation a cleanup refusal keeps.
   */
  async settle(settlement: {
    readonly operation: string;
    readonly result: Result<AnalysisExecution, AnalysisError>;
    readonly workspace: W | undefined;
    readonly signal: AbortSignal | undefined;
    readonly partial?: (
      execution: AnalysisExecution,
    ) => AnalysisPartialObservation;
  }): Promise<Result<AnalysisExecution, AnalysisError>> {
    const { operation, workspace, signal, partial } = settlement;
    const cancelled = (value: AnalysisExecution) =>
      err(
        new AnalysisCancelledError(operation, {
          cause: signal?.reason,
          ...(partial === undefined
            ? {}
            : { partialObservation: partial(value) }),
        }),
      );
    let result =
      signal?.aborted === true && settlement.result.ok
        ? cancelled(settlement.result.value)
        : settlement.result;
    if (workspace === undefined) return result;
    const pending = [...this.commands.values()].find(
      (c) => c.workspace === workspace,
    );
    if (pending === undefined) {
      const cleanup = await this.discard(workspace);
      if (signal?.aborted === true && result.ok)
        result = cancelled(result.value);
      if (cleanup !== undefined)
        result = this.withCleanup(operation, result, cleanup, partial);
    } else if (result.ok || !(result.error instanceof ProviderCleanupError))
      result = err(
        this.stillOwned(operation, result, { workspace, pending }, partial),
      );
    if (
      this.workspaces.has(workspace) &&
      !result.ok &&
      result.error.cleanupIncomplete
    )
      this.workspaceFailures.set(workspace, result.error);
    return result;
  }

  /** A workspace that would not close: the refusal keeps what was observed. */
  private withCleanup(
    operation: string,
    result: Result<AnalysisExecution, AnalysisError>,
    cleanup: AnalysisError,
    partial:
      | ((execution: AnalysisExecution) => AnalysisPartialObservation)
      | undefined,
  ): Result<AnalysisExecution, AnalysisError> {
    if (!result.ok)
      return err(
        analysisErrorWithCleanupFailure(result.error, cleanup, operation),
      );
    return err(
      partial === undefined
        ? cleanup
        : cleanup.retainPartialObservation(partial(result.value)),
    );
  }

  /** A command still owns the workspace: refuse, keeping the previous outcome. */
  private stillOwned(
    operation: string,
    result: Result<AnalysisExecution, AnalysisError>,
    { workspace, pending }: { workspace: W; pending: RetainedCommand<W> },
    partial:
      | ((execution: AnalysisExecution) => AnalysisPartialObservation)
      | undefined,
  ): ProviderCleanupError {
    const partialObservation = result.ok
      ? partial?.(result.value)
      : result.error.partialObservation;
    const capturedOutput = result.ok ? undefined : result.error.capturedOutput;
    const quiet =
      capturedOutput === undefined &&
      pending.capturedOutput.stdout === "" &&
      pending.capturedOutput.stderr === "";
    return new ProviderCleanupError(
      this.provider,
      [...new Set([workspace.path, ...pending.resources])],
      {
        reason: pending.reason,
        previous_error: result.ok ? null : projectAnalysisError(result.error),
        ...(quiet
          ? {}
          : {
              captured_output: {
                ...(capturedOutput ?? pending.capturedOutput),
              },
            }),
      },
      {
        operation,
        ...(partialObservation === undefined ? {} : { partialObservation }),
      },
    );
  }

  /** Stop retained commands, then remove the workspaces they released. */
  async close(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.resources.close();
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
          if (command.workspace === undefined) {
            command.failure?.resolveCleanup();
            this.commands.delete(owner);
          }
        }
      } catch (cause) {
        failures.push(cause);
      }
    }
    for (const workspace of this.workspaces) {
      const failure = await this.discard(workspace);
      if (failure !== undefined) failures.push(failure);
      else
        for (const [owner, command] of this.commands)
          if (command.workspace === workspace) this.commands.delete(owner);
    }
    if (failures.length > 0)
      throw new ProviderCleanupError(
        this.provider,
        [...this.workspaces]
          .map((workspace) => workspace.path)
          .concat(
            [...this.commands.values()].flatMap((command) => command.resources),
          ),
        { reason: "Owned process or snapshot cleanup failed" },
        {
          operation: `${this.provider}.close`,
          cause: new AggregateError(failures),
        },
      );
  }
}
