// rene-history: the workbench's call history in one DuckDB file.
//
// The bridge starts one per history and is its only client, so this process
// is the file's single writer. Requests and responses are JSON lines on
// stdin and stdout:
//
//   {"id":1,"op":"record","summary":{...},"result":{...}|null}
//   {"id":2,"op":"import","entries":[{"summary":{...},"result":...}, ...]}
//   {"id":3,"op":"query","filter":{...}}   summaries only, newest first
//   {"id":4,"op":"result","key":"<entry id>"}
//   {"id":5,"op":"clear"}
//
// answered by {"id":n,"ok":true,"value":...} or {"id":n,"ok":false,"error":"..."}.
// A query's filter members are all optional and combine with AND: name,
// outcome, startedSince and startedBefore (startedAt bounds, inclusive),
// beforeId (ids strictly older, the paging cursor), evidence (entries whose
// summary lists any of these issued Evidence ids) and limit.
//
// Summaries and results are kept as the JSON text the bridge sent; the bridge
// (frontend/history.mjs) owns their shape. Only id, startedAt and name are
// read from a summary for keys and ordering, and outcome and evidence for
// filters. Closing stdin ends the process and closes the database cleanly.

use std::io::{self, BufRead, BufWriter, Write};

use duckdb::types::Value;
use duckdb::{params, params_from_iter, Connection, OptionalExt};
use serde::Deserialize;
use serde_json::value::RawValue;

const SCHEMA_VERSION: &str = "1";

/// A request; its id is read separately (IdOnly), so even a malformed
/// request is answered under it.
#[derive(Deserialize)]
struct Request {
    op: String,
    summary: Option<Box<RawValue>>,
    result: Option<Box<RawValue>>,
    entries: Option<Vec<Entry>>,
    key: Option<String>,
    #[serde(default)]
    filter: Filter,
}

/// Which summaries a query returns; every member narrows it.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Filter {
    name: Option<String>,
    outcome: Option<String>,
    started_since: Option<i64>,
    started_before: Option<i64>,
    before_id: Option<String>,
    evidence: Option<Vec<String>>,
    limit: Option<u32>,
}

/// The query's SQL and its parameters, in order.
fn query_sql(filter: &Filter) -> Result<(String, Vec<Value>), String> {
    let mut clauses = Vec::new();
    let mut values = Vec::new();
    if let Some(name) = &filter.name {
        clauses.push("name = ?");
        values.push(Value::Text(name.clone()));
    }
    if let Some(outcome) = &filter.outcome {
        clauses.push("json_extract_string(summary, '$.outcome') = ?");
        values.push(Value::Text(outcome.clone()));
    }
    if let Some(since) = filter.started_since {
        clauses.push("started_at >= ?");
        values.push(Value::BigInt(since));
    }
    if let Some(before) = filter.started_before {
        clauses.push("started_at <= ?");
        values.push(Value::BigInt(before));
    }
    if let Some(id) = &filter.before_id {
        clauses.push("id < ?");
        values.push(Value::Text(id.clone()));
    }
    if let Some(evidence) = &filter.evidence {
        // An empty list matches nothing, as "issued any of none" should.
        clauses.push(
            "list_has_any(json_extract_string(summary, '$.evidence[*]'), json_extract_string(?, '$[*]'))",
        );
        values.push(Value::Text(
            serde_json::to_string(evidence).map_err(|e| e.to_string())?,
        ));
    }
    let mut sql = String::from("SELECT summary FROM calls");
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY id DESC");
    if let Some(limit) = filter.limit {
        sql.push_str(" LIMIT ?");
        values.push(Value::BigInt(limit.into()));
    }
    Ok((sql, values))
}

/// Just a request's id, read before the rest is checked.
#[derive(Deserialize)]
struct IdOnly {
    id: u64,
}

#[derive(Deserialize)]
struct Entry {
    summary: Box<RawValue>,
    result: Option<Box<RawValue>>,
}

/// The fields of a summary the store keys and orders by.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Keys {
    id: String,
    started_at: i64,
    name: String,
}

type Outcome = Result<String, String>;

fn open(path: &str) -> Result<Connection, duckdb::Error> {
    let conn = Connection::open(path)?;
    // Bounded: the bridge runs this beside the agents it serves.
    conn.execute_batch(
        "SET memory_limit = '256MB';
         SET threads = 2;
         CREATE TABLE IF NOT EXISTS meta (key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL);
         CREATE TABLE IF NOT EXISTS calls (
           id VARCHAR PRIMARY KEY,
           started_at BIGINT NOT NULL,
           name VARCHAR NOT NULL,
           summary VARCHAR NOT NULL,
           result VARCHAR
         );",
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO meta VALUES ('schema_version', ?)",
        params![SCHEMA_VERSION],
    )?;
    Ok(conn)
}

fn keys(summary: &RawValue) -> Result<Keys, String> {
    serde_json::from_str(summary.get()).map_err(|e| format!("summary: {e}"))
}

/// Stores one entry; an existing id is replaced, or kept when `keep_existing`.
/// Returns the rows written: 0 when an existing entry was kept.
fn store(conn: &Connection, entry: &Entry, keep_existing: bool) -> Result<usize, String> {
    let k = keys(&entry.summary)?;
    let sql = if keep_existing {
        "INSERT OR IGNORE INTO calls VALUES (?, ?, ?, ?, ?)"
    } else {
        "INSERT OR REPLACE INTO calls VALUES (?, ?, ?, ?, ?)"
    };
    let result = entry.result.as_ref().map(|raw| raw.get());
    conn.execute(sql, params![k.id, k.started_at, k.name, entry.summary.get(), result])
        .map_err(|e| e.to_string())
}

fn handle(conn: &Connection, request: Request) -> Outcome {
    let db = |e: duckdb::Error| e.to_string();
    match request.op.as_str() {
        "record" => {
            let summary = request.summary.ok_or("record needs a summary")?;
            store(conn, &Entry { summary, result: request.result }, false).map(|_| "null".into())
        }
        "import" => {
            // One transaction: an import lands whole or not at all.
            let entries = request.entries.ok_or("import needs entries")?;
            conn.execute_batch("BEGIN TRANSACTION").map_err(db)?;
            let mut added = 0usize;
            for entry in &entries {
                match store(conn, entry, true) {
                    Ok(rows) => added += rows,
                    Err(e) => {
                        conn.execute_batch("ROLLBACK").map_err(db)?;
                        return Err(e);
                    }
                }
            }
            conn.execute_batch("COMMIT").map_err(db)?;
            Ok(format!("{{\"added\":{added},\"total\":{}}}", count(conn).map_err(db)?))
        }
        "query" => {
            let (sql, values) = query_sql(&request.filter)?;
            let mut statement = conn.prepare(&sql).map_err(db)?;
            let rows = statement
                .query_map(params_from_iter(values), |row| row.get::<_, String>(0))
                .map_err(db)?;
            let mut out = String::from("[");
            for (index, row) in rows.enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&row.map_err(db)?);
            }
            out.push(']');
            Ok(out)
        }
        "result" => {
            let key = request.key.ok_or("result needs a key")?;
            let found: Option<Option<String>> = conn
                .query_row("SELECT result FROM calls WHERE id = ?", params![key], |row| row.get(0))
                .optional()
                .map_err(db)?;
            Ok(found.flatten().unwrap_or_else(|| "null".into()))
        }
        "count" => Ok(count(conn).map_err(db)?.to_string()),
        "clear" => {
            conn.execute("DELETE FROM calls", []).map_err(db)?;
            Ok("null".into())
        }
        other => Err(format!("unknown op {other:?}")),
    }
}

fn count(conn: &Connection) -> Result<i64, duckdb::Error> {
    conn.query_row("SELECT count(*) FROM calls", [], |row| row.get(0))
}

fn main() {
    let path = match std::env::args().nth(1) {
        Some(path) => path,
        None => {
            eprintln!("usage: rene-history <database file>");
            std::process::exit(2);
        }
    };
    let conn = match open(&path) {
        Ok(conn) => conn,
        Err(e) => {
            eprintln!("rene-history: cannot open {path}: {e}");
            std::process::exit(1);
        }
    };
    let version: String = conn
        .query_row("SELECT version()", [], |row| row.get(0))
        .unwrap_or_else(|_| "unknown".into());
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    let ready = serde_json::json!({ "ready": true, "duckdb": version, "schema": SCHEMA_VERSION });
    if writeln!(out, "{ready}").and_then(|_| out.flush()).is_err() {
        return;
    }
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        // A request that names its id is always answered under it, even when
        // the rest of it is malformed, so the bridge never waits on it.
        let id = serde_json::from_str::<IdOnly>(&line).ok().map(|only| only.id);
        let outcome = serde_json::from_str::<Request>(&line)
            .map_err(|e| format!("bad request: {e}"))
            .and_then(|request| handle(&conn, request));
        let id = id.map_or_else(|| "null".to_string(), |id| id.to_string());
        let response = match outcome {
            Ok(value) => format!("{{\"id\":{id},\"ok\":true,\"value\":{value}}}"),
            Err(error) => format!(
                "{{\"id\":{id},\"ok\":false,\"error\":{}}}",
                serde_json::to_string(&error).unwrap_or_else(|_| "\"error\"".into())
            ),
        };
        if writeln!(out, "{response}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}
