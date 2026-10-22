import { z } from "zod";

import { localPathStringSchema } from "./localPath.js";

/**
 * Source graphs: a project's symbols, files and the calls between them, as
 * the CodeGraph provider indexes them (tree-sitter extraction into a local
 * store in the project's `.codegraph/` folder). The query operations ask the
 * project's CodeGraph server; index_source_graph builds or updates the index
 * the queries read.
 */
export const CODEGRAPH_PROVIDER_IDENTITY = {
  id: "codegraph",
  name: "CodeGraph source graph",
  version: null,
} as const;

const projectPath = localPathStringSchema.describe(
  "Absolute path of the project folder (the one holding .codegraph/).",
);
const symbol = z
  .string()
  .min(1)
  .max(500)
  .describe("Name of the function, method, class or other symbol.");
const file = z
  .string()
  .min(1)
  .max(1000)
  .describe(
    "Narrow to the definition in this file (path or suffix) when several symbols share the name.",
  );

export const SOURCE_SYMBOL_KINDS = [
  "function",
  "method",
  "class",
  "interface",
  "type",
  "variable",
  "route",
  "component",
] as const;

export const searchSourceSymbolsInputSchema = z.strictObject({
  project_path: projectPath,
  query: z
    .string()
    .min(1)
    .max(500)
    .describe("Symbol name or part of one, e.g. auth, signIn, UserService."),
  kind: z.enum(SOURCE_SYMBOL_KINDS).optional(),
  limit: z.number().int().min(1).max(200).default(10),
});

/** Callers and callees ask the same question of one symbol, in two directions. */
export const sourceSymbolNeighborsInputSchema = z.strictObject({
  project_path: projectPath,
  symbol,
  file: file.optional(),
  limit: z.number().int().min(1).max(500).default(20),
});

export const sourceChangeImpactInputSchema = z.strictObject({
  project_path: projectPath,
  symbol,
  file: file.optional(),
  depth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(2)
    .describe("Levels of dependents to follow."),
});

export const readSourceNodeInputSchema = z
  .strictObject({
    project_path: projectPath,
    symbol: symbol
      .optional()
      .describe(
        "Symbol to read: its location, signature and caller/callee trail. Omit it and pass file to read a file.",
      ),
    file: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        "A file path or basename. Alone, the file's source with line numbers and the files that depend on it; with symbol, the definition in this file.",
      ),
    include_code: z
      .boolean()
      .default(false)
      .describe("Symbol mode: include the symbol's full body."),
    offset: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("File mode: first line, counting from 1."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe("File mode: lines returned (up to 2000)."),
    symbols_only: z
      .boolean()
      .default(false)
      .describe(
        "File mode: the file's symbol map and dependents instead of its source.",
      ),
    line: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Symbol mode: the definition at or around this line."),
  })
  .refine((input) => input.symbol !== undefined || input.file !== undefined, {
    message: "Pass symbol, file, or both.",
    path: ["symbol"],
  });

export const exploreSourceGraphInputSchema = z.strictObject({
  project_path: projectPath,
  query: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "Symbol names, file names or a short question about the code, e.g. AuthService loginUser session-manager.",
    ),
  max_files: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(12)
    .describe("Files the source is drawn from."),
});

export const listSourceFilesInputSchema = z.strictObject({
  project_path: projectPath,
  path: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe("Only files under this folder, relative to the project."),
  pattern: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Only files matching this glob, e.g. **/*.test.ts."),
  format: z.enum(["tree", "flat", "grouped"]).default("tree"),
  include_metadata: z.boolean().default(true),
  max_depth: z.number().int().min(1).max(100).optional(),
});

export const sourceGraphStatusInputSchema = z.strictObject({
  project_path: projectPath,
});

export const mapSourceGraphInputSchema = z.strictObject({
  project_path: projectPath,
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(15)
    .describe("Entries in each ranking."),
});

export const sourceGraphDocsDriftInputSchema = z.strictObject({
  project_path: projectPath,
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(25)
    .describe("Findings per kind."),
  include_undocumented: z
    .boolean()
    .default(false)
    .describe(
      "Also report exported symbols no document mentions. Off by default: on most projects that is the bulk of the code, not a finding.",
    ),
});

const count = z.number().int().nonnegative();

/**
 * An orientation map of a project's index, parsed from CodeGraph's
 * codegraph_map: totals, files and symbols per language, the files the most
 * other files depend on and the symbols called from the most places (test
 * and generated files are left out of both rankings).
 */
export const sourceGraphMapResultSchema = z.strictObject({
  project_path: z.string(),
  upstream_tool: z.literal("codegraph_map"),
  files: count,
  symbols: count,
  links: count,
  /** When the index was last built or synced; null when CodeGraph has no time. */
  last_indexed_at: z.string().nullable(),
  languages: z.array(
    z.strictObject({ language: z.string(), files: count, symbols: count }),
  ),
  most_depended_on_files: z.array(
    z.strictObject({ file: z.string(), dependent_files: count }),
  ),
  most_called_symbols: z.array(
    z.strictObject({
      name: z.string(),
      kind: z.string(),
      file: z.string(),
      line: count,
      callers: count,
    }),
  ),
});
export type SourceGraphMapResult = z.infer<typeof sourceGraphMapResultSchema>;

/** codegraph_map's JSON as CodeGraph writes it; parsed once, here. */
const upstreamCodeMapSchema = z.object({
  files: count,
  symbols: count,
  links: count,
  lastIndexedAt: z.number().nullable(),
  languages: z.array(
    z.object({ language: z.string(), files: count, symbols: count }),
  ),
  mostDependedOnFiles: z.array(
    z.object({ file: z.string(), dependents: count }),
  ),
  mostCalledSymbols: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      file: z.string(),
      line: count,
      callers: count,
    }),
  ),
});

/** The map from codegraph_map's text; throws when it isn't that JSON. */
export function parseSourceGraphMap(
  projectPath: string,
  text: string,
): SourceGraphMapResult {
  const map = upstreamCodeMapSchema.parse(JSON.parse(text));
  return sourceGraphMapResultSchema.parse({
    project_path: projectPath,
    upstream_tool: "codegraph_map",
    files: map.files,
    symbols: map.symbols,
    links: map.links,
    last_indexed_at:
      map.lastIndexedAt === null
        ? null
        : new Date(map.lastIndexedAt).toISOString(),
    languages: map.languages,
    most_depended_on_files: map.mostDependedOnFiles.map((entry) => ({
      file: entry.file,
      dependent_files: entry.dependents,
    })),
    most_called_symbols: map.mostCalledSymbols,
  });
}

/** What a documentation finding says has come apart. */
export const sourceGraphDriftKindSchema = z.enum([
  "path",
  "symbol",
  "undocumented",
]);
export type SourceGraphDriftKind = z.infer<typeof sourceGraphDriftKindSchema>;

/**
 * Where a project's documentation and its code have come apart, parsed from
 * CodeGraph's codegraph_docs_drift.
 *
 * Markdown is indexed like any other language, so a citation in prose to a
 * file or symbol the index no longer has is a reference the resolver tried
 * and failed: `path` when it was reaching for a file, `symbol` otherwise.
 * `undocumented` runs the other way — exported code no document mentions —
 * and is only reported when asked for.
 *
 * `documents` and `sections` say how much prose was actually indexed, so an
 * unindexed project reads as an unmade check rather than a clean bill.
 * `broken_references` counts the whole index; `findings` is capped per kind,
 * and `truncated` says when the cap bit.
 */
export const sourceGraphDocsDriftResultSchema = z.strictObject({
  project_path: z.string(),
  upstream_tool: z.literal("codegraph_docs_drift"),
  documents: count,
  sections: count,
  resolved_references: count,
  broken_references: count,
  counts: z.strictObject({
    path: count,
    symbol: count,
    undocumented: count,
  }),
  findings: z.array(
    z.strictObject({
      kind: sourceGraphDriftKindSchema,
      /** The document for a broken citation; the code file for undocumented. */
      file: z.string(),
      line: count,
      detail: z.string(),
    }),
  ),
  truncated: z.boolean(),
});
export type SourceGraphDocsDriftResult = z.infer<
  typeof sourceGraphDocsDriftResultSchema
>;

/** codegraph_docs_drift's JSON as CodeGraph writes it; parsed once, here. */
const upstreamDocsDriftSchema = z.object({
  docs: count,
  sections: count,
  resolvedReferences: count,
  brokenReferences: count,
  counts: z.object({ path: count, symbol: count, undocumented: count }),
  findings: z.array(
    z.object({
      kind: sourceGraphDriftKindSchema,
      file: z.string(),
      line: count,
      detail: z.string(),
    }),
  ),
  truncated: z.boolean(),
});

/** The drift from codegraph_docs_drift's text; throws when it isn't that JSON. */
export function parseSourceGraphDocsDrift(
  projectPath: string,
  text: string,
): SourceGraphDocsDriftResult {
  const drift = upstreamDocsDriftSchema.parse(JSON.parse(text));
  return sourceGraphDocsDriftResultSchema.parse({
    project_path: projectPath,
    upstream_tool: "codegraph_docs_drift",
    documents: drift.docs,
    sections: drift.sections,
    resolved_references: drift.resolvedReferences,
    broken_references: drift.brokenReferences,
    counts: drift.counts,
    findings: drift.findings,
    truncated: drift.truncated,
  });
}

/** What a query returns: CodeGraph's answer, as text from the project. */
export const sourceGraphQueryResultSchema = z.strictObject({
  project_path: z.string(),
  upstream_tool: z.string(),
  text: z.string(),
});

export const indexSourceGraphInputSchema = z.strictObject({
  project_path: projectPath,
  mode: z
    .enum(["build", "sync"])
    .default("sync")
    .describe(
      "build: index the whole project from scratch (creating .codegraph/ when it is missing). sync: update an existing index with the files added, changed or removed since.",
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(60 * 60_000)
    .default(30 * 60_000)
    .describe("The indexer and everything it started are stopped after this."),
});

const indexProblem = z.strictObject({
  message: z.string(),
  file_path: z.string().nullable(),
  severity: z.string().nullable(),
  code: z.string().nullable(),
});

export const indexSourceGraphResultSchema = z.strictObject({
  project_path: z.string(),
  mode: z.enum(["build", "sync"]),
  codegraph_version: z.string().nullable(),
  files: z.number().int().nonnegative(),
  nodes: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  database_bytes: z.number().int().nonnegative().nullable(),
  files_indexed: z.number().int().nonnegative().nullable(),
  files_added: z.number().int().nonnegative().nullable(),
  files_modified: z.number().int().nonnegative().nullable(),
  files_removed: z.number().int().nonnegative().nullable(),
  problems: z.array(indexProblem),
  problems_total: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
});

export type IndexSourceGraphInput = z.infer<typeof indexSourceGraphInputSchema>;
export type IndexSourceGraphResult = z.infer<
  typeof indexSourceGraphResultSchema
>;
