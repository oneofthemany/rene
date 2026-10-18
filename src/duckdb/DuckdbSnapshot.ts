import { lstat, mkdir, writeFile } from "node:fs/promises";
import {
  AnalysisArtifactChangedError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import {
  OwnedFileSnapshot,
  type OwnedFileIdentity,
} from "../filesystem/OwnedFileSnapshot.js";

const OPERATION = "inspect_duckdb_database";
const MAX_DATABASE_BYTES = 4 * 1024 ** 3;
// DuckDB finds the WAL by appending ".wal" to the database path it opens.
const DATABASE = "database.duckdb";
const WAL = `${DATABASE}.wal`;

export interface DuckdbSnapshotIdentity {
  readonly database: OwnedFileIdentity;
  readonly wal: OwnedFileIdentity | null;
}

const walState = async (path: string) => {
  try {
    const found = await lstat(path, { bigint: true });
    return {
      present: true,
      ino: found.ino,
      size: found.size,
      mtime: found.mtimeNs,
    };
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return { present: false } as const;
    throw cause;
  }
};

/** An owned copy of one database and its WAL, plus the CLI's private HOME. */
export class DuckdbSnapshot {
  readonly path: string;
  readonly homePath: string;
  readonly initPath: string;
  private constructor(private readonly files: OwnedFileSnapshot) {
    this.path = files.pathOf(DATABASE);
    this.homePath = files.pathOf("home");
    this.initPath = files.pathOf("duckdbrc");
  }

  static async create(): Promise<DuckdbSnapshot> {
    return new DuckdbSnapshot(
      await OwnedFileSnapshot.create({
        provider: "duckdb",
        operation: OPERATION,
        prefix: "rea-duckdb-",
        maxBytes: MAX_DATABASE_BYTES,
        noun: "Database",
        analysedNoun: "database",
      }),
    );
  }

  /** Copy `path` and, when present, `path.wal`; refuse if the WAL came or went. */
  async capture(
    path: string,
    signal?: AbortSignal,
  ): Promise<DuckdbSnapshotIdentity> {
    signal?.throwIfAborted();
    // An empty HOME and init file: no ~/.duckdbrc, no cached extensions.
    await Promise.all([
      mkdir(this.homePath, { mode: 0o700 }),
      writeFile(this.initPath, "", { mode: 0o400 }),
    ]).catch((cause: unknown) => {
      throw new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        "Owned database snapshot I/O failed",
        null,
        { cause },
      );
    });
    const walPath = `${path}.wal`;
    const before = await walState(walPath);
    const database = await this.files.copy(path, DATABASE, signal);
    const wal = before.present
      ? await this.files.copy(walPath, WAL, signal)
      : null;
    const after = await walState(walPath);
    if (
      before.present !== after.present ||
      (before.present &&
        after.present &&
        (before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtime !== after.mtime))
    )
      throw new AnalysisArtifactChangedError(
        OPERATION,
        path,
        "The database's WAL appeared, disappeared or changed during acquisition; supply a quiescent snapshot",
      );
    return { database, wal };
  }

  /** Recheck both copies: a read-only open must not have checkpointed or truncated. */
  async verify(
    expected: DuckdbSnapshotIdentity,
    selectedPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.files.verify(DATABASE, expected.database, selectedPath, signal);
    if (expected.wal !== null)
      await this.files.verify(WAL, expected.wal, `${selectedPath}.wal`, signal);
  }

  close(): Promise<void> {
    return this.files.close();
  }
}
