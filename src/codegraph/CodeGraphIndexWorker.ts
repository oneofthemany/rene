// Builds or updates one project's CodeGraph index, in its own process.
//
// REA runs this file as an owned command (CodeGraphIndex.ts), with Node.js,
// the selected CodeGraph library and the project as arguments:
//
//   node CodeGraphIndexWorker.js <dist/index.js> <project> <build|sync>
//
// It loads the library the user built, never CodeGraph's CLI `init`, whose
// defaults also write agent configuration. It writes only the project's
// `.codegraph/` folder. The result is one line on stdout starting with
// RESULT_MARKER, so other output CodeGraph prints can't be mistaken for it;
// a failure is a message on stderr and exit status 1.

import { pathToFileURL } from "node:url";

export const RESULT_MARKER = "REA_CODEGRAPH_INDEX_RESULT ";
const MAX_PROBLEMS = 50;

interface CodeGraphInstance {
  indexAll(options?: object): Promise<Record<string, unknown>>;
  sync(options?: object): Promise<Record<string, unknown>>;
  getStats(): Record<string, unknown>;
  destroy(): void;
}
interface CodeGraphClass {
  init(root: string, options?: object): Promise<CodeGraphInstance>;
  open(root: string, options?: object): Promise<CodeGraphInstance>;
  recreate(root: string): Promise<CodeGraphInstance>;
  isInitialized(root: string): boolean;
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** The CodeGraph class, from an ES module or CommonJS build. */
const codeGraphClass = (module: Record<string, unknown>): CodeGraphClass => {
  const candidates = [
    module.default,
    (module.default as Record<string, unknown> | undefined)?.default,
    module.CodeGraph,
    (module.default as Record<string, unknown> | undefined)?.CodeGraph,
  ];
  const found = candidates.find(
    (candidate) =>
      typeof candidate === "function" &&
      typeof (candidate as { init?: unknown }).init === "function",
  );
  if (found === undefined)
    throw new Error("The CodeGraph library exports no CodeGraph class.");
  return found as CodeGraphClass;
};

const run = async (library: string, root: string, mode: string) => {
  if (mode !== "build" && mode !== "sync")
    throw new Error(`Unknown mode ${mode}.`);
  const CodeGraph = codeGraphClass(
    (await import(pathToFileURL(library).href)) as Record<string, unknown>,
  );
  const started = performance.now();
  let graph: CodeGraphInstance;
  let outcome: Record<string, unknown>;
  if (mode === "sync") {
    if (!CodeGraph.isInitialized(root))
      throw new Error(
        `${root} has no CodeGraph index yet; build one first (mode build).`,
      );
    graph = await CodeGraph.open(root);
    outcome = await graph.sync({});
  } else {
    graph = CodeGraph.isInitialized(root)
      ? await CodeGraph.recreate(root)
      : await CodeGraph.init(root, { index: false });
    outcome = await graph.indexAll({});
  }
  try {
    const stats = graph.getStats();
    const problems = Array.isArray(outcome.errors) ? outcome.errors : [];
    return {
      files: count(stats.fileCount) ?? 0,
      nodes: count(stats.nodeCount) ?? 0,
      edges: count(stats.edgeCount) ?? 0,
      database_bytes: count(stats.dbSizeBytes),
      files_indexed: count(outcome.filesIndexed),
      files_added: count(outcome.filesAdded),
      files_modified: count(outcome.filesModified),
      files_removed: count(outcome.filesRemoved),
      problems: problems.slice(0, MAX_PROBLEMS).map((problem: unknown) => {
        const record = (problem ?? {}) as Record<string, unknown>;
        return {
          message: text(record.message) ?? String(problem),
          file_path: text(record.filePath),
          severity: text(record.severity),
          code: text(record.code),
        };
      }),
      problems_total: problems.length,
      duration_ms: Math.round(performance.now() - started),
    };
  } finally {
    graph.destroy();
  }
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [library, root, mode] = process.argv.slice(2);
  try {
    if (library === undefined || root === undefined || mode === undefined)
      throw new Error("Usage: CodeGraphIndexWorker.js <library> <root> <mode>");
    const result = await run(library, root, mode);
    process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result)}\n`);
    // CodeGraph's worker threads and timers needn't hold the process open.
    process.exit(0);
  } catch (cause: unknown) {
    process.stderr.write(
      `${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    process.exit(1);
  }
}
