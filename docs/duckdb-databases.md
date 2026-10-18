# DuckDB database snapshots

`inspect_duckdb_database` / `inspect-duckdb-database` inspects one explicitly
selected local DuckDB database and its sibling `<path>.wal`, through a
caller-supplied DuckDB 1.x CLI. Use it for application storage built on
DuckDB: telemetry stores, analytics caches, embedded time series.
`inspect_duckdb_client` / `inspect-duckdb-client` reports the selected CLI
and its version without opening a database.

REA does not install DuckDB. Put `duckdb` on `PATH`, or set `REA_DUCKDB_COMMAND`
to its absolute path. Use a CLI at least as new as the DuckDB that wrote the
file: an older one refuses a newer storage format, and REA reports that as an
unsupported target.

```sh
rea inspect-duckdb-client --json
rea inspect-duckdb-database ./telemetry.duckdb --json
rea inspect-duckdb-database ./telemetry.duckdb --table device_states \
  --column ts --column ieee --column numeric_val --row-limit 20 --summarize --json
```

```json
{
  "name": "inspect_duckdb_database",
  "arguments": {
    "path": "/artifacts/telemetry.duckdb",
    "table": "device_states",
    "summarize": true
  }
}
```

MCP paths must be absolute. Select a quiescent snapshot: stop the writer, or
copy the database and its WAL together while nothing writes. A file copy of a
live pair is not atomic, and REA refuses evidence when the WAL appears,
disappears or changes while it is being copied.

## Returned evidence

- **Identity**: path, size and SHA-256 of the database, and of the WAL when
  one exists.
- **Storage**: DuckDB's own size, block counts and WAL size for the file.
- **Schema**: every base table with DuckDB's row estimate, column count and
  primary-key flag; views, indexes and sequences by name. `schema_scope`
  works as for SQLite. `inventory`, the default without a table, omits
  columns. `selected_table`, the default with one, expands that table.
  `database` expands every table.
- **Rows** (with `table`): the first `row_limit` rows (default 20, at most 500)
  in storage order, for the selected `columns` in the order given, or every
  column. Each cell is DuckDB's text form of the value, or `null` for SQL
  NULL, cut at 4096 characters; `truncated_cells` counts the cuts.
  `row_count` is an exact count over the whole table.
- **Summary** (with `summarize`): DuckDB's `SUMMARIZE` over the whole table.
  It gives min, max, approximate distinct count (HyperLogLog), null
  percentage and count per column; min and max are cut at 256 characters.

`table` and `columns` are matched exactly against the database's own catalog
before any identifier reaches SQL. `schema` selects a non-`main` schema. Views
are refused by name, never executed.

## Isolation

The selected files are copied into an owned private directory, and the CLI
opens the copy, never the source. Each query runs as its own process:

- `-readonly`, so the WAL is replayed in memory and never checkpointed;
- with an empty init file and a private `HOME`, so no `~/.duckdbrc` or cached
  extension is read;
- with `enable_external_access`, extension autoload and autoinstall, and
  community extensions disabled, two threads and a 512 MB memory limit, and
  then `lock_configuration`, so no later statement can change any of them;
- under util-linux `prlimit` on Linux (2 GiB address space, 256 MiB per file,
  300 CPU seconds, no core dumps; override the limiter with an absolute
  `REA_DUCKDB_PRLIMIT_COMMAND`), or a 2 GiB Job Object on Windows.

Both copies are rehashed after the last query. If the CLI changed either one,
the result is refused as `artifact_changed`.

REA runs a fixed set of catalog, sample and `SUMMARIZE` queries. It does not
accept SQL from the caller, and does not repair, decrypt or migrate databases.
