# codegraph-store: CodeGraph's index in DuckDB

CodeGraph (`packages/codegraph`) keeps its index in SQLite through
`QueryBuilder` (`src/db/queries.ts`, 143 methods: 101 read, 28 write). This
crate replaces that storage with DuckDB, modelled on the telemetry journal's
store (`sherloq/Frontend/telemetry_journal/telemetry_core/store.py`): no
shared database file, so no write lock.

## Shape

- **On disk** (`.codegraph/store/`): immutable Parquet segments per table
  (`nodes`, `edges`, `files`, `unresolved_refs`, `name_segment_vocab`,
  `tokens`, `metadata`), and `manifest.json`, naming the live segments and the
  files each one's rows replace. A writer publishes a manifest by writing it
  under a temporary name, fsyncing, and renaming it over the old one.
- **Writer** (one: the indexer, `indexAll` and `sync`): an in-memory DuckDB
  holding the working index, where every `QueryBuilder` write runs as SQL and
  bulk inserts go through the native Appender. Extraction and resolution
  workers hand their rows to it rather than opening their own connections.
  At a commit point (the end of an index or a sync) it seals the changed
  files' rows into new segments and publishes the manifest. Rows not yet
  sealed are lost on a crash; their files' hashes aren't sealed either, so
  the next sync reindexes them.
- **Readers** (the daemon, the workbench's query servers, the MCP server, the
  writer itself): load the manifest's segments into their own in-memory
  DuckDB, then build adjacency and id maps in Rust. They reload when the
  manifest changes. Nothing waits on a lock.
- **Compaction**: merges small segments and drops replaced rows in the
  background, then publishes a manifest naming the result.
- **Durability** (the user's rule, 2026-10-21): every change reaches disk
  as soon as it is committed, never on a timer, and on the host, so a
  container or process crash loses nothing committed. The store directory
  is the project's `.codegraph/`, in the home folder the container mounts
  from the host. Each committed write (a statement with its parameters, or
  an Appender batch) is appended to a write-ahead log beside the manifest
  and fsynced before the commit returns; statements inside a transaction
  are written together at COMMIT and dropped at ROLLBACK. A log belongs to
  the generation it follows (`wal-g<N>.log`): loading generation N replays
  its log, and sealing N+1 starts a new log and removes the old one once
  the manifest names N+1. Sealing is compaction, not durability.

## Native DuckDB SQL (decided 2026-10-21)

CodeGraph's queries are written in DuckDB's dialect, not translated from
SQLite's at run time: a pattern-matching translator can change a query's
meaning without an error (`json_extract` returning text, a guessed alias).
The translator in `src/db/duckdb-adapter.ts` is a stopgap and goes. In its
place:

1. **Goldens from SQLite, before the port.** Index fixed projects with the
   SQLite build; record every table (volatile columns left out, rows in a
   stable order) and the answers to a fixed battery: search, callers,
   callees, impact, explore, and QueryBuilder's read methods.
2. **Port**: a DuckDB schema, and every QueryBuilder statement rewritten for
   DuckDB, group by group. Cascading deletes are explicit in the delete
   methods; JSON reads say which type they want; search uses the token
   table. The adapter becomes the thin interface over the store.
3. **Compare**: DuckDB's tables and battery answers against the goldens,
   with every difference fixed or explained, and CodeGraph's tests.
4. **Retire SQLite**: its adapter, WAL valve, WSL shared-index handling and
   migrations.

## Failure modes

Every one has a rule and a test (the user's requirement, 2026-10-21: no
single-point fixes).

| Failure                     | Rule                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process or container crash  | Committed writes are in the log, fsynced before COMMIT returns, on the host disk; recovery loads the newest generation and replays its log.               |
| Torn write at the log's end | Replay applies only complete groups.                                                                                                                      |
| Corruption inside the log   | Each commit carries a checksum of its group; replay stops at a bad group and reports it.                                                                  |
| Log write fails (disk full) | A write outside a transaction runs in its own; if logging fails it rolls back, so memory never holds what the disk doesn't.                               |
| Two writers                 | An exclusive OS lock on `writer.lock` for as long as one logs; a second is refused with a clear error.                                                    |
| Stale readers               | A reader follows the log: before each query it applies newly committed groups, or reloads when a newer generation is published.                           |
| Log grows without bound     | The writer seals when the log passes a size limit (`CODEGRAPH_STORE_SEAL_BYTES`, default 64 MiB), bounding recovery time; durability never depends on it. |
| Crash during a seal         | The manifest switches by atomic rename only after the generation is complete; a half-written folder is never named, and the next seal replaces it.        |
| A seal under a reader       | A missing log or a newer generation means reload, not an error.                                                                                           |

## Queries

DuckDB scans; it doesn't seek. A single-row lookup costs about 250 µs
against SQLite's 10 µs (it scans the column; its ART index isn't used), but a
batched lookup matches SQLite and aggregates run 5-23x faster (spike,
2026-10-21). So:

- **Traversal** (callers, callees, impact, explore: hop by hop) uses id and
  adjacency maps built in Rust at load, under 1 µs a hop.
- **Point reads in loops** become batched set queries; `QueryBuilder` already
  has batch forms (`getNodesByIds`, `getIncomingEdgesTo`).
- **Set and analytic queries** (code map, module aggregation, dependents,
  coverage, the operation map) run as DuckDB SQL.
- **Tags**: low-cardinality columns for filtering and aggregation (node
  kind, language, module, layer, link kind, external or project target,
  unresolved class, test or generated), with segments sorted by file and
  tags so DuckDB skips whole blocks.
- **Search**: FTS5's BM25 (`bm25(nodes_fts, 0, 20, 5, 1, 2)`) over a
  `tokens` table the writer builds at seal time with FTS5's unicode61 rules,
  scored in SQL with FTS5's constants; checked against SQLite's ranking.

## DuckDB build

The `duckdb` crate is pinned to `=1.10505.0`, as in `packages/history-store`.
CodeGraph needs DuckDB's `parquet` (segments) and `json` (11 methods use JSON
functions) extensions, which the cached static library lacks, so this crate
builds DuckDB from the crate's bundled source with both, once, and caches the
result keyed by version and extensions.

## Status (2026-10-21)

- The addon builds: DuckDB 1.10505.0 from bundled source with parquet and
  json, bounded (`cargo build --release -j 2` under `nice` and
  `ulimit -v 6291456`; 16 jobs froze the workstation). Install
  `target/release/libcodegraph_store.so` as `dist/codegraph_store.node` by
  copying it beside and renaming it into place: a copy over the file
  rewrites the library a running process (the daemon) has mapped.
- `Store`: `exec`, `run`, `query` (JSON rows), `append` (native Appender),
  `seal`, `load` (refills schema tables in place, advances their
  sequences, replays the log), `logTo`, `shared(name)` (one in-memory
  database per index per process, for CodeGraph's worker threads), and
  `sealedGeneration(dir)`. Each in-memory database runs one DuckDB thread
  (`CODEGRAPH_STORE_THREADS` raises it): one per core, across the many
  databases CodeGraph's tests open, exhausted the container's threads.
- The write-ahead log (`src/wal.rs`): shared by a database's connections, a
  commit fsynced before it returns, replayed on load, rotated by a seal.
  Round-trip and crash checks (torn line, uncommitted transaction, recovery,
  rotation) pass.
- CodeGraph: `src/db/duckdb-adapter.ts` implements its `SqliteDatabase`
  interface over the store, selected with `CODEGRAPH_STORAGE=duckdb`
  (SQLite stays the default). It translates SQLite's dialect (64-bit
  INTEGER as BIGINT, AUTOINCREMENT as a sequence; no triggers, FTS5,
  partial or expression indexes, pragmas; `@name` parameters as `?`) and
  performs the cascading deletes DuckDB's foreign keys don't. The writer
  starts the log on open and initialize, and only the writer seals. Search
  uses CodeGraph's existing no-FTS5 path for now.
- Not yet: a build script with a cached DuckDB, the adjacency maps,
  readers following the log, the BM25 token table, the tag columns.

## Port progress (2026-10-21)

- Native SQL in place of the translator, which is gone (its last version is
  kept outside the tree): `schema.duckdb.sql`; DuckDB's own initialize and
  open in `DatabaseConnection` (SQLite's paths as before); JSON read as text
  (`->> '$'`, `json_extract_string`) or cast to a number explicitly; `GLOB`
  as `LIKE` for prefixes and `regexp_full_match` otherwise; edge identity
  checked explicitly (`NOT EXISTS`, the batch's first duplicate kept);
  cascading deletes written out in the delete methods; `ORDER BY id` where
  SQLite's `rowid` was meant; the synthesis stage as a per-connection TEMP
  overlay naming base tables by catalog, its own writes unlogged and its
  publish self-contained; grouping by a key spells out its columns.
- The parity battery runs to completion on DuckDB. Findings:
  - **Inputs must be frozen.** The first comparison indexed CodeGraph's
    own source, which the port was changing; the fixtures, unchanged,
    compare validly. Record goldens from frozen copies and the committed
    build.
  - **Row order.** SQLite returns a scan's rows in insertion order and
    CodeGraph relies on it in places: kernel-parity names a Dart function
    `local` on SQLite and `outer::local` on DuckDB, and edges shift from
    there. Every query whose order feeds a decision needs `ORDER BY`.
  - **Search** differed until the BM25 token tables landed (Search, below).
  - **Indexing is about 4x slower** on DuckDB (24.8 s against 6.4 s for
    CodeGraph's source): row-at-a-time statements and JSON crossing the
    addon; the Appender and batching are the remedy.
- CodeGraph's tests query the database with their own raw SQLite SQL (148
  aliases without AS, 77 JSON reads): ported with the tests.

### Comparison against the committed SQLite build (2026-10-21)

Goldens from the committed CodeGraph (918299250) on SQLite, inputs frozen
from that commit (.cache/parity-inputs), recorded with
scripts/storage-parity.mjs; two SQLite runs are identical. DuckDB now
matches it on every table and every battery answer in all five projects,
search included (below). On the way the comparison found and fixed:

- A reader thread reloading the writer's database. In-process connections
  share one in-memory database; a worker's load replaced the writer's
  unsealed work with the last seal. The follow state now belongs to the
  database: load is a no-op where the process writes it, and catch-up is
  serialised and applied once (shared-smoke checks both).
- Freed memory read through cached statements. prepare_cached reused a
  statement after its table changed and returned strings from memory no
  longer its own, silently: a synthesizer found no inputs, and
  kernel-parity's edges and dead code shifted. The addon prepares every
  statement fresh.
- A batch writing one id twice keeps its last row, as SQLite's REPLACE did
  (lastRowPerKey).
- Order the query plan chose. getTopDependedOn breaks ties by node id; the
  file dependency lookups ORDER BY fp. Applied to the committed SQLite
  build too, the same change makes SQLite and DuckDB report identical
  cycles: the difference was the order, nothing else.

### Search (2026-10-21)

- Tokenizer: src/db/fts-tokens.ts reproduces FTS5 unicode61 exactly, using
  tables derived from FTS5 itself (scripts/generate-fts-unicode.mjs, 411
  token ranges, 1,243 folds; FTS5 uses Unicode 6.1, so unassigned code
  points of 6.1 are token characters). scripts/fts-token-parity.mjs: 45,283
  texts, 0 differences.
- Index (src/db/token-search.ts): `node_search` (a row per node: its
  insertion order, FTS5's rowid, and its length in tokens over the five
  columns) and `node_tokens` (each column's tokens at their positions, by
  the Appender). QueryBuilder keeps them in the node writes' transactions
  as FTS5's triggers did: an insert or replace takes a new order, an update
  keeps it, deletes and clear drop them.
- Query: each term is FTS5's phrase `"term"*` (its tokens at consecutive
  positions of one column, the last a prefix), OR-ed, ranked by bm25() as
  fts5_aux.c computes it, step for step in doubles (weights 0,20,5,1,2; k1
  1.2; b 0.75; idf floored at 1e-6; a phrase's hits over all rows, id
  column included), ties by insertion order. The miss diagnostics use the
  same phrases with FTS5's column filters.
- Checked: searchNodesFTS's raw candidates are identical to FTS5's, scores
  included (500 of 500 for a three-term query on CodeGraph's source), and
  storage-parity's search battery (sampled names, word pairs, separators,
  operators, diacritics, kind filters, paging, miss diagnostics, and all of
  it again after a sync that re-indexes one file and deletes another) is
  identical in all five projects.

### Implicit row order (2026-10-21)

SQLite answered a query without ORDER BY in its plan's order: rowid for a
scan or a one-key seek, else the index's columns then rowid; DuckDB keeps
insertion order only for plain scans, not joins or aggregates. Every read
whose order reaches a caller now states the order SQLite's plan gave (the
plans recorded with storage-parity's CODEGRAPH_PARITY_PLANS on the
committed build): node lookups by name in insertion order
(QueryBuilder.insertionOrder: rowid, or node_search's order), edge lookups
by source or target then kind then id, references by their index key then
id, first-occurrence lists through `row_number()`. A planner with ANALYZE
statistics could have chosen other orders on SQLite; DuckDB's are now
defined. Reads used only as sets or maps keyed by id were left as they are.
Found on the way: a DECIMAL (the literal `1.0` in a CASE) reached CodeGraph
as Rust debug text; the store now returns it as a number.

Ties before a LIMIT: SQLite grouped in key order and sorted stably, so a
tie in `ORDER BY count DESC LIMIT n` came out by group key; those queries
now name the key last. A bare column beside MIN() (SQLite takes it from the
row holding the minimum; DuckDB refuses it) is `arg_min` (getFailedScopedImports,
found by a sync, not by the battery).

### Schema changes (2026-10-21)

A generation loads by column position and a log replays statements, so an
index sealed or logged under another schema would fail part-way or put
values in the wrong columns. The store now refuses it first: before a load
changes anything it compares each sealed file's columns with its table's
(both by DESCRIBE), and every writer's log begins with a schema record that
load and followers check; either fails with "schema mismatch: …". The
store's own tables are listed from its catalog only, so a connection's TEMP
objects (a synthesis stage) are never sealed. CodeGraph's writer moves a
mismatched store aside, removes it and begins a new index, which the next
sync fills (the index is derived from the source); a read-only open is
refused with the reason. Checked by .cache/spike/schema-smoke.mjs and by
opening a copy of rene's index from before the token tables.

### Indexing speed (2026-10-22)

CodeGraph asked DuckDB SQLite's way, one row per query: resolution looked up
nodes by name, qualified name, lowered name and id one reference at a time
(about 0.5-1.5 ms each, the cost being the row fetch from every column, not
the scan), and wrote each failed reference's status with its own UPDATE.
On rene's index, 2,000 names asked one by one took 1,083 ms; in one query,
37 ms; every reference against every same-named node as one join, 47 ms.
Done: the resolver prefetches each slice of 400 references' lookups in one
query per kind (QueryBuilder.getNodesByNames and siblings, keeping each
lookup's order, [] for an absent key) into the caches it already had;
failed references are written in one UPDATE ... FROM (VALUES) per chunk;
ART indexes serve the remaining point lookups. Store time for CodeGraph's
source went from 71 s to 25 s, indexing from 33 s to 24 s, parity identical.

Next, the inserts (about 14 s): measured on a 338k-row table, one Appender
call of 21 rows costs about 250 us (12 us a row) and 2,000 rows 2.2 us a row,
and each index adds to it (pk, unique key and one index: 18.5 and 3.7 us).
The telemetry journal's seal shows the cheap shape: large batches into a
table without indexes. So: buffer a full index's rows across files into
large appends, and build the lookup indexes once after a full index rather
than maintaining them row by row. Edge identity needs a check that doesn't
scan all edges per batch (NOT EXISTS: 3.3 ms a batch at 338k edges).

From comparing with the journal (its notes: telemetry_journal/
DUCKDB_NOTES_FROM_CODEGRAPH.md): CodeGraph's readers load a whole
generation into memory (1.5 s and its memory for rene's index, per query
server), where the journal's readers query the sealed Parquet in place; for
CodeGraph's point lookups in-memory is the right trade, but it is a cost per
reader process to keep in mind.

Indexing cost on storage-parity's five projects: DuckDB 109 s user CPU
against SQLite's 34 s; peak memory about 5 GB on both (CodeGraph's parse
workers).

## Parity

Done when, against the SQLite baseline: CodeGraph's 7,010 tests give the same
results (6,652 pass, 358 skipped, 0 fail); indexing this repository gives
the same counts (5,239 files, 103,517 symbols, 337,714 links); and search,
callers, callees, impact and explore return the same answers on a fixed set
of queries. Measure elapsed time, CPU and peak memory before and after
(`run_command` with `measure`).
