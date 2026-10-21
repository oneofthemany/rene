import { createDatabase, type SqliteDatabase } from './sqlite-adapter';
import { QueryBuilder } from './queries';
import { createYielder } from '../resolution/cooperative-yield';
import type { DuckdbAdapter } from './duckdb-adapter';

// Ownership is independent of provenance: Go method containment is structural.
export const SYNTHESIZED_EDGE = "CASE WHEN json_valid(metadata) THEN json_extract_string(metadata, '$.synthesizedBy') END IS NOT NULL";

/** Rows staged and published per statement, between yields. */
const PUBLISH_BATCH = 2000;
const EDGE_COLUMNS = 'source, target, kind, metadata, line, col, provenance';

/**
 * A private edge overlay: passes see base edges plus their new Go
 * prerequisites.
 *
 * On its own connection, a TEMP view named `edges` shows the base edges
 * without the synthesized ones, plus the edges staged so far; the builder's
 * edge inserts go to the staging table (QueryBuilder.stageEdgeInserts),
 * checked against that view, as SQLite's INSTEAD OF trigger did. The base
 * tables are named through their catalog: inside the view, `main.edges`
 * would name the view itself. The stage's own writes are to TEMP objects and
 * stay out of the log; publish writes the base tables with self-contained
 * statements, which a replay reproduces.
 */
export class SynthesisStage {
  readonly db: SqliteDatabase;
  readonly queries: QueryBuilder;
  /** The base schema, qualified by catalog: `"memory".main`. */
  private readonly base: string;

  constructor(dbPath: string) {
    this.db = createDatabase(dbPath).db;
    try {
      (this.db as DuckdbAdapter).setLogging(false);
      const catalog = (this.db.prepare('SELECT current_database() AS db').get() as { db: string }).db;
      this.base = `"${catalog.replaceAll('"', '""')}".main`;
      this.db.exec(`
        CREATE TEMP TABLE synthesis_inputs (file_path VARCHAR PRIMARY KEY);
        CREATE TEMP SEQUENCE synthesis_edges_id;
        CREATE TEMP TABLE synthesis_edges (
          id BIGINT PRIMARY KEY DEFAULT nextval('synthesis_edges_id'), source VARCHAR, target VARCHAR, kind VARCHAR,
          metadata VARCHAR, line BIGINT, col BIGINT, provenance VARCHAR
        );
        CREATE TEMP VIEW edges AS
          SELECT * FROM ${this.base}.edges WHERE NOT COALESCE((${SYNTHESIZED_EDGE}), false)
          UNION ALL SELECT * FROM synthesis_edges;
      `);
      this.queries = new QueryBuilder(this.db);
      this.queries.stageEdgeInserts('synthesis_edges');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  async publish(backpressure?: () => Promise<void> | null): Promise<void> {
    await backpressure?.();
    const yieldToLoop = createYielder();
    // One transaction, so other connections see the replacement whole. The
    // writes are to the base tables and logged, each carrying its data.
    (this.db as DuckdbAdapter).setLogging(true);
    this.db.exec('BEGIN TRANSACTION');
    try {
      const remove = this.db.prepare(`DELETE FROM ${this.base}.edges WHERE id IN (
        SELECT id FROM ${this.base}.edges WHERE ${SYNTHESIZED_EDGE} LIMIT ${PUBLISH_BATCH}
      )`);
      while (remove.run().changes > 0) await yieldToLoop();
      const staged = this.db.prepare(
        `SELECT ${EDGE_COLUMNS} FROM synthesis_edges WHERE id > ? AND id <= ? ORDER BY id`
      );
      const max = (this.db.prepare('SELECT MAX(id) AS id FROM synthesis_edges').get() as { id: number | null })?.id ?? 0;
      for (let i = 0; i < max; i += PUBLISH_BATCH) {
        const rows = (staged.all(i, i + PUBLISH_BATCH) as Array<Record<string, unknown>>).map((row) => [
          row.source, row.target, row.kind, row.metadata, row.line, row.col, row.provenance,
        ]);
        this.queries.insertEdgeRowsInto(`${this.base}.edges`, rows);
        await yieldToLoop();
      }
      const inputs = (this.db.prepare('SELECT file_path FROM temp.synthesis_inputs').all() as Array<{ file_path: string }>)
        .map((row) => row.file_path);
      this.db.prepare(`DELETE FROM ${this.base}.synthesis_inputs`).run();
      const insertInput = this.db.prepare(`INSERT INTO ${this.base}.synthesis_inputs (file_path) VALUES (?)`);
      for (const filePath of inputs) insertInput.run(filePath);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      (this.db as DuckdbAdapter).setLogging(false);
    }
    await backpressure?.();
  }

  close(): void {
    this.db.close();
  }
}
