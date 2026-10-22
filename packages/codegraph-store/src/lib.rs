//! CodeGraph's index in DuckDB, reached synchronously from Node.
//!
//! A `Store` is one in-memory DuckDB. The writer (CodeGraph's indexer) keeps
//! the working index in one and `seal`s it: every table is written as a
//! Parquet file in a new generation directory, and `manifest.json` is
//! replaced, by rename, to name it. Readers `load` the generation the
//! manifest names into their own Store. No database file is shared, so no
//! process ever waits on another's lock (DESIGN.md).
//!
//! The calls block the calling thread, as node:sqlite does today: CodeGraph's
//! storage layer is synchronous.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use duckdb::types::{Value, ValueRef};
use duckdb::{appender_params_from_iter, params_from_iter, Connection};
use napi::{Error, Result, Status};
use napi_derive::napi;
use serde_json::{json, Map, Number, Value as Json};

mod wal;

/// The file a store directory's current generation is named in.
const MANIFEST: &str = "manifest.json";
/// Generations kept besides the current one, for readers still loading them.
const GENERATIONS_KEPT: usize = 2;

fn failure(cause: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, cause.to_string())
}

/// A JSON parameter as a DuckDB value.
fn parameter(value: &Json) -> Result<Value> {
    Ok(match value {
        Json::Null => Value::Null,
        Json::Bool(flag) => Value::Boolean(*flag),
        Json::Number(number) => match number.as_i64() {
            Some(integer) => Value::BigInt(integer),
            None => Value::Double(
                number
                    .as_f64()
                    .ok_or_else(|| failure("parameter out of range"))?,
            ),
        },
        Json::String(text) => Value::Text(text.clone()),
        other => return Err(failure(format!("unsupported parameter {other}"))),
    })
}

/// One column value as JSON; types CodeGraph doesn't store become text.
fn cell(value: ValueRef<'_>) -> Json {
    let number = |n: f64| Number::from_f64(n).map_or(Json::Null, Json::Number);
    match value {
        ValueRef::Null => Json::Null,
        ValueRef::Boolean(flag) => Json::Bool(flag),
        ValueRef::TinyInt(n) => Json::from(n),
        ValueRef::SmallInt(n) => Json::from(n),
        ValueRef::Int(n) => Json::from(n),
        ValueRef::BigInt(n) => Json::from(n),
        ValueRef::UTinyInt(n) => Json::from(n),
        ValueRef::USmallInt(n) => Json::from(n),
        ValueRef::UInt(n) => Json::from(n),
        ValueRef::UBigInt(n) => Json::from(n),
        ValueRef::HugeInt(n) => {
            i64::try_from(n).map_or_else(|_| Json::String(n.to_string()), Json::from)
        }
        ValueRef::Float(n) => number(f64::from(n)),
        ValueRef::Double(n) => number(n),
        // A DECIMAL (a literal such as 1.0 is one) is a number to SQLite and
        // its callers: its exact text, rounded once to the nearest double.
        ValueRef::Decimal(n) => n.to_string().parse::<f64>().map_or(Json::Null, number),
        ValueRef::Text(bytes) => Json::String(String::from_utf8_lossy(bytes).into_owned()),
        other => Json::String(format!("{:?}", other.to_owned())),
    }
}

/// SQL string literal: DuckDB's COPY and read_parquet take paths as literals.
fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// A table name as a quoted identifier.
fn identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Writes `bytes` to `path` durably: a temporary file, fsynced, renamed into
/// place, and the directory fsynced so the rename survives power loss.
fn write_durably(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = File::create(&temporary).map_err(failure)?;
    file.write_all(bytes).map_err(failure)?;
    file.sync_all().map_err(failure)?;
    fs::rename(&temporary, path).map_err(failure)?;
    if let Some(directory) = path.parent() {
        File::open(directory).and_then(|d| d.sync_all()).map_err(failure)?;
    }
    Ok(())
}

/// The manifest in `directory`, or None when no generation was sealed yet.
fn read_manifest(directory: &Path) -> Result<Option<Json>> {
    match fs::read_to_string(directory.join(MANIFEST)) {
        Ok(text) => Ok(Some(serde_json::from_str(&text).map_err(failure)?)),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(cause) => Err(failure(cause)),
    }
}

/// Threads each in-memory database may use (CODEGRAPH_STORE_THREADS, default 1).
/// DuckDB's default is one per core, and CodeGraph opens many databases (one
/// per index, per process, and per test): pools of about 22 threads each
/// exhausted the container's thread limit. CodeGraph's queries are small, so
/// one thread loses little; set more for a process doing heavy analysis.
fn open_database() -> Result<Connection> {
    let threads = std::env::var("CODEGRAPH_STORE_THREADS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|&threads| threads > 0)
        .unwrap_or(1);
    // NULL sorts as SQLite sorted it, smallest: first ascending, last
    // descending. DuckDB's default (last either way) reordered every
    // `ORDER BY line, col` with an edge that has no line.
    let config = duckdb::Config::default()
        .threads(threads)
        .map_err(failure)?
        .with("default_null_order", "nulls_first_on_asc_last_on_desc")
        .map_err(failure)?;
    Connection::open_in_memory_with_flags(config).map_err(failure)
}

/// One in-memory database per name in this process, so CodeGraph's worker
/// threads (extraction's store worker, resolution's workers) each get their
/// own connection to the database the main thread seals. DuckDB connections
/// to one database are safe to use from different threads.
/// A database's log, shared by its connections; None until `log_to`.
type SharedLog = Arc<Mutex<Option<wal::LogFile>>>;

/// What a database holds from disk: the generation loaded and how far into
/// its log, and the manifest as last seen. One per database, shared by its
/// connections, so the log is applied once however many threads read.
#[derive(Default)]
struct Follow {
    position: (u64, u64),
    manifest_seen: Option<(u64, std::time::SystemTime)>,
}
type SharedFollow = Arc<Mutex<Follow>>;

/// Writes the database has taken, from any connection or a replayed log:
/// its change stamp, so a cache of what it held can tell it is stale.
type SharedWrites = Arc<AtomicU64>;

type SharedDatabase = (Connection, SharedLog, SharedFollow, SharedWrites);

fn shared_databases() -> &'static Mutex<HashMap<String, SharedDatabase>> {
    static DATABASES: OnceLock<Mutex<HashMap<String, SharedDatabase>>> = OnceLock::new();
    DATABASES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[napi]
pub struct Store {
    connection: Connection,
    /// The database's write-ahead log, shared with its other connections.
    log: SharedLog,
    /// This connection's open transaction, written to the log at COMMIT.
    pending: RefCell<Vec<String>>,
    in_transaction: Cell<bool>,
    /// Whether this connection's writes go to the log (`set_logging`).
    log_writes: Cell<bool>,
    /// What the database holds from disk, shared with its other connections.
    follow_state: SharedFollow,
    /// The store directory a reader follows (`follow`), if any.
    following: RefCell<Option<PathBuf>>,
    /// The database's write count, shared with its other connections.
    writes: SharedWrites,
}

#[napi]
impl Store {
    /// An empty in-memory database.
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        Ok(Store {
            connection: open_database()?,
            log: Arc::new(Mutex::new(None)),
            pending: RefCell::new(Vec::new()),
            in_transaction: Cell::new(false),
            log_writes: Cell::new(true),
            follow_state: Arc::new(Mutex::new(Follow::default())),
            following: RefCell::new(None),
            writes: Arc::new(AtomicU64::new(0)),
        })
    }

    /// A connection to the in-memory database named `name` in this process,
    /// created empty on first use; the first opener sees no tables and sets
    /// it up (schema, then the sealed generation).
    #[napi(factory)]
    pub fn shared(name: String) -> Result<Self> {
        let mut databases = shared_databases().lock().map_err(failure)?;
        let (first, log, follow, writes) = match databases.get(&name) {
            Some(entry) => entry,
            None => {
                let created = open_database()?;
                databases.entry(name).or_insert((
                    created,
                    Arc::new(Mutex::new(None)),
                    Arc::new(Mutex::new(Follow::default())),
                    Arc::new(AtomicU64::new(0)),
                ))
            }
        };
        Ok(Store {
            connection: first.try_clone().map_err(failure)?,
            log: log.clone(),
            pending: RefCell::new(Vec::new()),
            in_transaction: Cell::new(false),
            log_writes: Cell::new(true),
            follow_state: follow.clone(),
            following: RefCell::new(None),
            writes: writes.clone(),
        })
    }

    /// Drops the process's own handle on the shared database `name`; it is
    /// freed once every connection to it has closed.
    #[napi]
    pub fn release_shared(name: String) -> Result<bool> {
        Ok(shared_databases().lock().map_err(failure)?.remove(&name).is_some())
    }

    /// Logs every committed write from now on to the write-ahead log of the
    /// generation `directory`'s manifest names: the writer's durability.
    #[napi]
    pub fn log_to(&self, directory: String) -> Result<()> {
        let root = PathBuf::from(&directory);
        let generation = read_manifest(&root)?
            .and_then(|manifest| manifest["generation"].as_u64())
            .unwrap_or(0);
        {
            let mut log = self.log.lock().map_err(failure)?;
            // Already logging in this process (CodeGraph reopened the index):
            // the log and its lock stay; another process is refused by the lock.
            if log.is_some() {
                return Ok(());
            }
            *log = Some(wal::LogFile::open(&root, generation).map_err(failure)?);
        }
        // A writer's writes start with the schema they are made against.
        self.write_group(&[json!({ "op": "schema", "schema": self.schema()? }).to_string()])
    }

    /// Records one write: inside a transaction it waits for COMMIT, else it
    /// is committed to the log now.
    fn record(&self, record: Json) -> Result<()> {
        if self.in_transaction.get() {
            self.pending.borrow_mut().push(record.to_string());
            return Ok(());
        }
        self.write_group(&[record.to_string()])
    }

    fn logging(&self) -> Result<bool> {
        Ok(self.log.lock().map_err(failure)?.is_some())
    }

    /// Turns this connection's logging off or on: off for writes to its own
    /// TEMP objects, which a replay elsewhere couldn't reproduce, and on
    /// again for durable writes, which must be self-contained statements.
    #[napi]
    pub fn set_logging(&self, enabled: bool) {
        self.log_writes.set(enabled);
    }

    /// Runs one write and records it. Outside a transaction, with a log, the
    /// two commit together: if the log can't take the record (a full disk),
    /// the change rolls back, so memory never holds what the disk doesn't.
    fn write_logged<T>(&self, write: impl FnOnce() -> Result<T>, record: Json) -> Result<T> {
        self.wrote();
        if !self.log_writes.get() {
            return write();
        }
        if self.in_transaction.get() || !self.logging()? {
            let value = write()?;
            self.record(record)?;
            return Ok(value);
        }
        self.connection.execute_batch("begin transaction").map_err(failure)?;
        let outcome = write().and_then(|value| self.write_group(&[record.to_string()]).map(|()| value));
        match outcome {
            Ok(value) => {
                self.connection.execute_batch("commit").map_err(failure)?;
                Ok(value)
            }
            Err(cause) => {
                let _ = self.connection.execute_batch("rollback");
                Err(cause)
            }
        }
    }

    /// Whether this process writes the database (its log is open here): its
    /// readers must then use the live database, not the sealed files.
    #[napi]
    pub fn is_writer(&self) -> Result<bool> {
        self.logging()
    }

    fn wrote(&self) {
        self.writes.fetch_add(1, Ordering::SeqCst);
    }

    /// A value that differs whenever the database may hold something it did
    /// not before: its write count (its own, other connections', replayed),
    /// after catching up with the writer it follows. A cache of answers kept
    /// under one stamp is never stale.
    #[napi]
    pub fn change_stamp(&self) -> Result<f64> {
        self.catch_up()?;
        Ok(self.writes.load(Ordering::SeqCst) as f64)
    }

    /// Bytes in the log: the writer seals when this passes its limit.
    #[napi]
    pub fn log_bytes(&self) -> Result<f64> {
        Ok(self.log.lock().map_err(failure)?.as_ref().map_or(0, |log| log.bytes()) as f64)
    }

    fn write_group(&self, records: &[String]) -> Result<()> {
        match self.log.lock().map_err(failure)?.as_mut() {
            Some(log) => log.write_group(records).map_err(failure),
            None => Ok(()),
        }
    }

    /// Runs one or more statements that return no rows. BEGIN, COMMIT and
    /// ROLLBACK also open, write and drop the log's transaction: a commit
    /// returns once its writes are fsynced.
    #[napi]
    pub fn exec(&self, sql: String) -> Result<()> {
        let keyword = first_keyword(&sql);
        match keyword.as_str() {
            "BEGIN" => {
                self.connection.execute_batch(&sql).map_err(failure)?;
                self.pending.borrow_mut().clear();
                self.in_transaction.set(true);
                Ok(())
            }
            "COMMIT" | "END" => {
                self.in_transaction.set(false);
                let records = std::mem::take(&mut *self.pending.borrow_mut());
                self.write_group(&records)?;
                self.connection.execute_batch(&sql).map_err(failure)
            }
            "ROLLBACK" => {
                self.wrote();
                self.in_transaction.set(false);
                self.pending.borrow_mut().clear();
                self.connection.execute_batch(&sql).map_err(failure)
            }
            _ if is_write(&keyword) => self.write_logged(
                || self.connection.execute_batch(&sql).map_err(failure),
                json!({ "op": "exec", "sql": sql }),
            ),
            _ => self.connection.execute_batch(&sql).map_err(failure),
        }
    }

    /// Runs one statement with JSON-array parameters; the rows it changed.
    #[napi]
    pub fn run(&self, sql: String, parameters: String) -> Result<i64> {
        let raw: Vec<Json> = serde_json::from_str(&parameters).map_err(failure)?;
        let values = raw.iter().map(parameter).collect::<Result<Vec<_>>>()?;
        let execute = || -> Result<i64> {
            let mut statement = self.connection.prepare(&sql).map_err(failure)?;
            Ok(statement.execute(params_from_iter(values)).map_err(failure)? as i64)
        };
        if is_write(&first_keyword(&sql)) {
            self.write_logged(execute, json!({ "op": "run", "sql": sql, "params": raw }))
        } else {
            self.catch_up()?;
            execute()
        }
    }

    /// Runs one query with JSON-array parameters; its rows as a JSON array of
    /// objects. A write run this way (INSERT … RETURNING) is logged too.
    #[napi]
    pub fn query(&self, sql: String, parameters: String) -> Result<String> {
        let raw: Vec<Json> = serde_json::from_str(&parameters).map_err(failure)?;
        if is_write(&first_keyword(&sql)) {
            let record = json!({ "op": "run", "sql": sql, "params": raw.clone() });
            return self.write_logged(|| self.rows(&sql, &raw), record);
        }
        self.catch_up()?;
        self.rows(&sql, &raw)
    }

    fn rows(&self, sql: &str, raw: &[Json]) -> Result<String> {
        let values = raw.iter().map(parameter).collect::<Result<Vec<_>>>()?;
        let mut statement = self.connection.prepare(sql).map_err(failure)?;
        let mut rows = statement.query(params_from_iter(values)).map_err(failure)?;
        let names: Vec<String> = rows
            .as_ref()
            .map(|statement| statement.column_names())
            .unwrap_or_default();
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(failure)? {
            let mut object = Map::with_capacity(names.len());
            for (index, name) in names.iter().enumerate() {
                object.insert(name.clone(), cell(row.get_ref(index).map_err(failure)?));
            }
            out.push(Json::Object(object));
        }
        serde_json::to_string(&out).map_err(failure)
    }

    /// Appends rows (a JSON array of arrays, in the table's column order) with
    /// DuckDB's native Appender: the bulk write path, never row-by-row SQL.
    #[napi]
    pub fn append(&self, table: String, rows: String) -> Result<u32> {
        let parsed: Vec<Vec<Json>> = serde_json::from_str(&rows).map_err(failure)?;
        let count = parsed.len() as u32;
        let record = json!({ "op": "append", "table": table, "rows": parsed });
        self.write_logged(|| self.append_rows(&table, record["rows"].as_array().map(|rows| {
            rows.iter().map(|row| row.as_array().cloned().unwrap_or_default()).collect::<Vec<_>>()
        }).as_deref().unwrap_or(&[])), record.clone())?;
        Ok(count)
    }

    fn append_rows(&self, table: &str, rows: &[Vec<Json>]) -> Result<()> {
        let mut appender = self.connection.appender(table).map_err(failure)?;
        for row in rows {
            let values = row.iter().map(parameter).collect::<Result<Vec<_>>>()?;
            appender
                .append_row(appender_params_from_iter(values))
                .map_err(failure)?;
        }
        appender.flush().map_err(failure)
    }

    /// Applies one logged write, unlogged: replay after a load.
    fn apply(&self, record: &Json) -> Result<()> {
        self.wrote();
        match record["op"].as_str() {
            Some("exec") => self
                .connection
                .execute_batch(record["sql"].as_str().unwrap_or(""))
                .map_err(failure),
            Some("run") => {
                let values = record["params"]
                    .as_array()
                    .map(|params| params.iter().map(parameter).collect::<Result<Vec<_>>>())
                    .transpose()?
                    .unwrap_or_default();
                let mut statement = self
                    .connection
                    .prepare(record["sql"].as_str().unwrap_or(""))
                    .map_err(failure)?;
                statement.execute(params_from_iter(values)).map_err(failure)?;
                Ok(())
            }
            Some("append") => {
                let rows: Vec<Vec<Json>> =
                    serde_json::from_value(record["rows"].clone()).map_err(failure)?;
                self.append_rows(record["table"].as_str().unwrap_or(""), &rows)
            }
            // A load checked it before anything changed; a follower checks it
            // here, as a writer of another schema starts.
            Some("schema") if record["schema"] == self.schema()? => Ok(()),
            Some("schema") => Err(failure("schema mismatch: the log was written against another schema")),
            other => Err(failure(format!("unknown log record {other:?}"))),
        }
    }

    /// Seals every table into a new generation under `directory` and
    /// publishes it in the manifest; returns the generation's number. Older
    /// generations beyond the few kept for readers are removed.
    #[napi]
    pub fn seal(&self, directory: String, layout: Option<String>) -> Result<u32> {
        // How the sealed files are laid out for readers that query them in
        // place: {"order": {table: expression}, "parquet": "writer options"}.
        // Rows sorted by the key a table is looked up by, with dictionaries
        // (and so bloom filters) on its keys, let a reader skip row groups.
        let layout: Json = match layout {
            Some(text) => serde_json::from_str(&text).map_err(failure)?,
            None => Json::Null,
        };
        let row_groups = layout["parquet"]
            .as_str()
            .map_or(String::new(), |options| format!(", {options}"));
        let root = PathBuf::from(&directory);
        fs::create_dir_all(&root).map_err(failure)?;
        let previous = read_manifest(&root)?
            .and_then(|manifest| manifest["generation"].as_u64())
            .unwrap_or(0);
        let generation = previous + 1;
        let folder = root.join(format!("g{generation:08}"));
        fs::create_dir_all(&folder).map_err(failure)?;
        let tables = self.own_tables()?;
        let mut entries = Map::new();
        for table in &tables {
            let file = folder.join(format!("{table}.parquet"));
            self.connection
                .execute_batch(&format!(
                    "copy (select * from {}{}) to {} (format parquet, compression zstd{})",
                    identifier(table),
                    layout["order"][table.as_str()]
                        .as_str()
                        .map_or(String::new(), |order| format!(" order by {order}")),
                    literal(&file.to_string_lossy()),
                    row_groups,
                ))
                .map_err(failure)?;
            File::open(&file).and_then(|f| f.sync_all()).map_err(failure)?;
            let rows: i64 = self
                .connection
                .query_row(&format!("select count(*) from {}", identifier(table)), [], |row| {
                    row.get(0)
                })
                .map_err(failure)?;
            entries.insert(table.clone(), json!({ "file": format!("{table}.parquet"), "rows": rows }));
        }
        File::open(&folder).and_then(|d| d.sync_all()).map_err(failure)?;
        let manifest = json!({
            "generation": generation,
            "folder": folder.file_name().map(|name| name.to_string_lossy().into_owned()),
            "tables": entries,
        });
        write_durably(
            &root.join(MANIFEST),
            serde_json::to_string_pretty(&manifest).map_err(failure)?.as_bytes(),
        )?;
        {
            let mut log = self.log.lock().map_err(failure)?;
            if let Some(current) = log.take() {
                *log = Some(current.rotate(&root, generation).map_err(failure)?);
                wal::remove_logs_before(&root, generation);
            }
        }
        // Generations older than those kept are no longer named anywhere.
        let mut folders: Vec<_> = fs::read_dir(&root)
            .map_err(failure)?
            .filter_map(|entry| entry.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .filter(|name| name.starts_with('g') && name[1..].chars().all(|c| c.is_ascii_digit()))
            .collect();
        folders.sort();
        let removable = folders.len().saturating_sub(GENERATIONS_KEPT + 1);
        for old in &folders[..removable] {
            let _ = fs::remove_dir_all(root.join(old));
        }
        Ok(generation as u32)
    }

    /// Loads the generation `directory`'s manifest names; returns its number,
    /// or 0 when none was sealed yet. A table that already exists (created by
    /// the schema, with its keys, defaults and sequences) is refilled in
    /// place; any other is created from the sealed file.
    #[napi]
    pub fn load(&self, directory: String) -> Result<u32> {
        let mut state = self.follow_state.lock().map_err(failure)?;
        // This process writes the database: what it holds is newer than disk,
        // and a reload would throw its unsealed work away.
        if self.logging()? {
            return Ok(state.position.0 as u32);
        }
        self.reload(&PathBuf::from(&directory), &mut state)
    }

    /// Replaces the database's tables with the sealed generation and its log.
    fn reload(&self, root: &Path, state: &mut Follow) -> Result<u32> {
        self.wrote();
        let root = root.to_path_buf();
        let Some(manifest) = read_manifest(&root)? else {
            self.check_schema(&root, &[], &[], 0)?;
            let offset = self.replay(&root, 0, 0)?;
            state.position = (0, offset);
            return Ok(0);
        };
        let folder = root.join(
            manifest["folder"]
                .as_str()
                .ok_or_else(|| failure("manifest names no folder"))?,
        );
        let tables = manifest["tables"]
            .as_object()
            .ok_or_else(|| failure("manifest names no tables"))?;
        let existing = self.own_tables()?;
        let mut sealed = Vec::new();
        for (table, entry) in tables {
            let file = folder.join(
                entry["file"]
                    .as_str()
                    .ok_or_else(|| failure(format!("manifest names no file for {table}")))?,
            );
            sealed.push((table.clone(), file));
        }
        let generation = manifest["generation"].as_u64().unwrap_or(0);
        // Nothing changes until the generation and its log are known to fit
        // the tables they would fill.
        self.check_schema(&root, &sealed, &existing, generation)?;
        let mut sql = String::from("begin transaction;");
        for (table, file) in &sealed {
            let (name, path) = (identifier(table), literal(&file.to_string_lossy()));
            sql.push_str(&if existing.contains(table) {
                format!("delete from {name}; insert into {name} select * from read_parquet({path});")
            } else {
                format!("create table {name} as select * from read_parquet({path});")
            });
        }
        sql.push_str("commit;");
        self.connection.execute_batch(&sql).map_err(failure)?;
        self.advance_sequences()?;
        let offset = self.replay(&root, generation, 0)?;
        state.position = (generation, offset);
        Ok(generation as u32)
    }

    /// The database's own tables, by name: not a connection's TEMP objects
    /// (a synthesis stage's), which live in schema `main` of catalog `temp`.
    fn own_tables(&self) -> Result<Vec<String>> {
        let mut statement = self
            .connection
            .prepare(
                "select table_name from duckdb_tables() \
                 where database_name = current_database() and schema_name = 'main' order by table_name",
            )
            .map_err(failure)?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(failure)?;
        names.collect::<std::result::Result<_, _>>().map_err(failure)
    }

    /// A relation's columns, name and type, as DESCRIBE prints them: a table
    /// and a sealed file are described alike, so they compare.
    fn described(&self, relation: &str) -> Result<Vec<(String, String)>> {
        let mut statement = self
            .connection
            .prepare(&format!("describe select * from {relation}"))
            .map_err(failure)?;
        let columns = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(failure)?;
        columns.collect::<std::result::Result<_, _>>().map_err(failure)
    }

    /// The schema writes are made against: each own table's columns. A log
    /// opens with it, so a replay can tell a log of another schema.
    fn schema(&self) -> Result<Json> {
        let mut tables = Vec::new();
        for table in self.own_tables()? {
            let columns = self.described(&identifier(&table))?;
            tables.push(json!([table, columns]));
        }
        Ok(Json::Array(tables))
    }

    /// Fails with "schema mismatch" when a sealed file of a table the schema
    /// defines has other columns than the table, or the log was written
    /// against another schema: positional loads and replayed statements
    /// would put values in the wrong columns or fail part-way. The caller
    /// decides; an index derived from source can be rebuilt.
    fn check_schema(&self, root: &Path, sealed: &[(String, PathBuf)], existing: &[String], generation: u64) -> Result<()> {
        let mut differences = Vec::new();
        for (table, file) in sealed {
            if !existing.contains(table) {
                continue;
            }
            let now = self.described(&identifier(table))?;
            let then = self.described(&format!("read_parquet({})", literal(&file.to_string_lossy())))?;
            if now != then {
                differences.push(format!("{table} was sealed with columns {then:?}, the schema now has {now:?}"));
            }
        }
        let (groups, _) = wal::committed_groups_from(root, generation, 0).map_err(failure)?;
        let current = self.schema()?;
        if groups.iter().flatten().any(|record| record["op"] == "schema" && record["schema"] != current) {
            differences.push("the log was written against another schema".to_string());
        }
        if differences.is_empty() {
            Ok(())
        } else {
            Err(failure(format!("schema mismatch: {}", differences.join("; "))))
        }
    }

    /// After loading, each sequence a column defaults from is advanced past
    /// the largest value in that column, so a writer resuming from a sealed
    /// generation doesn't hand out ids already used. DuckDB has no setval and
    /// won't replace a sequence a default depends on, so the sequence draws
    /// the values it is behind by, in one vectorised query.
    fn advance_sequences(&self) -> Result<()> {
        let defaults: Vec<(String, String, String)> = {
            let mut statement = self
                .connection
                .prepare(
                    "select table_name, column_name, regexp_extract(column_default, 'nextval\\(''([^'']+)''', 1) from duckdb_columns() where database_name = current_database() and schema_name = 'main' and column_default like 'nextval(%'",
                )
                .map_err(failure)?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(failure)?;
            rows.collect::<std::result::Result<_, _>>().map_err(failure)?
        };
        for (table, column, sequence) in defaults {
            if sequence.is_empty() {
                continue;
            }
            let largest: i64 = self
                .connection
                .query_row(
                    &format!("select coalesce(max({}), 0) from {}", identifier(&column), identifier(&table)),
                    [],
                    |row| row.get(0),
                )
                .map_err(failure)?;
            // currval fails until the sequence has been drawn from: it is then at 0.
            let current: i64 = self
                .connection
                .query_row(&format!("select currval({})", literal(&sequence)), [], |row| row.get(0))
                .unwrap_or(0);
            if largest > current {
                self.connection
                    .query_row(
                        &format!("select max(nextval({})) from range({})", literal(&sequence), largest - current),
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(failure)?;
            }
        }
        Ok(())
    }
}

#[napi]
impl Store {
    /// Follows `directory` from now on, as a reader: before each query, the
    /// writer's newly committed groups are applied, or the store reloads when
    /// a newer generation has been sealed.
    #[napi]
    pub fn follow(&self, directory: String) -> Result<()> {
        *self.following.borrow_mut() = Some(PathBuf::from(directory));
        self.follow_state.lock().map_err(failure)?.manifest_seen = None;
        Ok(())
    }

    /// A reader's catch-up: nothing when neither the manifest nor the log has
    /// changed (two stats), new groups when only the log grew, a reload when
    /// the manifest names another generation (a seal, or its log gone).
    fn catch_up(&self) -> Result<()> {
        let Some(root) = self.following.borrow().clone() else { return Ok(()) };
        // This process writes the database: it already holds every change.
        if self.logging()? {
            return Ok(());
        }
        // One catch-up at a time per database: its connections share where it is.
        let mut state = self.follow_state.lock().map_err(failure)?;
        let (generation, offset) = state.position;
        let seen = fs::metadata(root.join(MANIFEST))
            .ok()
            .and_then(|meta| Some((meta.len(), meta.modified().ok()?)));
        if seen != state.manifest_seen {
            state.manifest_seen = seen;
            let published = read_manifest(&root)?
                .and_then(|manifest| manifest["generation"].as_u64())
                .unwrap_or(0);
            if published != generation {
                self.reload(&root, &mut state)?;
                return Ok(());
            }
        }
        let length = fs::metadata(wal::log_path(&root, generation)).map_or(offset, |meta| meta.len());
        if length > offset {
            let reached = self.replay(&root, generation, offset)?;
            state.position = (generation, reached);
        }
        Ok(())
    }

    /// Replays the intact committed groups of generation `generation`'s log
    /// from byte `offset`, each in its own transaction, and returns where they
    /// end; a group that fails rolls back and stops replay with its error.
    fn replay(&self, root: &Path, generation: u64, offset: u64) -> Result<u64> {
        let (groups, reached) = wal::committed_groups_from(root, generation, offset).map_err(failure)?;
        for group in &groups {
            self.connection.execute_batch("begin transaction").map_err(failure)?;
            for record in group {
                if let Err(cause) = self.apply(record) {
                    let _ = self.connection.execute_batch("rollback");
                    return Err(cause);
                }
            }
            self.connection.execute_batch("commit").map_err(failure)?;
        }
        Ok(reached)
    }
}

/// A statement's first keyword, upper-cased.
fn first_keyword(sql: &str) -> String {
    sql.trim_start()
        .split(|c: char| !c.is_ascii_alphabetic())
        .next()
        .unwrap_or("")
        .to_ascii_uppercase()
}

/// Whether a statement changes the database, and so belongs in the log.
fn is_write(keyword: &str) -> bool {
    !matches!(keyword, "" | "SELECT" | "WITH" | "PRAGMA" | "EXPLAIN" | "DESCRIBE" | "SHOW" | "SUMMARIZE" | "FROM" | "VALUES")
}

/// The generation `directory`'s manifest names, or 0: how a reader sees
/// that the writer sealed a newer one, without loading anything.
#[napi]
pub fn sealed_generation(directory: String) -> Result<u32> {
    Ok(read_manifest(Path::new(&directory))?
        .and_then(|manifest| manifest["generation"].as_u64())
        .unwrap_or(0) as u32)
}
