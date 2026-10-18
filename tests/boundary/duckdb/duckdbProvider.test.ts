import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, onTestFinished, test } from "vitest";

import { DuckdbProvider } from "../../../src/duckdb/DuckdbProvider.js";
import {
  duckdbResultSchemas,
  type DuckdbRequest,
} from "../../../src/domain/duckdb/duckdbDatabase.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const it = test.skipIf(process.platform !== "linux");
const REAL_DUCKDB = process.env.REA_DUCKDB_TEST_COMMAND;
const real = test.skipIf(
  process.platform !== "linux" || REAL_DUCKDB === undefined,
);

const INVENTORY = JSON.stringify({
  storage: {
    database_size: "256.0 KiB",
    block_size: 262144,
    total_blocks: 1,
    used_blocks: 1,
    free_blocks: 0,
    wal_size: "0 bytes",
  },
  tables: [
    {
      schema: "main",
      name: "states",
      estimated_rows: 2,
      column_count: 2,
      has_primary_key: false,
    },
  ],
  columns: [
    {
      schema: "main",
      table: "states",
      name: "ts",
      type: "TIMESTAMP",
      nullable: true,
      default: null,
    },
    {
      schema: "main",
      table: "states",
      name: "v",
      type: "DOUBLE",
      nullable: true,
      default: null,
    },
  ],
  views: [{ schema: "main", name: "recent" }],
  indexes: [],
  sequences: [],
});
const ROWS = JSON.stringify({
  row_count: 2,
  rows: [
    ["2026-10-18 09:00:00", "21.5"],
    [null, null],
  ],
  truncated_cells: 0,
});
const SUMMARY = JSON.stringify([
  {
    column: "v",
    type: "DOUBLE",
    min: "21.5",
    max: "21.5",
    approx_unique: 1,
    null_percentage: 50,
    count: 2,
  },
]);

const shellQuote = (value: string) => `'${value.replace(/'/gu, "'\\''")}'`;

/**
 * A duckdb stand-in that answers each fixed query by what it asks for, and
 * records its argv, HOME and whether the owned WAL copy exists.
 */
const writeStub = async (
  root: string,
  options: { version?: string; mutate?: boolean } = {},
): Promise<{ command: string; log: string }> => {
  const command = join(root, "duckdb");
  const log = join(root, "argv.log");
  await writeFile(
    command,
    `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' ${shellQuote(options.version ?? "v1.5.4 (Variegata) 08e34c447b")}; exit 0; fi
for last; do :; done
{ printf 'HOME=%s\\n' "$HOME"; printf 'ARG=%s\\n' "$@"; [ -f "$last.wal" ] && printf 'WAL=present\\n'; } >> ${shellQuote(log)}
${options.mutate === true ? 'chmod u+w "$last"; printf x >> "$last"' : ":"}
case "$7" in
  *pragma_database_size*) printf '%s\\n' ${shellQuote(INVENTORY)} ;;
  *SUMMARIZE*) printf '%s\\n' ${shellQuote(SUMMARY)} ;;
  *row_count*) printf '%s\\n' ${shellQuote(ROWS)} ;;
  *) exit 3 ;;
esac
`,
    { mode: 0o755 },
  );
  return { command, log };
};

const providerWith = async (options: Parameters<typeof writeStub>[1] = {}) => {
  const root = await createTestTempDirectory("rea-duckdb-");
  const stub = await writeStub(root, options);
  const provider = new DuckdbProvider({
    environment: { REA_DUCKDB_COMMAND: stub.command },
  });
  onTestFinished(() => provider.close());
  const database = join(root, "telemetry.duckdb");
  await writeFile(database, Buffer.from("duckdb-fixture-bytes"));
  return { provider, root, database, ...stub };
};

const inspect = (provider: DuckdbProvider, input: Record<string, unknown>) =>
  provider.execute({
    operation: "inspect_duckdb_database",
    input,
  } as DuckdbRequest);

it("reports the selected CLI and its version without opening a database", async () => {
  const { provider, command } = await providerWith();
  const result = await provider.execute({
    operation: "inspect_duckdb_client",
    input: {},
  });
  if (!result.ok) throw result.error;
  expect(
    duckdbResultSchemas.inspect_duckdb_client.parse(result.value.result),
  ).toEqual({
    client: {
      duckdb_command: command,
      duckdb_source: "environment",
      duckdb_version: "v1.5.4 (Variegata) 08e34c447b",
    },
  });
});

it("refuses a pre-1.0 CLI as an unsupported version", async () => {
  const { provider } = await providerWith({ version: "v0.10.3 70fd6a8a24" });
  const availability = await provider.inspectAvailability();
  expect(availability).toMatchObject({
    status: "unavailable",
    code: "unsupported_version",
  });
});

it("opens an owned copy read-only with a locked, offline session and a private HOME", async () => {
  const { provider, database, log } = await providerWith();
  const result = await inspect(provider, { path: database });
  if (!result.ok) throw result.error;
  const argv = await readFile(log, "utf8");
  expect(argv).toContain("ARG=-readonly\n");
  expect(argv).toContain("SET enable_external_access=false");
  expect(argv).toContain("SET lock_configuration=true");
  expect(argv).not.toContain(`ARG=${database}\n`);
  const home = /^HOME=(.*)$/mu.exec(argv)?.[1] ?? "";
  expect(home).toMatch(/rea-duckdb-/u);
  expect(home.startsWith(join(database, ".."))).toBe(false);
  const report = duckdbResultSchemas.inspect_duckdb_database.parse(
    result.value.result,
  );
  expect(report.wal).toBeNull();
  expect(report.rows).toBeNull();
  expect(report.schema.tables[0]?.columns).toBeNull();
});

it("copies a sibling WAL with the database and reports both identities", async () => {
  const { provider, database, log } = await providerWith();
  await writeFile(`${database}.wal`, Buffer.from("wal-bytes"));
  const result = await inspect(provider, { path: database });
  if (!result.ok) throw result.error;
  expect(await readFile(log, "utf8")).toContain("WAL=present");
  const report = duckdbResultSchemas.inspect_duckdb_database.parse(
    result.value.result,
  );
  expect(report.wal).toMatchObject({ path: `${database}.wal`, bytes: 9 });
});

it("samples exact columns of a selected table, with statistics on request", async () => {
  const { provider, database } = await providerWith();
  const result = await inspect(provider, {
    path: database,
    table: "states",
    columns: ["ts", "v"],
    summarize: true,
  });
  if (!result.ok) throw result.error;
  const report = duckdbResultSchemas.inspect_duckdb_database.parse(
    result.value.result,
  );
  expect(report.rows).toMatchObject({
    table: "states",
    columns: ["ts", "v"],
    row_count: 2,
  });
  expect(report.rows?.rows[1]).toEqual([null, null]);
  expect(report.summary?.[0]).toMatchObject({
    column: "v",
    null_percentage: 50,
  });
  expect(report.schema.tables[0]?.columns?.map((c) => c.name)).toEqual([
    "ts",
    "v",
  ]);
});

it("refuses a view, an unknown table and an unknown column by name", async () => {
  const { provider, database } = await providerWith();
  for (const [input, message] of [
    [{ table: "recent" }, "main.recent is a view"],
    [{ table: "nope" }, "No base table main.nope. Tables: main.states"],
    [{ table: "states", columns: ["bogus"] }, "has no column bogus"],
  ] as const) {
    const result = await inspect(provider, { path: database, ...input });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(JSON.stringify(projectAnalysisError(result.error))).toContain(
        message,
      );
  }
});

it("refuses evidence when the tool changed the owned copy", async () => {
  const { provider, database } = await providerWith({ mutate: true });
  const result = await inspect(provider, { path: database });
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(projectAnalysisError(result.error).code).toBe("artifact_changed");
  expect(await readFile(database, "utf8")).toBe("duckdb-fixture-bytes");
});

real(
  "reads a real database's catalog, rows and statistics through the selected CLI",
  async () => {
    const root = await createTestTempDirectory("rea-duckdb-real-");
    const database = join(root, "real.duckdb");
    await promisify(execFile)(REAL_DUCKDB ?? "", [
      database,
      "-c",
      `CREATE TABLE "odd ""name""" (ts TIMESTAMP, v DOUBLE); INSERT INTO "odd ""name""" VALUES (TIMESTAMP '2026-10-18 09:00', 21.5), (NULL, NULL); CREATE VIEW recent AS SELECT 1 AS one`,
    ]);
    const before = await readFile(database);
    const provider = new DuckdbProvider({
      environment: { REA_DUCKDB_COMMAND: REAL_DUCKDB },
    });
    onTestFinished(() => provider.close());
    const result = await inspect(provider, {
      path: database,
      table: 'odd "name"',
      summarize: true,
    });
    if (!result.ok) throw result.error;
    const report = duckdbResultSchemas.inspect_duckdb_database.parse(
      result.value.result,
    );
    expect(report.rows?.rows).toEqual([
      ["2026-10-18 09:00:00", "21.5"],
      [null, null],
    ]);
    expect(report.summary?.find((c) => c.column === "v")?.null_percentage).toBe(
      50,
    );
    expect(report.schema.views).toEqual([{ schema: "main", name: "recent" }]);
    expect(await readFile(database)).toEqual(before);
  },
);
