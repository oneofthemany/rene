/**
 * Search on DuckDB: what SQLite's FTS5 table `nodes_fts` and its triggers did
 * for the index CodeGraph searched before DuckDB (packages/codegraph-store/
 * DESIGN.md, Search), as plain tables and SQL.
 *
 * `node_search` holds a row per node: its insertion order (FTS5's rowid,
 * which breaks score ties) and its length in tokens over all five indexed
 * columns. `node_tokens` holds each column's tokens at their positions, as
 * FTS5's unicode61 tokenizer made them (fts-tokens.ts). QueryBuilder keeps
 * both in step with `nodes` on every node write, as the triggers did: an
 * insert (or replace) gives the node a new order, an update keeps it.
 *
 * A query is FTS5's: phrases (a quoted term's tokens, in order, the last
 * matched as a prefix), OR-ed, ranked by FTS5's bm25() with the same column
 * weights, constants and floating-point steps, so the order matches.
 */

import type { SqliteDatabase } from './sqlite-adapter';
import { ftsTokens } from './fts-tokens';

/** FTS5's indexed columns, in its order: the column number is the index. */
export const SEARCH_COLUMNS = ['id', 'name', 'qualified_name', 'docstring', 'signature'] as const;

/** The bm25() weights CodeGraph ranks with, per column: id 0, name 20,
 *  qualified_name 5, docstring 1, signature 2. */
const WEIGHTS = [0, 20, 5, 1, 2];

/** A node's indexed values, in SEARCH_COLUMNS order. */
export type SearchFields = [string, string, string, string | null, string | null];

/** One phrase: its tokens, the last matched as a prefix. Empty matches nothing. */
export type Phrase = string[];

/** The appender's batch: node_tokens rows (node_id, col, pos, token). */
const APPEND_ROWS = 50_000;

/** The id lists' chunk size: DuckDB has no parameter limit; this bounds one statement. */
const ID_CHUNK = 500;

interface Appending {
  append(table: string, rows: unknown[][]): number;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The least string after every string starting with `prefix`, in DuckDB's
 * byte order (UTF-8 orders as code points): the prefix with its last code
 * point raised, skipping the surrogate range; trailing highest code points
 * can't be raised and are dropped first. Null when nothing can be raised:
 * the range has no upper end.
 */
export function prefixEnd(prefix: string): string | null {
  const points = [...prefix];
  while (points.length > 0) {
    const last = points.pop()!.codePointAt(0)!;
    if (last < 0x10ffff) {
      const next = last + 1 === 0xd800 ? 0xe000 : last + 1;
      return points.join('') + String.fromCodePoint(next);
    }
  }
  return null;
}

/** The phrase FTS5 makes of `"text"*`: the text's tokens. */
export function phraseOf(text: string): Phrase {
  return ftsTokens(text);
}

/**
 * Keeps `node_search` and `node_tokens` in step with `nodes`. Its writes join
 * the caller's transaction, so they commit or roll back with the node rows.
 */
export class TokenIndex {
  constructor(private readonly db: SqliteDatabase & Appending) {}

  /** Whether `db` holds the token tables (a DuckDB index) rather than FTS5. */
  static available(db: SqliteDatabase): db is SqliteDatabase & Appending {
    if (typeof (db as Partial<Appending>).append !== 'function') return false;
    try {
      db.prepare('SELECT 1 FROM node_search LIMIT 0').all();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Indexes inserted nodes, as the insert trigger did. A node that was
   * already indexed is replaced and, like a replaced SQLite row, takes a new
   * insertion order: nodes are indexed in `fields` order.
   */
  inserted(fields: SearchFields[]): void {
    if (fields.length === 0) return;
    const ids = fields.map((f) => f[0]);
    const present = this.indexed(ids);
    if (present.length > 0) this.remove(present);
    const lengths: unknown[] = [];
    const tokens: unknown[][] = [];
    for (const f of fields) lengths.push(f[0], this.collect(f, tokens));
    for (const part of chunks(lengths, ID_CHUNK * 2)) {
      this.db
        .prepare(`INSERT INTO node_search (node_id, length) VALUES ${new Array(part.length / 2).fill('(?, ?)').join(', ')}`)
        .run(...part);
    }
    for (const part of chunks(tokens, APPEND_ROWS)) this.db.append('node_tokens', part);
  }

  /** Re-indexes an updated node, as the update trigger did: it keeps its order. */
  updated(f: SearchFields): void {
    if (this.indexed([f[0]]).length === 0) return;
    this.db.prepare('DELETE FROM node_tokens WHERE node_id = ?').run(f[0]);
    const tokens: unknown[][] = [];
    const length = this.collect(f, tokens);
    this.db.prepare('UPDATE node_search SET length = ? WHERE node_id = ?').run(length, f[0]);
    if (tokens.length > 0) this.db.append('node_tokens', tokens);
  }

  /** Drops the nodes `where` selects (a condition on `nodes`), before they are deleted. */
  deleting(where: string, params: unknown[]): void {
    const ids = (this.db.prepare(`SELECT id FROM nodes WHERE ${where}`).all(...params) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length > 0) this.remove(ids);
  }

  /** Drops every node, as clearing `nodes` did. */
  clear(): void {
    this.db.exec('DELETE FROM node_tokens');
    this.db.exec('DELETE FROM node_search');
  }

  private indexed(ids: string[]): string[] {
    const found: string[] = [];
    for (const part of chunks(ids, ID_CHUNK)) {
      const rows = this.db
        .prepare(`SELECT node_id FROM node_search WHERE node_id IN (${part.map(() => '?').join(', ')})`)
        .all(...part) as Array<{ node_id: string }>;
      for (const row of rows) found.push(row.node_id);
    }
    return found;
  }

  private remove(ids: string[]): void {
    for (const part of chunks(ids, ID_CHUNK)) {
      const list = part.map(() => '?').join(', ');
      this.db.prepare(`DELETE FROM node_tokens WHERE node_id IN (${list})`).run(...part);
      this.db.prepare(`DELETE FROM node_search WHERE node_id IN (${list})`).run(...part);
    }
  }

  /** Adds `f`'s token rows to `out`; returns its length in tokens. */
  private collect(f: SearchFields, out: unknown[][]): number {
    let length = 0;
    for (let col = 0; col < SEARCH_COLUMNS.length; col++) {
      const tokens = ftsTokens(f[col]);
      for (let pos = 0; pos < tokens.length; pos++) out.push([f[0], col, pos, tokens[pos]]);
      length += tokens.length;
    }
    return length;
  }
}

/**
 * The phrase instances CTE `inst(phrase, node_id, col)`: one row per place a
 * phrase matches, in the columns `columns` names (all when omitted). A
 * phrase matches where its tokens stand at consecutive positions of one
 * column, the last as a prefix. Phrases without tokens get no rows.
 */
function instances(phrases: Phrase[], columns?: number[]): { sql: string; params: unknown[] } {
  const values: string[] = [];
  const params: unknown[] = [];
  phrases.forEach((phrase, i) => {
    phrase.forEach((token, k) => {
      values.push('(?, ?, ?, ?, ?)');
      params.push(i, k, phrase.length, token, k === phrase.length - 1 ? 1 : 0);
    });
  });
  const only = columns ? ` AND t.col IN (${columns.join(', ')})` : '';
  // The token rows a phrase could use, by range first: a prefix p is
  // [p, p with its last character raised), an exact token is itself. The
  // filter reads the token column once, where matching every row against
  // every phrase token took three times as long (DESIGN.md, Search); the
  // phrases are then matched against the few rows it keeps.
  const ranges: string[] = [];
  phrases.forEach((phrase) => {
    phrase.forEach((token, k) => {
      const end = k === phrase.length - 1 ? prefixEnd(token) : undefined;
      if (end === null) {
        ranges.push('token >= ?');
        params.push(token);
      } else if (end !== undefined) {
        ranges.push('(token >= ? AND token < ?)');
        params.push(token, end);
      } else {
        ranges.push('token = ?');
        params.push(token);
      }
    });
  });
  return {
    sql: `q(phrase, k, n, token, prefix) AS (VALUES ${values.join(', ')}),
      cand AS (SELECT * FROM node_tokens WHERE ${ranges.join(' OR ')}),
      inst AS (
        SELECT q.phrase, t.node_id, t.col
        FROM q JOIN cand t
          ON (CASE WHEN q.prefix = 1 THEN starts_with(t.token, q.token) ELSE t.token = q.token END)${only}
        GROUP BY q.phrase, q.n, t.node_id, t.col, t.pos - q.k
        HAVING count(*) = q.n
      )`,
    params,
  };
}

/**
 * The ranked search: `node_id` and `score` (bm25(), negative; lower ranks
 * first) for nodes any phrase matches, in FTS5's order, ties broken by
 * insertion order. `filter` is a condition on `nodes`' kind and language,
 * the only columns joined: a caller reads the whole rows of the few results
 * it keeps (joining every candidate's whole row took half the query's time,
 * read in place).
 */
export function rankedSearchSql(
  phrases: Phrase[],
  filter: { sql: string; params: unknown[] }
): { sql: string; params: unknown[] } | undefined {
  if (!phrases.some((p) => p.length > 0)) return undefined;
  const inst = instances(phrases);
  const weight = `CASE i.col ${WEIGHTS.map((w, col) => `WHEN ${col} THEN CAST(${w} AS DOUBLE)`).join(' ')} END`;
  // bm25() as fts5_aux.c computes it, step for step in IEEE doubles:
  //   idf = ln((nRow - nHit + 0.5) / (nHit + 0.5)), or 1e-6 when <= 0
  //   score = -(0.0 + sum over phrases, in order, of
  //            idf * ((f * (k1 + 1.0)) / (f + k1 * (1 - b + b * D / avgdl))))
  // with f a phrase's instances weighted by column, D the node's length in
  // tokens and avgdl the mean; k1 = 1.2, b = 0.75.
  const term = (i: number) =>
    `coalesce(max(f.idf * ((f.f * (CAST(1.2 AS DOUBLE) + CAST(1.0 AS DOUBLE))) / (f.f + CAST(1.2 AS DOUBLE) * ((CAST(1 AS DOUBLE) - CAST(0.75 AS DOUBLE)) + (CAST(0.75 AS DOUBLE) * f.d) / f.avgdl)))) FILTER (WHERE f.phrase = ${i}), CAST(0 AS DOUBLE))`;
  const sum = ['CAST(0 AS DOUBLE)', ...phrases.map((_, i) => term(i))].join(' + ');
  return {
    sql: `WITH ${inst.sql},
      stats AS (
        SELECT CAST(count(*) AS DOUBLE) AS nrow, CAST(coalesce(sum(length), 0) AS DOUBLE) AS ntok
        FROM node_search
      ),
      idf AS (
        SELECT h.phrase, CASE WHEN h.x <= 0 THEN CAST(1e-6 AS DOUBLE) ELSE h.x END AS idf
        FROM (
          SELECT inst.phrase, ln(((SELECT nrow FROM stats) - CAST(count(DISTINCT inst.node_id) AS DOUBLE) + CAST(0.5 AS DOUBLE))
            / (CAST(count(DISTINCT inst.node_id) AS DOUBLE) + CAST(0.5 AS DOUBLE))) AS x
          FROM inst GROUP BY inst.phrase
        ) h
      ),
      f AS (
        SELECT i.node_id, i.phrase, sum(${weight}) AS f, idf.idf,
          CAST(s.length AS DOUBLE) AS d, (SELECT ntok / nrow FROM stats) AS avgdl
        FROM inst i JOIN idf ON idf.phrase = i.phrase JOIN node_search s ON s.node_id = i.node_id
        GROUP BY i.node_id, i.phrase, idf.idf, s.length
      ),
      scored AS (
        SELECT f.node_id, -(${sum}) AS score FROM f GROUP BY f.node_id
      )
      SELECT scored.node_id, scored.score
      FROM scored
      JOIN node_search s ON s.node_id = scored.node_id
      JOIN (SELECT id, kind, language FROM nodes) nodes ON nodes.id = scored.node_id
      WHERE 1 = 1${filter.sql}
      ORDER BY scored.score, s.seq`,
    params: [...inst.params, ...filter.params],
  };
}

/** Which of `phrases` match some node in `columns`: their indexes. */
export function matchingPhrases(db: SqliteDatabase, phrases: Phrase[], columns: number[]): Set<number> {
  if (!phrases.some((p) => p.length > 0)) return new Set();
  const inst = instances(phrases, columns);
  const rows = db.prepare(`WITH ${inst.sql} SELECT DISTINCT phrase FROM inst`).all(...inst.params) as Array<{
    phrase: number;
  }>;
  return new Set(rows.map((r) => Number(r.phrase)));
}

/**
 * Names of the first `limit` nodes, in insertion order, that any phrase
 * matches in `columns`, other than files and imports.
 */
export function matchingNames(db: SqliteDatabase, phrases: Phrase[], columns: number[], limit: number): string[] {
  if (!phrases.some((p) => p.length > 0)) return [];
  const inst = instances(phrases, columns);
  const rows = db
    .prepare(
      `WITH ${inst.sql}
      SELECT n.name FROM (SELECT DISTINCT node_id FROM inst) m
      JOIN node_search s ON s.node_id = m.node_id
      JOIN nodes n ON n.id = m.node_id
      WHERE n.kind NOT IN ('file', 'import')
      ORDER BY s.seq LIMIT ?`
    )
    .all(...inst.params, limit) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}
