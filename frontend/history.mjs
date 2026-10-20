// Call history the bridge keeps across page reloads and restarts.
//
// Each history is one DuckDB file, `<directory>.duckdb`, owned by a
// rene-history process (packages/history-store) that the bridge starts on
// first use and talks to over JSON lines. That process is the file's only
// writer. Nothing is trimmed by count or age; a result larger than the
// per-entry cap is not kept, and its summary records that omission and the
// result's size instead. Arguments and results are stored as the caller
// chose and REA returned them; REA owns redaction of credentials and marked
// values.
//
// History used to be JSON files in `<directory>` (<id>.json summaries and
// <id>.result.json results). On first use they are imported, entries already
// in the database are kept, and once every imported id is confirmed in the
// database the folder is renamed to `<directory>.json-imported`, so nothing
// is deleted.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ID = /^\d{13}-[0-9a-f]{8}$/;
const SUMMARY = /^(\d{13}-[0-9a-f]{8})\.json$/;
// One import request stays well under what a line should carry.
const IMPORT_BATCH_BYTES = 16 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 5000;

const STORE_BINARY =
  process.env.REA_HISTORY_STORE ??
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "packages",
    "history-store",
    "dist",
    "rene-history",
  );

/** Sortable id: start time first, then randomness. */
const newId = (startedAt) =>
  `${String(startedAt).padStart(13, "0")}-${randomBytes(4).toString("hex")}`;

/**
 * One running rene-history process for one database file. Requests are
 * answered in the order they were sent; when the process exits, every
 * pending request fails and the store is marked exited.
 */
function startStore(path) {
  const child = spawn(STORE_BINARY, [path], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 1;
  let exited;
  let settleReady;
  const ready = new Promise((resolve, reject) => {
    settleReady = { resolve, reject };
  });
  const exit = new Promise((resolve) => {
    const fail = (cause) => {
      if (exited) return;
      exited = cause;
      settleReady.reject(cause);
      for (const waiter of pending.values()) waiter.reject(cause);
      pending.clear();
      resolve();
    };
    child.on("error", (cause) =>
      fail(
        cause.code === "ENOENT"
          ? new Error(
              `The history store ${STORE_BINARY} is not built; run \`npm run history-store:build\`.`,
            )
          : cause,
      ),
    );
    child.on("exit", (code, signal) =>
      fail(
        new Error(
          `The history store for ${path} exited (${signal ?? `status ${code}`}).`,
        ),
      ),
    );
  });
  // A rejected ready that nobody awaits yet must not crash the bridge.
  ready.catch(() => {});
  // Pipe errors surface as the process's exit.
  child.stdin.on("error", () => {});
  createInterface({ input: child.stderr }).on("line", (line) =>
    process.stderr.write(`rene-history: ${line}\n`),
  );
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write("rene-history sent a line that isn't JSON.\n");
      return;
    }
    if (message.ready) return settleReady.resolve(message);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.value);
    else waiter.reject(new Error(`History store: ${message.error}`));
  });

  return {
    ready,
    get exited() {
      return exited !== undefined;
    },
    /** Sends one request; `body` is the request's JSON members after its id. */
    send(body) {
      if (exited) return Promise.reject(exited);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`{"id":${id},${body}}\n`);
      });
    },
    /** Ends the process by closing its input, so DuckDB closes the file cleanly. */
    async close() {
      if (exited) return;
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), CLOSE_TIMEOUT_MS);
      await exit;
      clearTimeout(timer);
    },
  };
}

/**
 * Imports a JSON history folder, then renames it once every entry it held
 * is confirmed in the database. Returns what it did, or undefined when there
 * was nothing to import.
 */
async function importJsonHistory(store, directory, { archive = true } = {}) {
  if (!existsSync(directory)) return undefined;
  const ids = (await readdir(directory))
    .map((name) => SUMMARY.exec(name)?.[1])
    .filter(Boolean)
    .sort();
  let batch = [];
  let batchBytes = 0;
  let added = 0;
  const unreadable = new Set();
  const skippedResults = [];
  const flush = async () => {
    if (!batch.length) return;
    const report = await store.send(
      `"op":"import","entries":[${batch.join(",")}]`,
    );
    added += report.added;
    batch = [];
    batchBytes = 0;
  };
  for (const id of ids) {
    let summary;
    try {
      summary = await readFile(join(directory, `${id}.json`), "utf8");
      JSON.parse(summary);
    } catch {
      unreadable.add(id);
      continue;
    }
    let result = "null";
    try {
      const text = await readFile(join(directory, `${id}.result.json`), "utf8");
      JSON.parse(text);
      result = text;
    } catch (cause) {
      if (cause.code !== "ENOENT") skippedResults.push(id);
    }
    const entry = `{"summary":${summary},"result":${result}}`;
    if (batchBytes + entry.length > IMPORT_BATCH_BYTES) await flush();
    batch.push(entry);
    batchBytes += entry.length;
  }
  await flush();
  const stored = new Set(
    (await store.send(`"op":"list"`)).map((entry) => entry.id),
  );
  const missing = ids.filter((id) => !unreadable.has(id) && !stored.has(id));
  if (missing.length)
    throw new Error(
      `${missing.length} imported entries are not in the database; ${directory} was left in place.`,
    );
  let archivedTo;
  if (archive) {
    archivedTo = `${directory}.json-imported`;
    if (existsSync(archivedTo)) archivedTo = `${archivedTo}-${Date.now()}`;
    await rename(directory, archivedTo);
  }
  return {
    found: ids.length,
    added,
    unreadable: [...unreadable],
    skippedResults,
    archivedTo,
  };
}

/**
 * @param {string} directory the history's location: the database is
 *   `<directory>.duckdb`, and a JSON history in `<directory>` is imported.
 * @param {{ maxEntryBytes: number }} limits
 */
export function createHistory(directory, limits) {
  const path = `${directory}.duckdb`;
  let store;
  let opening;
  let imported = false;

  /** The running store, started (and the JSON history imported) on first use. */
  function connected() {
    if (store && !store.exited) return Promise.resolve(store);
    opening ??= (async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const started = startStore(path);
      await started.ready;
      if (!imported) {
        let report;
        try {
          report = await importJsonHistory(started, directory);
        } catch (cause) {
          await started.close();
          throw cause;
        }
        imported = true;
        if (report)
          process.stderr.write(
            `History: imported ${report.added} new of ${report.found} calls from ${directory} into ${path}; ` +
              `the JSON files are kept in ${report.archivedTo}.` +
              (report.unreadable.length
                ? ` Unreadable, not imported: ${report.unreadable.join(", ")}.`
                : "") +
              (report.skippedResults.length
                ? ` Imported without their unreadable results: ${report.skippedResults.join(", ")}.`
                : "") +
              "\n",
          );
      }
      store = started;
      return started;
    })().finally(() => {
      opening = undefined;
    });
    return opening;
  }

  return {
    newId,
    path,

    /**
     * Records one settled call and resolves to the summary it stored (with
     * resultBytes, resultOmitted and untrusted), so callers can tell others
     * exactly what history holds. Rejects when the store can't keep it.
     */
    async record(entry) {
      const summary = { ...entry };
      delete summary.result;
      let result = "null";
      if (entry.result !== undefined) {
        const text = JSON.stringify(entry.result);
        const bytes = Buffer.byteLength(text);
        summary.resultBytes = bytes;
        if (bytes <= limits.maxEntryBytes) result = text;
        else summary.resultOmitted = true;
        summary.untrusted =
          entry.result?._meta?.provenance?.untrusted_content === true;
      }
      const target = await connected();
      await target.send(
        `"op":"record","summary":${JSON.stringify(summary)},"result":${result}`,
      );
      return summary;
    },

    /** Summaries, newest first, without results. */
    list: async () => (await connected()).send(`"op":"list"`),

    /** The stored result for one entry, or undefined when none is kept. */
    async result(id) {
      if (!ID.test(id)) return undefined;
      const target = await connected();
      return (
        (await target.send(`"op":"result","key":${JSON.stringify(id)}`)) ??
        undefined
      );
    },

    /**
     * Imports another JSON history folder (a backup, say) without moving it;
     * entries already stored are kept. Resolves to what was imported.
     */
    async importJson(folder) {
      return importJsonHistory(await connected(), folder, { archive: false });
    },

    /** Removes every stored entry. */
    async clear() {
      await (await connected()).send(`"op":"clear"`);
    },

    /** Stops the store process, closing the database cleanly. */
    async close() {
      await opening?.catch(() => {});
      await store?.close();
    },
  };
}
