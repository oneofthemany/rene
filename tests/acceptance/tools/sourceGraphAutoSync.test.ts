import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";

import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// CodeGraphProvider syncs at most once per this window per project.
const PAST_FRESHNESS_WINDOW_MS = 5_500;

interface SymbolSearch {
  readonly isError?: boolean;
  readonly structuredContent?: {
    readonly normalized_result: { readonly text: string };
    readonly limitations: readonly string[];
  };
}

it("answers source-graph queries from an index that follows edits, across processes", async () => {
  const project = await createTestTempDirectory("rea-source-graph-sync-");
  await mkdir(join(project, "src"));
  await writeFile(
    join(project, "src", "a.ts"),
    "export function alpha() { return beta(); }\n",
  );
  await writeFile(
    join(project, "src", "b.ts"),
    "export function beta() { return 1; }\n",
  );
  const environment = {
    HOME: process.env.HOME ?? project,
    REA_TOOLBOX_ROOTS: project,
  };
  const first = await connectLocalToolsMcp(environment);
  const second = await connectLocalToolsMcp(environment);
  const search = async (
    server: typeof first,
    name: string,
  ): Promise<{ found: boolean; synced: readonly string[] }> => {
    const reply = (await server.call("search_source_symbols", {
      project_path: project,
      query: name,
    })) as SymbolSearch;
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    const { normalized_result, limitations } = reply.structuredContent!;
    return {
      // Listed with its location, not only echoed in a "no results" line.
      found: new RegExp(`${name}[\\s\\S]{0,200}src/[ab]\\.ts`, "u").test(
        normalized_result.text,
      ),
      synced: limitations.filter((line) =>
        line.startsWith("REA synced the index"),
      ),
    };
  };

  const built = await first.call("index_source_graph", {
    project_path: project,
    mode: "build",
  });
  expect(built.isError, JSON.stringify(built.content)).not.toBe(true);
  expect((await search(first, "gammaNew")).found).toBe(false);

  await appendFile(
    join(project, "src", "b.ts"),
    "export function gammaNew() { return 2; }\n",
  );
  await delay(PAST_FRESHNESS_WINDOW_MS);
  const edited = await search(first, "gammaNew");
  expect(edited.found).toBe(true);
  expect(edited.synced).toEqual([
    expect.stringContaining("1 modified") as string,
  ]);

  // Within the window a query answers without syncing again.
  expect((await search(first, "beta")).synced).toEqual([]);

  // Both processes sync at once; CodeGraph's sync lock admits one, and the
  // other retries, so both answer with the edit.
  await appendFile(
    join(project, "src", "b.ts"),
    "export function epsilonNew() { return 4; }\n",
  );
  await delay(PAST_FRESHNESS_WINDOW_MS);
  const both = await Promise.all([
    search(first, "epsilonNew"),
    search(second, "epsilonNew"),
  ]);
  expect(both.map(({ found }) => found)).toEqual([true, true]);
}, 90_000);
