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

/**
 * How sealed files are laid out for readers that query them in place: each
 * table sorted by the key it is most looked up by, in row groups small enough
 * that a lookup skips the ones whose min/max can't hold its key. Nodes by id
 * (by far the most frequent read), edges by source, search tokens by token.
 * Dictionaries are allowed up to a row group's size, so DuckDB writes bloom
 * filters for the high-cardinality keys too (id, name, edge ends): on rene's
 * index, edges by target fell from 13 to 2.7 ms read in place, for 2 MiB
 * (.cache/spike/parquet-layouts.mjs).
 */
const SEAL_LAYOUT = JSON.stringify({
  order: {
    nodes: 'id',
    edges: 'source, kind, target',
    node_tokens: 'token',
    node_search: 'node_id',
    unresolved_refs: 'id',
    files: 'path',
    name_segment_vocab: 'segment, name',
  },
  parquet: 'row_group_size 8192, dictionary_size_limit 8192, bloom_filter_false_positive_ratio 0.01',
});

interface NativeStore {
  exec(sql: string): void;
  run(sql: string, parameters: string): number;
  query(sql: string, parameters: string): string;
  append(table: string, rows: string): number;
  seal(directory: string, layout?: string): number;
  isWriter(): boolean;
  load(directory: string): number;
  logTo(directory: string): void;
  follow(directory: string): void;
  logBytes(): number;
  setLogging(enabled: boolean): void;
  changeStamp(): number;
}
interface NativeModule {
  Store: { new (): NativeStore; shared(name: string): NativeStore; releaseShared(name: string): boolean };
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

  /**
   * Whether this connection reads the sealed files in place (a query server
   * with no writer in its process): its tables are views over the newest
   * sealed generation's Parquet, nothing is loaded, and it moves to the next
   * generation when a seal publishes one (DESIGN.md, Readers). A read-only
   * connection in the writer's process (resolution's worker threads) uses
   * the writer's live database instead, unsealed work included.
   */
  readonly readsSealedFiles: boolean;
  private sealed: { stamp: string; generation: number; views: boolean } = { stamp: '', generation: 0, views: false };
  private schemaSql = '';

  constructor(private readonly dbPath: string, private readonly readOnly: boolean) {
    const shared = native().Store.shared(path.resolve(dbPath));
    // Opt-in while it is measured against the in-memory reader: on rene's
    // index it answered explore about 3x slower (DESIGN.md, Readers).
    this.readsSealedFiles = readOnly && !shared.isWriter() && process.env.CODEGRAPH_STORE_READER === 'parquet';
    this.store = this.readsSealedFiles ? new (native().Store)() : shared;
  }

  /**
   * Opens the sealed files for a reader (readsSealedFiles): views over the
   * newest generation, checked against `schemaSql` first (a mismatch throws
   * "schema mismatch: …", as a load does). Without a generation the tables
   * are the schema's, empty.
   */
  attachSealed(schemaSql: string): number {
    this.schemaSql = schemaSql;
    return this.refreshSealed(true);
  }

  /** Moves the views to the newest generation if the manifest changed. */
  private refreshSealed(force = false): number {
    const directory = duckdbStoreDirectory(this.dbPath);
    const manifestPath = path.join(directory, 'manifest.json');
    let stamp = 'none';
    try {
      const stat = fs.statSync(manifestPath);
      stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    } catch {
      // No generation sealed yet.
    }
    if (!force && stamp === this.sealed.stamp) return this.sealed.generation;
    if (stamp === 'none') {
      // No generation (a new index, or one a writer has just begun again):
      // the schema's tables, empty, in place of any views.
      if (this.sealed.views) {
        const views = JSON.parse(this.store.query('SELECT view_name FROM duckdb_views() WHERE NOT internal', '[]')) as Array<{ view_name: string }>;
        for (const { view_name } of views) this.store.exec(`DROP VIEW IF EXISTS "${view_name.replace(/"/g, '""')}"`);
      }
      if (this.sealed.views || this.sealed.stamp === '') this.store.exec(this.schemaSql);
      this.sealed = { stamp, generation: 0, views: false };
      return 0;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      generation: number;
      folder: string;
      tables: Record<string, { file: string }>;
    };
    const files = Object.entries(manifest.tables).map(([table, entry]) => [table, path.join(directory, manifest.folder, entry.file)] as const);
    this.checkSealedSchema(files);
    const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;
    const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const statements = files.map(([table, file]) =>
      `${this.sealed.views ? '' : `DROP TABLE IF EXISTS ${ident(table)}; `}` +
      `CREATE OR REPLACE VIEW ${ident(table)} AS SELECT * FROM read_parquet(${literal(file)});`
    );
    this.store.exec(statements.join('\n'));
    this.sealed = { stamp, generation: manifest.generation, views: true };
    return manifest.generation;
  }

  /** Throws "schema mismatch: …" when a sealed file's columns are not its table's in the schema. */
  private checkSealedSchema(files: ReadonlyArray<readonly [string, string]>): void {
    const expected = new (native().Store)();
    expected.exec(this.schemaSql);
    const describe = (store: NativeStore, relation: string) =>
      JSON.stringify((JSON.parse(store.query(`DESCRIBE SELECT * FROM ${relation}`, '[]')) as Array<{ column_name: string; column_type: string }>).map((c) => [c.column_name, c.column_type]));
    const tables = (JSON.parse(expected.query("SELECT table_name FROM duckdb_tables() WHERE database_name = current_database()", '[]')) as Array<{ table_name: string }>).map((t) => t.table_name);
    const sealed = new Map(files);
    const differences: string[] = [];
    for (const table of tables) {
      const file = sealed.get(table);
      if (!file) {
        differences.push(`${table} is not in the sealed generation`);
        continue;
      }
      const then = describe(this.store, `read_parquet('${file.replace(/'/g, "''")}')`);
      const now = describe(expected, `"${table}"`);
      if (then !== now) differences.push(`${table} was sealed with columns ${then}, the schema now has ${now}`);
    }
    if (differences.length > 0) throw new Error(`schema mismatch: ${differences.join('; ')}`);
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

  /**
   * A number that changes whenever the index may hold something it did not
   * before, whoever wrote it (this process's connections, or the writer this
   * reader follows): what a cache of answers is kept under.
   */
  changeStamp(): number {
    // A sealed-file reader changes only when it moves to a new generation.
    return this.readsSealedFiles ? this.refreshSealed() : this.store.changeStamp();
  }

  /**
   * Runs `hook` just before each seal, so what it writes (the generation's
   * whole-graph summaries) is sealed with the data it describes.
   */
  onSeal(hook: () => void): void {
    this.beforeSeal = hook;
  }
  private beforeSeal: (() => void) | undefined;

  /** Seals the working index as a new generation, compacting the log into it. */
  seal(): number {
    if (this.readOnly) throw new Error('A read-only index connection cannot seal.');
    this.beforeSeal?.();
    return this.store.seal(duckdbStoreDirectory(this.dbPath), SEAL_LAYOUT);
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
    const live = (params: any[]): any[] => JSON.parse(store.query(statement, bind(params)));
    // A sealed-file reader first moves to a newly sealed generation; a query
    // that met a generation's files just removed refreshes and runs again.
    const query = this.readsSealedFiles
      ? (params: any[]): any[] => {
          this.refreshSealed();
          try {
            return live(params);
          } catch (error) {
            if (!/No files found|No such file|Cannot open file|IO Error/i.test(String(error))) throw error;
            this.refreshSealed(true);
            return live(params);
          }
        }
      : live;
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
