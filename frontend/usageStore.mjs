// The usage store: one row per model call and per tool call a project's
// agents made, and one per message of yours that turned the work (kind
// message: a correction or added scope; interrupt: a stop), for slicing usage by agent, conversation, topic, phase, waste
// and deviation (TODO › Agent usage, items 6 and 7).
//
// rene owns it (not the telemetry journal): the rows name conversations,
// topics and the evidence line each classification rests on. It is DuckDB
// over sealed Parquet, through CodeGraph's store addon
// (packages/codegraph-store): the same generations, manifest published by
// atomic rename, and per-table sort order. The rows are derived, never
// entered: usage.mjs classifies each call (the ledger sessionUsage returns)
// and each write replaces the table with the whole ledger, so a store sealed
// under another schema is simply rebuilt.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const USAGE_SCHEMA = `create table calls (
  kind varchar not null,
  id varchar,
  at_ms bigint not null,
  agent varchar,
  conversation varchar not null,
  project varchar,
  topic varchar,
  phase varchar,
  basis varchar,
  model varchar,
  input_tokens bigint,
  cache_read_tokens bigint,
  cache_write_tokens bigint,
  output_tokens bigint,
  context_tokens bigint,
  context_limit bigint,
  tool varchar,
  result_chars bigint,
  outcome varchar,
  waste_reason varchar,
  waste_evidence varchar,
  deviation_cause varchar,
  deviation_kind varchar,
  deviation_evidence varchar
);`;

// Read by time within a conversation; slices filter the dictionary columns.
const SEAL_LAYOUT = JSON.stringify({
  order: { calls: "conversation, at_ms" },
  parquet: "row_group_size 8192",
});

const whole = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : null;

/** A ledger row (usage.mjs) as the calls table's columns, in order. */
export const usageColumns = (row, project) => [
  row.kind,
  row.id ?? null,
  whole(row.at),
  row.agent ?? null,
  row.conversation,
  project ?? null,
  row.topic ?? null,
  row.phase ?? null,
  row.basis ?? null,
  row.model ?? null,
  whole(row.input),
  whole(row.cacheRead),
  whole(row.cacheWrite),
  whole(row.output),
  whole(row.context),
  whole(row.contextLimit),
  row.tool ?? null,
  whole(row.resultChars),
  row.outcome ?? null,
  row.waste?.reason ?? null,
  row.waste?.text ?? null,
  row.deviation?.cause ?? null,
  row.deviation?.kind ?? null,
  row.deviation?.text ?? null,
];

const failure = (error) => ({
  ok: false,
  reason: error instanceof Error ? error.message : String(error),
});

/**
 * A project's usage store under `directory`. Not shared between processes:
 * the bridge that owns the project is its only writer.
 * @param {string} directory where its generations and manifest live
 * @param {{ addon?: string }} [options] the store addon's path
 *   (CODEGRAPH_STORE_ADDON, else the one packages/codegraph-store builds)
 */
export function createUsageStore(directory, { addon } = {}) {
  let store;
  let unavailable;
  /** The in-memory database, loaded from the last sealed generation. */
  const open = () => {
    if (store) return store;
    if (unavailable) throw new Error(unavailable);
    let native;
    try {
      native = require(
        addon ??
          process.env.CODEGRAPH_STORE_ADDON ??
          fileURLToPath(
            new URL(
              "../packages/codegraph-store/dist/codegraph_store.node",
              import.meta.url,
            ),
          ),
      );
    } catch (error) {
      unavailable = `the store addon isn't built (packages/codegraph-store): ${error.message}`;
      throw new Error(unavailable);
    }
    const opened = new native.Store();
    opened.exec(USAGE_SCHEMA);
    try {
      opened.load(directory);
    } catch {
      // Sealed under another schema, or unreadable: the next write rebuilds
      // it from the conversations, which are the source.
      opened.exec("delete from calls");
    }
    store = opened;
    return store;
  };
  return {
    directory,
    /**
     * Replaces the rows with `ledger` and seals them as a new generation.
     * @returns {{ ok: true, generation: number, rows: number } | { ok: false, reason: string }}
     */
    write({ project, ledger }) {
      try {
        const db = open();
        db.exec("begin transaction; delete from calls;");
        try {
          if (ledger.length)
            db.append(
              "calls",
              JSON.stringify(ledger.map((row) => usageColumns(row, project))),
            );
          db.exec("commit;");
        } catch (error) {
          db.exec("rollback;");
          throw error;
        }
        return {
          ok: true,
          generation: db.seal(directory, SEAL_LAYOUT),
          rows: ledger.length,
        };
      } catch (error) {
        return failure(error);
      }
    },
    /**
     * Runs a read-only query over the calls table.
     * @param {string} sql
     * @param {unknown[]} [parameters] positional `?` values
     * @returns {{ ok: true, rows: object[] } | { ok: false, reason: string }}
     */
    query(sql, parameters = []) {
      try {
        return {
          ok: true,
          rows: JSON.parse(open().query(sql, JSON.stringify(parameters))),
        };
      } catch (error) {
        return failure(error);
      }
    },
  };
}
