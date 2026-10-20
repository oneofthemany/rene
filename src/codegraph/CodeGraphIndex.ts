import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  indexSourceGraphResultSchema,
  type IndexSourceGraphInput,
  type IndexSourceGraphResult,
} from "../domain/sourceGraph.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import {
  codeGraphEnvironment,
  type CodeGraphInstall,
} from "./CodeGraphConfiguration.js";
import { RESULT_MARKER } from "./CodeGraphIndexWorker.js";

const WORKER = fileURLToPath(
  new URL("./CodeGraphIndexWorker.js", import.meta.url),
);
const STDERR_BYTES = 64 * 1024;
const MAX_RESULT_LINE = 1024 * 1024;

/** Keeps the worker's result line from stdout and drops everything else. */
class ResultLineSink extends Writable {
  #pending = "";
  result: string | undefined;

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#pending += chunk.toString();
    const lines = this.#pending.split("\n");
    this.#pending = lines.pop() ?? "";
    // A long line that isn't the result can't grow without bound.
    if (
      this.#pending.length > MAX_RESULT_LINE &&
      !this.#pending.startsWith(RESULT_MARKER)
    )
      this.#pending = "";
    for (const line of lines)
      if (line.startsWith(RESULT_MARKER))
        this.result = line.slice(RESULT_MARKER.length);
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.#pending.startsWith(RESULT_MARKER))
      this.result = this.#pending.slice(RESULT_MARKER.length);
    callback();
  }
}

/**
 * Builds or syncs one project's index in an owned worker process running the
 * selected CodeGraph library: the only writer of the index. Query servers are
 * read-only and may keep running through a sync; a build replaces the
 * database, so the caller stops its own server first.
 */
export const indexCodeGraphProject = async (
  install: CodeGraphInstall,
  root: string,
  input: IndexSourceGraphInput,
  options: {
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal | undefined;
    readonly retain: (owner: ProviderProcessSupervisor) => void;
  },
): Promise<IndexSourceGraphResult> => {
  const sink = new ResultLineSink();
  const failure = (reason: string, stderr: string, cause?: unknown) =>
    new ProviderAdapterError("codegraph", "index_source_graph", {
      cause,
      userMessage: `CodeGraph couldn't ${input.mode === "build" ? "build" : "sync"} the index of ${root}: ${reason}`,
      diagnostics: { project_path: root, mode: input.mode, stderr },
    });
  let snapshot;
  try {
    snapshot = await runOwnedCommand(
      {
        command: process.execPath,
        arguments: [WORKER, install.library, root, input.mode],
        runId: randomUUID(),
        cwd: root,
        hostEnvironment: codeGraphEnvironment(options.environment),
      },
      {
        timeoutMs: input.timeout_ms,
        diagnosticBytes: STDERR_BYTES,
        acceptNonZeroExit: true,
        stdout: sink,
      },
      {
        signal: options.signal,
        retainCleanup: (owner) => options.retain(owner),
      },
    );
  } catch (cause: unknown) {
    if (cause instanceof OwnedCommandFailure) {
      if (cause.cleanupOwner !== undefined) options.retain(cause.cleanupOwner);
      if (cause.reason === "cancelled") throw cause;
      throw failure(
        cause.reason === "timeout"
          ? `it was stopped after ${input.timeout_ms} ms.`
          : cause.message,
        cause.snapshot?.stderr.text ?? "",
        cause,
      );
    }
    throw cause;
  }
  const stderr = snapshot?.stderr.text ?? "";
  if (snapshot?.exitCode !== 0 || sink.result === undefined)
    throw failure(
      stderr.trim().split("\n").at(-1) ||
        `the indexer exited with status ${snapshot?.exitCode ?? "unknown"}.`,
      stderr,
    );
  let reported: unknown;
  try {
    reported = JSON.parse(sink.result);
  } catch (cause: unknown) {
    throw failure("its result line wasn't JSON.", stderr, cause);
  }
  return indexSourceGraphResultSchema.parse({
    ...(reported as object),
    project_path: root,
    mode: input.mode,
    codegraph_version: install.version,
  });
};
