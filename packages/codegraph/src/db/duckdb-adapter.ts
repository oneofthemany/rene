/**
 * DuckDB Adapter
 *
 * The same small better-sqlite3-shaped interface as sqlite-adapter.ts, over
 * codegraph-store (packages/codegraph-store): an in-memory DuckDB per index,
 * shared by the process's threads, with a write-ahead log on disk that every
 * commit reaches before it returns, sealed generations, and readers that
 * follow the log. Selected with CODEGRAPH_STORAGE=duckdb.
 *
 * SQL passes through unchanged: CodeGraph's statements are written for
 * DuckDB (packages/codegraph-store/DESIGN.md, Native DuckDB SQL). The adapter
 * only binds parameters: `@name` (with an object) and `?` become positional.
 */

import * as fs from 'fs';
import * as path from 'path';
import { threadId } from 'worker_threads';
import type { SqliteDatabase, SqliteStatement } from './sqlite-adapter';

/**
 * CODEGRAPH_STORE_PROFILE=<dir>: each thread's time in the store per
 * statement (calls, milliseconds, rows), written to <dir> as the thread
 * exits; a diagnostic for finding the statements indexing spends its time on.
 */
const profile = process.env.CODEGRAPH_STORE_PROFILE
  ? (() => {
      const dir = process.env.CODEGRAPH_STORE_PROFILE!;
      const spent = new Map<string, { calls: number; ms: number; rows: number }>();
      process.on('exit', () => {
        const sorted = [...spent].sort((a, b) => b[1].ms - a[1].ms).map(([sql, s]) => ({ ...s, sql }));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `store-${process.pid}-${threadId}.json`), JSON.stringify(sorted, null, 1));
      });
      return <T>(sql: string, work: () => T, count: (result: T) => number): T => {
        const started = performance.now();
        const result = work();
        const entry = spent.get(sql) ?? { calls: 0, ms: 0, rows: 0 };
        entry.calls += 1;
        entry.ms += performance.now() - started;
        entry.rows += count(result);
        spent.set(sql, entry);
        return result;
      };
    })()
  : undefined;

interface NativeStore {
  exec(sql: string): void;
  run(sql: string, parameters: string): number;
  query(sql: string, parameters: string): string;
  append(table: string, rows: string): number;
  seal(directory: string): number;
  load(directory: string): number;
  logTo(directory: string): void;
  follow(directory: string): void;
  logBytes(): number;
  setLogging(enabled: boolean): void;
}
interface NativeModule {
  Store: { shared(name: string): NativeStore; releaseShared(name: string): boolean };
  sealedGeneration(directory: string): number;
}

let nativeModule: NativeModule | undefined;
/** The addon, built by packages/codegraph-store (CODEGRAPH_STORE_ADDON overrides where). */
function native(): NativeModule {
  if (nativeModule) return nativeModule;
  const addon =
    process.env.CODEGRAPH_STORE_ADDON ??
    path.resolve(__dirname, '../../../codegraph-store/dist/codegraph_store.node');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  nativeModule = require(addon) as NativeModule;
  return nativeModule;
}

/** Where an index's sealed generations and log live: beside the SQLite file's name. */
export function duckdbStoreDirectory(dbPath: string): string {
  return `${dbPath}.store`;
}

/**
 * Whether an index exists: sealed at least once, or begun (its writer opens
 * the first generation's log as soon as the index is initialized).
 */
export function duckdbIndexExists(dbPath: string): boolean {
  const store = duckdbStoreDirectory(dbPath);
  return fs.existsSync(path.join(store, 'manifest.json')) || fs.existsSync(path.join(store, 'wal-g00000000.log'));
}

/** `@name`, `:name` and `$name` parameters as positional `?`, with the names in order. */
export function positionalParameters(sql: string): { sql: string; names: string[] } {
  const names: string[] = [];
  let out = '';
  let quote: string | undefined;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      out += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    // `$` also starts DuckDB's JSON paths inside strings, which the quote
    // tracking above keeps out of this branch.
    const named = /^[@:$]([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
    if (named && !/[A-Za-z0-9_:]/.test(sql[i - 1] ?? ' ')) {
      names.push(named[1]!);
      out += '?';
      i += named[0].length - 1;
      continue;
    }
    out += ch;
  }
  return { sql: out, names };
}

const toParam = (value: unknown): unknown =>
  typeof value === 'bigint' ? Number(value) : typeof value === 'boolean' ? (value ? 1 : 0) : value === undefined ? null : value;

class DuckdbAdapter implements SqliteDatabase {
  private readonly store: NativeStore;
  private txDepth = 0;
  private closed = false;
  /** Whether this connection started the index's log: the writer, which seals. */
  private logging = false;
  private readonly bindings = new Map<string, { sql: string; names: string[] }>();

  constructor(private readonly dbPath: string, private readonly readOnly: boolean) {
    this.store = native().Store.shared(path.resolve(dbPath));
  }

  get open(): boolean {
    return !this.closed;
  }

  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  /**
   * Loads the newest sealed generation and its log into this process's
   * database. A reader then follows the log: before each query it applies
   * the writer's newly committed changes, or reloads after a seal.
   */
  loadSealed(): number {
    const directory = duckdbStoreDirectory(this.dbPath);
    const generation = this.store.load(directory);
    if (this.readOnly) this.store.follow(directory);
    return generation;
  }

  /**
   * Starts the index's write-ahead log: from now on every committed write,
   * from this connection or another thread's, is on disk before its commit
   * returns. The writer calls it once the index is loaded.
   */
  startLog(): void {
    if (this.readOnly) throw new Error('A read-only index connection cannot log writes.');
    this.store.logTo(duckdbStoreDirectory(this.dbPath));
    this.logging = true;
  }

  /**
   * Turns this connection's logging off for writes to its own TEMP objects
   * (a synthesis stage), which a replay elsewhere couldn't reproduce, and on
   * again for durable, self-contained writes.
   */
  setLogging(enabled: boolean): void {
    this.store.setLogging(enabled);
  }

  /** Seals the working index as a new generation, compacting the log into it. */
  seal(): number {
    if (this.readOnly) throw new Error('A read-only index connection cannot seal.');
    return this.store.seal(duckdbStoreDirectory(this.dbPath));
  }

  /**
   * After a commit, the writer seals once the log passes its limit
   * (CODEGRAPH_STORE_SEAL_BYTES, default 64 MiB): it bounds how much a
   * recovery replays. Durability doesn't depend on it.
   */
  private sealIfLogFull(): void {
    if (!this.logging || this.txDepth > 0) return;
    const limit = Number(process.env.CODEGRAPH_STORE_SEAL_BYTES ?? 64 * 1024 * 1024);
    if (Number.isFinite(limit) && limit > 0 && this.store.logBytes() > limit) this.seal();
  }

  private bound(sql: string): { sql: string; names: string[] } {
    let entry = this.bindings.get(sql);
    if (!entry) {
      entry = positionalParameters(sql);
      this.bindings.set(sql, entry);
    }
    return entry;
  }

  private bind(names: string[], params: any[]): string {
    // A single plain object binds named parameters, as better-sqlite3 does.
    const named = params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !Array.isArray(params[0]);
    const values = named ? names.map((name) => (params[0] as Record<string, unknown>)[name]) : params.flat();
    return JSON.stringify(values.map(toParam));
  }

  prepare(sql: string): SqliteStatement {
    const { sql: statement, names } = this.bound(sql);
    const store = this.store;
    const bind = (params: any[]) => this.bind(names, params);
    const sealIfLogFull = () => this.sealIfLogFull();
    const query = (params: any[]): any[] => JSON.parse(store.query(statement, bind(params)));
    const rows = profile
      ? (params: any[]) => profile(statement, () => query(params), (r) => r.length)
      : query;
    const write = (params: any[]): number => store.run(statement, bind(params));
    const change = profile ? (params: any[]) => profile(statement, () => write(params), (n) => n) : write;
    return {
      run(...params: any[]) {
        const changes = change(params);
        sealIfLogFull();
        return { changes, lastInsertRowid: 0 };
      },
      get(...params: any[]) {
        return rows(params)[0];
      },
      all(...params: any[]) {
        return rows(params);
      },
      iterate(...params: any[]) {
        return rows(params)[Symbol.iterator]();
      },
    };
  }

  exec(sql: string): void {
    this.store.exec(sql);
  }

  /**
   * Appends `rows` (in the table's column order) with DuckDB's Appender: the
   * bulk write path. It joins an open transaction like any other write.
   */
  append(table: string, rows: unknown[][]): number {
    if (rows.length === 0) return 0;
    const append = () => this.store.append(table, JSON.stringify(rows.map((row) => row.map(toParam))));
    const count = profile ? profile(`append ${table}`, append, (n) => n) : append();
    this.sealIfLogFull();
    return count;
  }

  pragma(_str: string, _options?: { simple?: boolean }): any {
    // SQLite tuning has no DuckDB meaning; its callers are SQLite-only paths
    // that the SQLite retirement removes.
    return undefined;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      if (this.txDepth > 0) {
        this.txDepth++;
        try {
          return fn(...args);
        } finally {
          this.txDepth--;
        }
      }
      this.store.exec('BEGIN TRANSACTION');
      this.txDepth = 1;
      try {
        const result = fn(...args);
        this.store.exec('COMMIT');
        this.txDepth = 0;
        this.sealIfLogFull();
        return result;
      } catch (error) {
        this.store.exec('ROLLBACK');
        this.txDepth = 0;
        throw error;
      }
    };
  }

  close(): void {
    // Every committed write is already in the log; the writer's close also
    // compacts it into a generation, so the next open replays little.
    if (!this.closed && this.logging) this.seal();
    this.closed = true;
  }
}

/** A DuckDB-backed connection for `dbPath`. */
export function createDuckdbDatabase(dbPath: string, opts?: { readOnly?: boolean }): DuckdbAdapter {
  return new DuckdbAdapter(dbPath, opts?.readOnly === true);
}

export type { DuckdbAdapter };
