import { regularFileCancellation } from "./OwnedRegularFile.js";
import { createHash } from "node:crypto";
import { chmod, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { OwnedFileHandle } from "./OwnedFileHandle.js";
import {
  openRegularFile,
  RegularFileAdmissionFailure,
  sameRegularFileState,
} from "./RegularFile.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { PrivateRuntimeRootUnavailableError } from "../process/PrivateRuntimeRootUnavailableError.js";

/** Who owns a snapshot and how its refusals name the copied artifact. */
export interface OwnedFileSnapshotOwner {
  readonly provider: string;
  readonly operation: string;
  readonly prefix: string;
  /** Per-file disk budget for one copy. */
  readonly maxBytes: number;
  /** Capitalised artifact noun for acquisition refusals, e.g. "Capture". */
  readonly noun: string;
  /** Noun for the post-analysis identity check, e.g. "packet". */
  readonly analysedNoun: string;
}

export interface OwnedFileIdentity {
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Byte-identical copies of caller-selected regular files in one private root,
 * each read once through an admitted descriptor and rechecked after the tool
 * ran. Every descriptor stays owned until released, so cleanup can retry.
 */
export class OwnedFileSnapshot {
  private readonly handles = new Set<OwnedFileHandle>();
  private constructor(
    private readonly root: PrivateRuntimeRoot,
    private readonly owner: OwnedFileSnapshotOwner,
  ) {}

  static async create(
    owner: OwnedFileSnapshotOwner,
  ): Promise<OwnedFileSnapshot> {
    try {
      return new OwnedFileSnapshot(
        await PrivateRuntimeRoot.create({ prefix: owner.prefix }),
        owner,
      );
    } catch (cause) {
      if (cause instanceof PrivateRuntimeRootUnavailableError)
        throw new AnalysisCapabilityUnavailableError(
          owner.provider,
          owner.operation,
          cause.message,
          { cause, retryable: cause.retryable },
        );
      throw new AnalysisResourceConstraintError(
        owner.operation,
        "file-size",
        `Cannot allocate the owned ${owner.noun.toLowerCase()} workspace`,
        null,
        { cause },
      );
    }
  }

  /** Absolute path of one owned entry; the root itself is never handed out. */
  pathOf(name: string): string {
    return join(this.root.path, name);
  }

  private own(handle: OwnedFileHandle): OwnedFileHandle {
    this.handles.add(handle);
    return handle;
  }
  private async release(handle: OwnedFileHandle): Promise<void> {
    await handle.close();
    this.handles.delete(handle);
  }

  /** Copy `path` to the owned entry `name`, read-only once complete. */
  async copy(
    path: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<OwnedFileIdentity> {
    const { operation, noun } = this.owner;
    const target = this.pathOf(name);
    const sourceRead = async <T>(read: () => Promise<T>): Promise<T> => {
      try {
        return await read();
      } catch (cause) {
        const cancellation = regularFileCancellation(cause);
        if (cancellation !== undefined)
          throw new AnalysisCancelledError(operation, {
            cause: cancellation.reason,
          });
        if (signal?.aborted)
          throw new AnalysisCancelledError(operation, { cause });
        if (cause instanceof AnalysisError) throw cause;
        if (
          cause instanceof Error &&
          "code" in cause &&
          (cause.code === "EACCES" || cause.code === "EPERM")
        )
          throw new AnalysisAccessDeniedError(operation, path, cause.code, {
            cause,
          });
        throw new AnalysisInputError(operation, { cause }, [
          {
            path: ["path"],
            reason: "invalid_value",
            message: `Cannot read selected ${noun.toLowerCase()} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
          },
        ]);
      }
    };
    try {
      signal?.throwIfAborted();
      const source = await sourceRead(async () => {
        try {
          return this.own(
            new OwnedFileHandle(
              await openRegularFile(path, { symlinks: "follow", signal }),
            ),
          );
        } catch (cause) {
          if (cause instanceof RegularFileAdmissionFailure) {
            this.own(cause.owner);
            throw cause.cause;
          }
          throw cause;
        }
      });
      const before = await sourceRead(() =>
        source.handle.stat({ bigint: true }),
      );
      if (before.size > BigInt(this.owner.maxBytes))
        throw new AnalysisResourceConstraintError(
          operation,
          "file-size",
          `${noun} exceeds the owned-snapshot disk budget`,
          { [`max_${noun.toLowerCase()}_bytes`]: this.owner.maxBytes },
        );
      const destination = this.own(
        new OwnedFileHandle(await open(target, "wx", 0o600)),
      );
      const buffer = Buffer.alloc(64 * 1024);
      const hash = createHash("sha256");
      let copied = 0;
      while (copied <= Number(before.size)) {
        signal?.throwIfAborted();
        const { bytesRead } = await sourceRead(() =>
          source.handle.read(
            buffer,
            0,
            Math.min(buffer.length, Number(before.size) - copied + 1),
            copied,
          ),
        );
        signal?.throwIfAborted();
        if (bytesRead === 0) break;
        copied += bytesRead;
        if (BigInt(copied) > before.size)
          throw new AnalysisArtifactChangedError(
            operation,
            path,
            `${noun} grew during acquisition`,
          );
        const chunk = buffer.subarray(0, bytesRead);
        await destination.handle.writeFile(chunk);
        hash.update(chunk);
      }
      const after = await sourceRead(() =>
        source.handle.stat({ bigint: true }),
      );
      const selected = await stat(path, { bigint: true }).catch(
        (cause: unknown) => {
          if (
            cause instanceof Error &&
            "code" in cause &&
            (cause.code === "EACCES" || cause.code === "EPERM")
          )
            throw new AnalysisAccessDeniedError(operation, path, cause.code, {
              cause,
            });
          throw new AnalysisArtifactChangedError(
            operation,
            path,
            "Selected path became unavailable during acquisition",
            { cause },
          );
        },
      );
      if (
        BigInt(copied) !== before.size ||
        !sameRegularFileState(before, after) ||
        !sameRegularFileState(before, selected)
      )
        throw new AnalysisArtifactChangedError(
          operation,
          path,
          `${noun} identity or contents changed during acquisition`,
        );
      await this.release(source);
      await this.release(destination);
      await chmod(target, 0o400);
      signal?.throwIfAborted();
      return { bytes: copied, sha256: hash.digest("hex") };
    } catch (cause) {
      if (cause instanceof RegularFileAdmissionFailure) this.own(cause.owner);
      const primary =
        cause instanceof RegularFileAdmissionFailure ? cause.cause : cause;
      const cancellation = regularFileCancellation(primary);
      if (cancellation !== undefined)
        throw new AnalysisCancelledError(operation, {
          cause: cancellation.reason,
        });
      if (cause instanceof AnalysisError) throw cause;
      if (signal?.aborted)
        throw new AnalysisCancelledError(operation, { cause: signal.reason });
      throw new AnalysisResourceConstraintError(
        operation,
        "file-size",
        `Owned ${noun.toLowerCase()} snapshot I/O failed`,
        null,
        { cause },
      );
    }
  }

  /** Recheck byte identity after the tool ran; a read-only mode alone is not proof. */
  async verify(
    name: string,
    expected: OwnedFileIdentity,
    selectedPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const { operation, analysedNoun } = this.owner;
    const target = this.pathOf(name);
    try {
      const file = this.own(
        new OwnedFileHandle(
          await openRegularFile(target, { symlinks: "reject", signal }),
        ),
      );
      const before = await file.handle.stat({ bigint: true });
      const buffer = Buffer.alloc(64 * 1024);
      const hash = createHash("sha256");
      let bytes = 0;
      while (bytes <= expected.bytes) {
        signal?.throwIfAborted();
        const read = await file.handle.read(
          buffer,
          0,
          Math.min(buffer.length, expected.bytes - bytes + 1),
          bytes,
        );
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
        hash.update(buffer.subarray(0, read.bytesRead));
      }
      const after = await file.handle.stat({ bigint: true });
      const selected = await stat(target, { bigint: true });
      if (
        bytes !== expected.bytes ||
        hash.digest("hex") !== expected.sha256 ||
        !sameRegularFileState(before, after) ||
        !sameRegularFileState(before, selected)
      )
        throw new AnalysisArtifactChangedError(
          operation,
          selectedPath,
          `Owned ${analysedNoun} snapshot changed during tool analysis.`,
        );
      await this.release(file);
    } catch (cause) {
      if (cause instanceof RegularFileAdmissionFailure) this.own(cause.owner);
      const primary =
        cause instanceof RegularFileAdmissionFailure ? cause.cause : cause;
      const cancellation = regularFileCancellation(primary);
      if (cancellation !== undefined)
        throw new AnalysisCancelledError(operation, {
          cause: cancellation.reason,
        });
      if (cause instanceof AnalysisError) throw cause;
      if (signal?.aborted)
        throw new AnalysisCancelledError(operation, { cause: signal.reason });
      throw new AnalysisArtifactChangedError(
        operation,
        selectedPath,
        `Cannot establish the owned ${analysedNoun} snapshot's post-analysis identity.`,
        { cause },
      );
    }
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.handles].map((handle) => this.release(handle)),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        `${this.owner.noun} descriptor cleanup failed`,
      );
    await this.root.close();
  }
}
