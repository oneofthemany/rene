//! The write-ahead log: every committed write reaches disk before its commit
//! returns, and readers follow it (DESIGN.md, Failure modes).
//!
//! One JSON record per line: `{"op":"exec","sql":…}`, `{"op":"run","sql":…,
//! "params":[…]}`, `{"op":"append","table":…,"rows":[[…]]}`, and
//! `{"op":"commit","count":n,"check":"…"}`, which closes a group of `n`
//! records and carries a checksum of them. Replay applies only complete,
//! intact groups: a write torn by a crash ends the log; a group whose
//! checksum doesn't match is corruption, reported, never applied.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value as Json};

/// The log that follows generation `generation` in `directory`.
pub fn log_path(directory: &Path, generation: u64) -> PathBuf {
    directory.join(format!("wal-g{generation:08}.log"))
}

/// FNV-1a over a group's record lines: cheap, and enough to tell a group
/// that was written whole from one that wasn't.
fn checksum(records: &[String]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for record in records {
        for byte in record.bytes().chain(std::iter::once(b'\n')) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("{hash:016x}")
}

/// The log file of one database, shared by its connections.
pub struct LogFile {
    file: File,
    /// Held for as long as this process logs: one writer per store.
    _lock: File,
    bytes: u64,
}

impl LogFile {
    /// Takes the store's writer lock and opens (appending) the log for
    /// `generation`. Another process logging to the store is refused.
    pub fn open(directory: &Path, generation: u64) -> std::io::Result<Self> {
        fs::create_dir_all(directory)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(directory.join("writer.lock"))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    format!(
                        "another process is writing this index ({}); one writer at a time",
                        directory.display()
                    ),
                ))
            }
            Err(TryLockError::Error(cause)) => return Err(cause),
        }
        Self::reopen(directory, generation, lock)
    }

    /// The log for `generation`, keeping the lock already held.
    pub fn rotate(self, directory: &Path, generation: u64) -> std::io::Result<Self> {
        Self::reopen(directory, generation, self._lock)
    }

    fn reopen(directory: &Path, generation: u64, lock: File) -> std::io::Result<Self> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path(directory, generation))?;
        let bytes = file.metadata()?.len();
        File::open(directory)?.sync_all()?;
        Ok(LogFile { file, _lock: lock, bytes })
    }

    /// Bytes the log holds: the writer seals when it passes a limit.
    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    /// Writes one committed group (its records, then a commit carrying their
    /// count and checksum) and fsyncs before returning.
    pub fn write_group(&mut self, records: &[String]) -> std::io::Result<()> {
        if records.is_empty() {
            return Ok(());
        }
        let mut bytes = String::new();
        for record in records {
            bytes.push_str(record);
            bytes.push('\n');
        }
        let commit = json!({ "op": "commit", "count": records.len(), "check": checksum(records) });
        bytes.push_str(&commit.to_string());
        bytes.push('\n');
        self.file.write_all(bytes.as_bytes())?;
        self.file.sync_data()?;
        self.bytes += bytes.len() as u64;
        Ok(())
    }
}

/// The log's intact committed groups from byte `offset` on, and the offset
/// just after the last of them: a reader resumes there. No log yet is no
/// groups. A torn tail is left for later; a group whose checksum fails is
/// an error naming where.
pub fn committed_groups_from(
    directory: &Path,
    generation: u64,
    offset: u64,
) -> std::io::Result<(Vec<Vec<Json>>, u64)> {
    let mut file = match File::open(log_path(directory, generation)) {
        Ok(file) => file,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), offset)),
        Err(cause) => return Err(cause),
    };
    file.seek(SeekFrom::Start(offset))?;
    let mut reader = BufReader::new(file);
    let mut groups = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    let mut position = offset;
    let mut committed = offset;
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line)?;
        // The end, or a line a crash cut short (no newline yet): stop here.
        if read == 0 || !line.ends_with('\n') {
            break;
        }
        position += read as u64;
        let text = line.trim_end_matches('\n').to_owned();
        let Ok(record) = serde_json::from_str::<Json>(&text) else {
            return Err(corrupt(directory, generation, position, "a record that isn't JSON"));
        };
        if record["op"] != "commit" {
            lines.push(text);
            continue;
        }
        let expected = record["check"].as_str().unwrap_or("");
        let count = record["count"].as_u64().unwrap_or(0) as usize;
        if count != lines.len() || expected != checksum(&lines) {
            return Err(corrupt(directory, generation, position, "a group whose checksum doesn't match"));
        }
        let group = lines
            .drain(..)
            .map(|text| serde_json::from_str::<Json>(&text))
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| corrupt(directory, generation, position, "a record that isn't JSON"))?;
        groups.push(group);
        committed = position;
    }
    Ok((groups, committed))
}

fn corrupt(directory: &Path, generation: u64, position: u64, what: &str) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!(
            "{} is corrupt: {what} before byte {position}; the groups before it were applied",
            log_path(directory, generation).display()
        ),
    )
}

/// Removes the logs of generations before `generation`, once a sealed
/// generation holds what they recorded.
pub fn remove_logs_before(directory: &Path, generation: u64) {
    let Ok(entries) = fs::read_dir(directory) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(number) = name.strip_prefix("wal-g").and_then(|rest| rest.strip_suffix(".log")) else {
            continue;
        };
        if number.parse::<u64>().is_ok_and(|n| n < generation) {
            let _ = fs::remove_file(entry.path());
        }
    }
}
