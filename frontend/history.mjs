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

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../dist/process/ProviderProcess.js";

const ID = /^\d{13}-[0-9a-f]{8}$/;
const SUMMARY = /^(\d{13}-[0-9a-f]{8})\.json$/;
// One import request stays well under what a line should carry.
const IMPORT_BATCH_BYTES = 16 * 1024 * 1024;
// How long a store may take to close its database after its input ends,
// before the owned stop escalates.
const CLOSE_TIMEOUT_MS = 5000;
const MAX_STDERR_BYTES = 64 * 1024;

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
 * Launches rene-history for one database file through rene's owned-process
 * supervision (src/process): its own process group and a run id, with a
 * supervisor that can verify its stop.
 */
async function launchStore(path) {
  let spawned;
  try {
    spawned = await spawnOwnedProviderProcess({
      command: STORE_BINARY,
      arguments: [path],
      runId: randomUUID(),
      stdin: "pipe",
    });
  } catch (cause) {
    throw cause?.code === "ENOENT"
      ? new Error(
          `The history store ${STORE_BINARY} is not built; run \`npm run history-store:build\`.`,
        )
      : cause;
  }
  const supervisor = new ProviderProcessSupervisor(
    {
      ...spawned,
      ownsProcessLifetime: true,
      cleanup:
        spawned.cleanup ?? (() => cleanupOwnedProcessGroup(spawned.ownership)),
    },
    // stdout carries the protocol; stderr is kept, bounded, for diagnostics.
    { captureStdout: false, maxDiagnosticBytes: MAX_STDERR_BYTES },
  );
  return { child: spawned.process, supervisor };
}

/**
 * One running rene-history process for one database file. Requests are
 * answered in the order they were sent; when the process exits, every
 * pending request fails and the store is marked exited.
 */
async function startStore(path) {
  const { child, supervisor } = await launchStore(path);
  const pending = new Map();
  let nextId = 1;
  let exited;
  let settleReady;
  const ready = new Promise((resolve, reject) => {
    settleReady = { resolve, reject };
  });
  // A rejected ready that nobody awaits yet must not crash the bridge.
  ready.catch(() => {});
  let stopping;
  /** The owned stop, shared; ownership is released only once it completes. */
  const stop = () =>
    (stopping ??= supervisor.stop().then((result) => {
      if (result.status === "incomplete") {
        stopping = undefined;
        throw new Error(
          `The history store for ${path} could not be stopped: ${result.reason}`,
        );
      }
      supervisor.dispose();
      return result;
    }));
  const fail = (cause) => {
    if (exited) return;
    exited = cause;
    settleReady.reject(cause);
    for (const waiter of pending.values()) waiter.reject(cause);
    pending.clear();
  };
  child.once("exit", (code, signal) => {
    fail(
      new Error(
        `The history store for ${path} exited (${signal ?? `status ${code}`}).`,
      ),
    );
    // Confirms the group is gone and releases the supervisor's listeners.
    stop().catch((cause) =>
      process.stderr.write(`${cause.message ?? cause}\n`),
    );
  });
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
    /**
     * Ends the process by closing its input, so DuckDB closes the file
     * cleanly, then completes the owned stop (which escalates if it hangs).
     */
    async close() {
      if (!exited) {
        child.stdin.end();
        await supervisor.waitForExit(CLOSE_TIMEOUT_MS);
      }
      await stop();
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
    (await store.send(`"op":"query"`)).map((entry) => entry.id),
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
      const started = await startStore(path);
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

    /**
     * Summaries, newest first, without results. Every filter member is
     * optional and narrows the list: name, outcome, startedSince and
     * startedBefore (inclusive startedAt bounds), beforeId (entries older than
     * this id, for paging), evidence (entries that issued any of these
     * Evidence ids) and limit.
     * @param {{ name?: string, outcome?: string, startedSince?: number,
     *   startedBefore?: number, beforeId?: string, evidence?: string[],
     *   limit?: number }} [filter]
     */
    list: async (filter = {}) =>
      (await connected()).send(
        `"op":"query","filter":${JSON.stringify(filter)}`,
      ),

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
