import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

interface SourceGraphMap {
  readonly files: number;
  readonly last_indexed_at: unknown;
  readonly languages: readonly { language: string; files: number }[];
  readonly most_depended_on_files: readonly {
    file: string;
    dependent_files: number;
  }[];
  readonly most_called_symbols: readonly {
    name: string;
    file: string;
    callers: number;
  }[];
}

it("maps an indexed project: its most depended-on file and most-called symbol", async () => {
  const root = await createTestTempDirectory("rea-source-graph-map-");
  const project = join(root, "project");
  const unindexed = join(root, "unindexed");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(unindexed);
  await writeFile(
    join(project, "src", "shared.ts"),
    "export function shared() { return 1; }\n",
  );
  for (const caller of ["a", "b"])
    await writeFile(
      join(project, "src", `${caller}.ts`),
      `import { shared } from "./shared";\nexport function ${caller}() { return shared(); }\n`,
    );
  const { call } = await connectLocalToolsMcp({
    HOME: process.env.HOME ?? root,
    REA_TOOLBOX_ROOTS: root,
  });

  const built = await call("index_source_graph", {
    project_path: project,
    mode: "build",
  });
  expect(built.isError, JSON.stringify(built.content)).not.toBe(true);
  const mapped = await call("map_source_graph", {
    project_path: project,
    limit: 5,
  });
  expect(mapped.isError, JSON.stringify(mapped.content)).not.toBe(true);
  const map = (
    mapped.structuredContent as { normalized_result: SourceGraphMap }
  ).normalized_result;
  expect(map.files).toBe(3);
  expect(map.last_indexed_at).toBeTruthy();
  expect(map.languages).toEqual([
    expect.objectContaining({ language: "typescript", files: 3 }),
  ]);
  expect(map.most_depended_on_files[0]).toMatchObject({
    file: expect.stringContaining("shared.ts") as string,
    dependent_files: 2,
  });
  expect(map.most_called_symbols[0]).toMatchObject({
    name: "shared",
    file: expect.stringContaining("shared.ts") as string,
    callers: 2,
  });

  const outOfRange = await call("map_source_graph", {
    project_path: project,
    limit: 0,
  });
  expect(outOfRange.isError).toBe(true);
  const noIndex = await call("map_source_graph", { project_path: unindexed });
  expect(JSON.stringify(parseMcpToolError(noIndex).error)).toContain(
    "Build one with index_source_graph",
  );
}, 60_000);
