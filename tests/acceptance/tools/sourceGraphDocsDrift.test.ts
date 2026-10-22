import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

interface DocsDrift {
  readonly documents: number;
  readonly sections: number;
  readonly resolved_references: number;
  readonly broken_references: number;
  readonly counts: {
    readonly path: number;
    readonly symbol: number;
    readonly undocumented: number;
  };
  readonly findings: readonly {
    kind: string;
    file: string;
    line: number;
    detail: string;
  }[];
  readonly truncated: boolean;
}

const drift = (reply: { structuredContent?: unknown }): DocsDrift =>
  (reply.structuredContent as { normalized_result: DocsDrift })
    .normalized_result;

it("reports the citations a project's documentation has outlived", async () => {
  const root = await createTestTempDirectory("rea-docs-drift-");
  const project = join(root, "project");
  const unindexed = join(root, "unindexed");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "docs"), { recursive: true });
  await mkdir(unindexed);
  await writeFile(
    join(project, "src", "shared.ts"),
    "export function shared() { return 1; }\n",
  );
  await writeFile(
    join(project, "src", "caller.ts"),
    'import { shared } from "./shared";\nexport function caller() { return shared(); }\n',
  );
  // One heading cites what the project still has, the next cites what it has
  // outlived: a file that was deleted and a symbol that was renamed.
  await writeFile(
    join(project, "docs", "guide.md"),
    [
      "# Guide",
      "",
      "The core lives in `src/shared.ts` and exposes `shared`.",
      "",
      "## History",
      "",
      "It used to live in `src/legacy.ts`, where it was called `legacyShared`.",
      "",
    ].join("\n"),
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

  const reply = await call("source_docs_drift", { project_path: project });
  expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
  const report = drift(reply);

  // Leading with how much prose was indexed: without it, "no broken
  // references" reads like health rather than an unmade check.
  expect(report.documents).toBe(1);
  expect(report.sections).toBe(2);
  expect(report.resolved_references).toBeGreaterThanOrEqual(2);

  expect(report.broken_references).toBe(2);
  expect(report.counts).toMatchObject({ path: 1, symbol: 1, undocumented: 0 });
  expect(report.truncated).toBe(false);

  const path = report.findings.find((finding) => finding.kind === "path");
  expect(path).toMatchObject({
    file: expect.stringContaining("guide.md") as string,
    line: 7,
  });
  expect(path?.detail).toContain("src/legacy.ts");
  // The innermost enclosing heading, so the report says where in the document.
  expect(path?.detail).toContain("History");

  const symbol = report.findings.find((finding) => finding.kind === "symbol");
  expect(symbol?.detail).toContain("legacyShared");
  // What the documentation still describes correctly is not a finding.
  expect(JSON.stringify(report.findings)).not.toContain("shared.ts");

  // Undocumented code runs the other way and is only reported when asked for.
  const asked = drift(
    await call("source_docs_drift", {
      project_path: project,
      include_undocumented: true,
    }),
  );
  expect(asked.counts.undocumented).toBeGreaterThan(0);
  expect(
    asked.findings.filter((finding) => finding.kind === "undocumented"),
  ).toContainEqual(
    expect.objectContaining({
      file: expect.stringContaining("caller.ts") as string,
      detail: expect.stringContaining("caller") as string,
    }),
  );

  const outOfRange = await call("source_docs_drift", {
    project_path: project,
    limit: 0,
  });
  expect(outOfRange.isError).toBe(true);
  const noIndex = await call("source_docs_drift", { project_path: unindexed });
  expect(JSON.stringify(parseMcpToolError(noIndex).error)).toContain(
    "Build one with index_source_graph",
  );
}, 60_000);
