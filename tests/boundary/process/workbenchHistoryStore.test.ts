import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// The workbench's call history (frontend/history.mjs) over the rene-history
// DuckDB store (packages/history-store), as the bridge uses it.

interface Summary {
  readonly id: string;
  readonly startedAt: number;
  readonly name: string;
  readonly outcome?: string;
  readonly evidence?: readonly string[];
  readonly resultBytes?: number;
  readonly resultOmitted?: boolean;
  readonly untrusted?: boolean;
}
interface History {
  newId(startedAt: number): string;
  record(entry: Record<string, unknown>): Promise<Summary>;
  list(filter?: Record<string, unknown>): Promise<Summary[]>;
  result(id: string): Promise<unknown>;
  importJson(folder: string): Promise<{ added: number }>;
  clear(): Promise<void>;
  close(): Promise<void>;
}
const { createHistory } = (await import(
  new URL("../../../frontend/history.mjs", import.meta.url).href
)) as {
  createHistory(directory: string, limits: { maxEntryBytes: number }): History;
};

const run = promisify(execFile);
const MAX_ENTRY_BYTES = 1024;

/** The rene-history processes serving one database file. */
const storeProcesses = async (database: string) => {
  try {
    const { stdout } = await run("pgrep", ["-f", `/rene-history ${database}$`]);
    return stdout.split(/\s+/u).filter(Boolean).map(Number);
  } catch {
    return [];
  }
};

/** A JSON history as the bridge kept it before DuckDB: newest is call 5. */
const writeJsonHistory = async (directory: string) => {
  await mkdir(directory, { recursive: true });
  const summaries: Summary[] = [1, 2, 3, 4, 5].map((call) => ({
    id: `179240000000${String(call)}-0000000${String(call)}`,
    startedAt: 1792400000000 + call,
    name: call % 2 === 0 ? "record_topic" : "read_file",
    outcome: call === 3 ? "error" : "ok",
    ...(call === 2 ? { evidence: [`ev_${"a".repeat(64)}`] } : {}),
  }));
  for (const summary of summaries) {
    await writeFile(
      join(directory, `${summary.id}.json`),
      JSON.stringify(summary),
    );
    await writeFile(
      join(directory, `${summary.id}.result.json`),
      JSON.stringify({ content: [{ type: "text", text: summary.id }] }),
    );
  }
  await writeFile(join(directory, "1792400000009-00000009.json"), "{ broken");
  return summaries;
};

it("keeps workbench history in DuckDB: import, record, query, restart, crash and clear", async () => {
  const root = await createTestTempDirectory("rea-workbench-history-");
  const directory = join(root, "history");
  const database = `${directory}.duckdb`;
  const archived = `${directory}.json-imported`;
  const summaries = await writeJsonHistory(directory);
  let history = createHistory(directory, { maxEntryBytes: MAX_ENTRY_BYTES });
  onTestFinished(() => history.close());

  // First use imports the JSON history, skips the unreadable summary and
  // archives the folder instead of deleting it.
  const imported = await history.list();
  expect(imported).toEqual([...summaries].reverse());
  expect(existsSync(directory)).toBe(false);
  expect(existsSync(join(archived, "1792400000009-00000009.json"))).toBe(true);
  for (const { id } of summaries)
    expect(await history.result(id)).toEqual(
      JSON.parse(await readFile(join(archived, `${id}.result.json`), "utf8")),
    );
  expect(await history.result("0000000000000-00000000")).toBeUndefined();
  expect(await history.result("../outside")).toBeUndefined();

  // Recording keeps the result, or only its size when it is over the cap.
  const now = Date.now();
  const small = await history.record({
    id: history.newId(now),
    startedAt: now,
    name: "probe",
    outcome: "ok",
    result: {
      content: [{ type: "text", text: "hi" }],
      _meta: { provenance: { untrusted_content: true } },
    },
  });
  expect(small).toMatchObject({ untrusted: true });
  expect(small.resultBytes).toBeGreaterThan(0);
  expect(await history.result(small.id)).toMatchObject({
    content: [{ text: "hi" }],
  });
  const big = await history.record({
    id: history.newId(now + 1),
    startedAt: now + 1,
    name: "big",
    outcome: "ok",
    result: { blob: "x".repeat(MAX_ENTRY_BYTES) },
  });
  expect(big.resultOmitted).toBe(true);
  expect(await history.result(big.id)).toBeUndefined();

  // Queries.
  expect(
    (await history.list({ name: "record_topic", outcome: "ok" })).map(
      ({ id }) => id,
    ),
  ).toEqual([summaries[3]!.id, summaries[1]!.id]);
  const firstPage = await history.list({ limit: 3 });
  const secondPage = await history.list({
    limit: 3,
    beforeId: firstPage.at(-1)!.id,
  });
  expect([...firstPage, ...secondPage].map(({ id }) => id)).toEqual(
    [small, big, ...summaries]
      .map(({ id }) => id)
      .sort()
      .reverse()
      .slice(0, 6),
  );
  expect(
    (
      await history.list({
        startedSince: summaries[1]!.startedAt,
        startedBefore: summaries[3]!.startedAt,
      })
    ).map(({ id }) => id),
  ).toEqual([summaries[3]!.id, summaries[2]!.id, summaries[1]!.id]);
  expect(
    (await history.list({ evidence: [summaries[1]!.evidence![0]] })).map(
      ({ id }) => id,
    ),
  ).toEqual([summaries[1]!.id]);

  // One owned store process, leading its own process group.
  const [pid, ...others] = await storeProcesses(database);
  expect(others).toEqual([]);
  const { stdout: group } = await run("ps", ["-o", "pgid=", "-p", String(pid)]);
  expect(Number(group.trim())).toBe(pid);

  // A killed store is replaced on the next call, with nothing lost.
  process.kill(pid!, "SIGKILL");
  await delay(200);
  expect(await history.list()).toHaveLength(summaries.length + 2);

  // Persists across a restart without importing again.
  await history.close();
  history = createHistory(directory, { maxEntryBytes: MAX_ENTRY_BYTES });
  expect(await history.list()).toHaveLength(summaries.length + 2);
  expect((await history.importJson(archived)).added).toBe(0);
  expect(existsSync(archived)).toBe(true);

  await history.clear();
  expect(await history.list()).toEqual([]);
  await history.close();
  expect(await storeProcesses(database)).toEqual([]);
});
