// Call history the bridge keeps across page reloads and restarts.
//
// Each settled call is two files in one directory the bridge owns: a small
// summary (<id>.json) and the full MCP result (<id>.result.json). The summary
// is written last, so its presence marks a complete entry. A result larger
// than the per-entry cap is not kept; its summary records that omission and
// the result's size instead. Oldest entries go first once the entry or byte
// cap is reached. Arguments and results are stored as the caller chose and
// REA returned them; REA owns redaction of credentials and marked values.

import { randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const ID = /^\d{13}-[0-9a-f]{8}$/;
const SUMMARY = /^(\d{13}-[0-9a-f]{8})\.json$/;
const RESULT = /^(\d{13}-[0-9a-f]{8})\.result\.json$/;

/** Sortable id: start time first, then randomness. */
const newId = (startedAt) =>
  `${String(startedAt).padStart(13, "0")}-${randomBytes(4).toString("hex")}`;

/**
 * @param {string} directory
 * @param {{ maxEntries: number, maxEntryBytes: number, maxTotalBytes: number }} limits
 */
export function createHistory(directory, limits) {
  // Writes, pruning and clearing run one at a time, in order.
  let queue = Promise.resolve();
  const serial = (work) => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };
  const pending = new Set();
  const ready = mkdir(directory, { recursive: true, mode: 0o700 });

  async function writeAtomic(name, text) {
    const path = join(directory, name);
    await writeFile(`${path}.tmp`, text, { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }

  async function summaries() {
    await ready;
    const names = await readdir(directory);
    const entries = await Promise.all(
      names
        .filter((name) => SUMMARY.test(name))
        .map((name) =>
          readFile(join(directory, name), "utf8")
            .then((text) => JSON.parse(text))
            // An unreadable summary is not an entry; prune removes it.
            .catch(() => ({ id: SUMMARY.exec(name)[1], unreadable: true })),
        ),
    );
    return entries.sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  async function remove(id) {
    await rm(join(directory, `${id}.json`), { force: true });
    await rm(join(directory, `${id}.result.json`), { force: true });
  }

  async function prune() {
    const entries = await summaries();
    let total = 0;
    const keep = new Set();
    for (const [index, entry] of entries.entries()) {
      if (!entry.resultOmitted) total += entry.resultBytes ?? 0;
      if (
        entry.unreadable ||
        index >= limits.maxEntries ||
        total > limits.maxTotalBytes
      )
        await remove(entry.id);
      else keep.add(entry.id);
    }
    // A result whose summary never landed belongs to no entry.
    for (const name of await readdir(directory)) {
      const id = RESULT.exec(name)?.[1];
      if (id && !keep.has(id) && !pending.has(id))
        await rm(join(directory, name), { force: true });
    }
  }

  return {
    newId,

    /**
     * Records one settled call and resolves to the summary it stored (with
     * resultBytes, resultOmitted and untrusted), so callers can tell others
     * exactly what history holds. Failures are reported, never thrown at the
     * call.
     */
    record(entry) {
      pending.add(entry.id);
      return serial(async () => {
        await ready;
        const summary = { ...entry };
        delete summary.result;
        if (entry.result !== undefined) {
          const text = JSON.stringify(entry.result);
          const bytes = Buffer.byteLength(text);
          summary.resultBytes = bytes;
          if (bytes <= limits.maxEntryBytes)
            await writeAtomic(`${entry.id}.result.json`, text);
          else summary.resultOmitted = true;
          summary.untrusted =
            entry.result?._meta?.provenance?.untrusted_content === true;
        }
        await writeAtomic(`${entry.id}.json`, JSON.stringify(summary));
        await prune();
        return summary;
      }).finally(() => pending.delete(entry.id));
    },

    /** Summaries, newest first, without results. */
    list: () =>
      serial(async () =>
        (await summaries()).filter((entry) => !entry.unreadable),
      ),

    /** The stored result for one entry, or undefined when none is kept. */
    async result(id) {
      if (!ID.test(id)) return undefined;
      try {
        return JSON.parse(
          await readFile(join(directory, `${id}.result.json`), "utf8"),
        );
      } catch {
        return undefined;
      }
    },

    /** Removes every stored entry. Only files this history names are touched. */
    clear: () =>
      serial(async () => {
        await ready;
        for (const name of await readdir(directory)) {
          const id = SUMMARY.exec(name)?.[1] ?? RESULT.exec(name)?.[1];
          if (id && !pending.has(id))
            await rm(join(directory, name), { force: true });
        }
      }),
  };
}
