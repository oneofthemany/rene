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

export const sourceSymbolCallersInputSchema = z.strictObject({
  project_path: projectPath,
  symbol,
  file: file.optional(),
  limit: z.number().int().min(1).max(500).default(20),
});

export const sourceSymbolCalleesInputSchema = sourceSymbolCallersInputSchema;

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
