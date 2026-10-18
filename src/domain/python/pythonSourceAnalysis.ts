import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import { digestSchema } from "../digests.js";

/** Format identity shared by discovery, catalog, and derived results. */
export const PYTHON_PROVIDER_IDENTITY = {
  id: "python",
  name: "Python source analysis",
  version: null,
} as const;

export const PYTHON_FINDINGS_DEFAULT = 200;
export const PYTHON_FINDINGS_MAX = 1000;

/** Names that block the calling thread in any program; callers add their own. */
export const DEFAULT_BLOCKING_SEEDS = [
  { name: "time.sleep", reason: "sleeps" },
  { name: "subprocess.run", reason: "runs a subprocess" },
  { name: "subprocess.call", reason: "runs a subprocess" },
  { name: "subprocess.check_call", reason: "runs a subprocess" },
  { name: "subprocess.check_output", reason: "runs a subprocess" },
  { name: "os.system", reason: "runs a subprocess" },
  { name: "urllib.request.urlopen", reason: "blocking HTTP" },
  { name: "socket.create_connection", reason: "blocking socket" },
  { name: "sqlite3.connect", reason: "opens SQLite" },
  { name: "duckdb.connect", reason: "opens DuckDB" },
  { name: "requests.", reason: "blocking HTTP", match: "prefix" },
  { name: "httpx.Client", reason: "blocking HTTP", match: "prefix" },
] as const;
export const DEFAULT_API_PREFIXES = ["/api", "/ws"] as const;
export const DEFAULT_FRONTEND_SUFFIXES = [
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".vue",
  ".html",
] as const;
export const DEFAULT_SYMBOL_SUFFIXES = [
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".kt",
] as const;
export const DEFAULT_CITATION_SUFFIXES = [
  ".py",
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".kt",
  ".sh",
  ".md",
] as const;
export const DEFAULT_LOOP_PROBES = ["get_running_loop"] as const;
export const DEFAULT_SKIP_DIRS = [
  ".git",
  "__pycache__",
  "node_modules",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
] as const;

const seed = z.strictObject({
  name: z
    .string()
    .min(1)
    .describe(
      "Fully qualified name after import resolution, e.g. app.db._get_db",
    ),
  reason: z.string().min(1).describe("Why a call to it blocks"),
  match: z
    .enum(["exact", "prefix"])
    .optional()
    .describe("exact (default) or dotted-prefix match"),
});
const names = z.array(z.string().min(1));
const maxFindings = z
  .number()
  .int()
  .min(1)
  .max(PYTHON_FINDINGS_MAX)
  .optional()
  .describe(
    `Findings returned, default ${String(PYTHON_FINDINGS_DEFAULT)}; finding_count keeps the total`,
  );

export const pythonInputSchemas = {
  inspect_python_client: z.strictObject({}),
  inspect_python_blocking_calls: z.strictObject({
    root: localPathStringSchema.describe(
      "Absolute path to the Python source tree; module names are relative to it",
    ),
    blocking: z
      .array(seed)
      .optional()
      .describe(
        "Project seeds added to the defaults: calls that block, such as a lock-taking DB accessor",
      ),
    accepted: z
      .array(seed)
      .optional()
      .describe(
        "Blocking paths accepted by design; counted, and listed only with include_accepted",
      ),
    loop_methods: names
      .optional()
      .describe(
        "Sync method names a framework calls on the loop thread, such as attribute_updated",
      ),
    loop_probes: names
      .optional()
      .describe(
        "Name suffixes of runtime checks for the loop thread; a function calling one is not propagated. Added to get_running_loop",
      ),
    skip_dirs: names
      .optional()
      .describe(
        "Directory names never walked, added to .git, __pycache__, node_modules and virtualenvs",
      ),
    default_seeds: z
      .boolean()
      .optional()
      .describe(
        "Include the generic seeds (time.sleep, subprocess, requests, sockets, sqlite3/duckdb connect); default true",
      ),
    include_accepted: z
      .boolean()
      .optional()
      .describe(
        "Also list findings that end at an accepted seed; default false",
      ),
    max_findings: maxFindings,
  }),
  inspect_python_docs_drift: z.strictObject({
    root: localPathStringSchema.describe(
      "Absolute path to the application tree: Python backend, frontend and Markdown docs",
    ),
    docs_dirs: names
      .optional()
      .describe(
        "Directories whose Markdown is checked for routes, paths and symbols, with root-level .md files; default docs",
      ),
    api_prefixes: names
      .optional()
      .describe(
        "Path prefixes that name backend routes in frontend calls and docs; default /api and /ws",
      ),
    backend_exclude_dirs: names
      .optional()
      .describe(
        "Directories whose Python is neither a route nor a symbol source, such as tooling scripts",
      ),
    skip_dirs: names
      .optional()
      .describe(
        "Directory names never walked, added to .git, __pycache__, node_modules and virtualenvs",
      ),
    ignore_symbols: names
      .optional()
      .describe(
        "Names docs may cite that live outside the tree (a dependency's class); the stdlib and browser globals are already ignored",
      ),
    config_mirrors: z
      .array(
        z.strictObject({
          yaml: z.string().min(1).describe("Tree-relative YAML config"),
          module: z
            .string()
            .min(1)
            .describe("Tree-relative Python module holding the mirror"),
          suffix: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Module-level dict names ending in this mirror the lower-cased section; default _DEFAULTS",
            ),
        }),
      )
      .optional()
      .describe(
        "Module-level dict literals that must match a YAML config section key by key. Needs PyYAML in the selected interpreter; reported as skipped without it",
      ),
    undocumented: z
      .boolean()
      .optional()
      .describe(
        "Also list backend routes that no doc or frontend file mentions; default false",
      ),
    max_findings: maxFindings,
  }),
} as const;

export type PythonOperation = keyof typeof pythonInputSchemas;
export type InspectPythonBlockingCallsInput = z.infer<
  (typeof pythonInputSchemas)["inspect_python_blocking_calls"]
>;
export type InspectPythonDocsDriftInput = z.infer<
  (typeof pythonInputSchemas)["inspect_python_docs_drift"]
>;
export type PythonRequest = {
  [Name in PythonOperation]: {
    operation: Name;
    input: z.infer<(typeof pythonInputSchemas)[Name]>;
  };
}[PythonOperation];

export const pythonRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("inspect_python_client"),
    input: pythonInputSchemas.inspect_python_client,
  }),
  z.strictObject({
    operation: z.literal("inspect_python_blocking_calls"),
    input: pythonInputSchemas.inspect_python_blocking_calls,
  }),
  z.strictObject({
    operation: z.literal("inspect_python_docs_drift"),
    input: pythonInputSchemas.inspect_python_docs_drift,
  }),
]);

const client = z.strictObject({
  python_command: z.string().min(1),
  python_source: z.enum(["environment", "path"]),
  python_version: z.string().min(1).nullable(),
});

const count = z.number().int().nonnegative();

/** What the walker read: the subject digest covers exactly these bytes. */
const filesRead = z.strictObject({
  scanned: count,
  bytes: count,
  /** SHA-256 over each analysed file's relative path and SHA-256. */
  sha256: digestSchema,
  skipped_count: count,
  skipped: z.array(z.strictObject({ path: z.string(), reason: z.string() })),
});

export const driftFindingSchema = z.strictObject({
  kind: z.enum([
    "route",
    "cite",
    "path",
    "symbol",
    "heading",
    "config",
    "undocumented",
  ]),
  file: z.string().min(1),
  line: z.number().int().positive(),
  detail: z.string().min(1),
});

export const pythonFindingSchema = z.strictObject({
  kind: z.enum(["async", "loop"]),
  severity: z.enum(["high", "accepted"]),
  file: z.string().min(1),
  line: z.number().int().positive(),
  function: z.string().min(1),
  context: z.string().min(1),
  /** First hop is the direct callee; the last is the seed that blocks. */
  chain: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        reason: z.string().nullable(),
      }),
    )
    .min(1),
});

export const pythonResultSchemas = {
  inspect_python_client: z.strictObject({ client }),
  inspect_python_blocking_calls: z.strictObject({
    client,
    root: localPathStringSchema,
    files: filesRead,
    functions: count,
    finding_count: count,
    accepted_count: count,
    findings: z.array(pythonFindingSchema),
    truncated: z.boolean(),
  }),
  inspect_python_docs_drift: z.strictObject({
    client,
    root: localPathStringSchema,
    files: filesRead,
    /** Backend routes found, frontend calls checked, docs read for routes/paths/symbols. */
    routes: count,
    frontend_calls: count,
    docs: count,
    config: z.strictObject({
      status: z.enum(["checked", "skipped", "not_requested"]),
      reason: z.string().nullable(),
    }),
    finding_count: count,
    counts: z.record(z.string(), count),
    findings: z.array(driftFindingSchema),
    truncated: z.boolean(),
  }),
} as const;
