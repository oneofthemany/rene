import {
  pythonInputSchemas,
  pythonResultSchemas,
} from "../../domain/python/pythonSourceAnalysis.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";

/** Python source analysis served by a caller-supplied interpreter. */
export const PYTHON_TOOL_CONTRACTS = [
  {
    name: "inspect_python_client",
    ...toolContractMetadata("inspect_python_client"),
    description:
      "Inspect the caller-selected Python interpreter: command, selection source and version. Reads no source. REA never installs Python; select it with an absolute REA_PYTHON_COMMAND or python3 from PATH.",
    kind: "python-provider",
    inputSchema: pythonInputSchemas.inspect_python_client,
    outputSchema: evidenceResultOf(pythonResultSchemas.inspect_python_client),
    examples: [{ title: "Check the Python interpreter", input: {} }],
  },
  {
    name: "inspect_python_blocking_calls",
    ...toolContractMetadata("inspect_python_blocking_calls"),
    description:
      "Find blocking work reachable from an asyncio event loop in a Python source tree: each async def, scheduler callback (call_soon, call_later, add_done_callback) or named loop-listener method that calls, directly or through same-tree sync functions, a blocking seed. Generic seeds cover time.sleep, subprocess, requests, urllib, sockets and sqlite3/duckdb connect; add project seeds (a lock-taking accessor) and accepted-by-design paths. Each finding has file, line, caller and a witness chain to the seed. to_thread/run_in_executor hand-offs and lambda bodies are not calls; functions that probe for the loop at runtime are not propagated. Derived Evidence: source is parsed by REA's bundled helper under the caller's Python 3.8+ (-I -S -B, prlimit on Linux), never imported or executed, symlinks not followed; the subject digest covers exactly the files analysed. Static only: injected callables are invisible.",
    kind: "python-provider",
    inputSchema: pythonInputSchemas.inspect_python_blocking_calls,
    outputSchema: evidenceResultOf(
      pythonResultSchemas.inspect_python_blocking_calls,
    ),
    examples: [
      {
        title: "Scan a service for loop-blocking calls",
        input: { root: "/src/service" },
      },
      {
        title: "Add a project lock and an accepted path",
        input: {
          root: "/src/service",
          blocking: [{ name: "app.db._get_db", reason: "takes the DB lock" }],
          accepted: [
            {
              name: "app.cache._get_db",
              reason: "short reads accepted on the loop",
            },
          ],
          loop_methods: ["attribute_updated"],
          loop_probes: ["_on_event_loop"],
        },
      },
    ],
  },
  {
    name: "inspect_python_docs_drift",
    ...toolContractMetadata("inspect_python_docs_drift"),
    description:
      "Cross-check what a Python web application's docs, frontend and backend each say exists. Reports route: a frontend fetch/api call or a doc naming an API path that no FastAPI/Starlette-style route serves (APIRouter prefixes applied, parameters matched); cite: a source comment citing name.md §N where the doc or section (heading or numbered list item) is gone; path: a doc naming a tree file that doesn't exist (anchored .gitignore entries excepted); symbol: a doc naming func() or Class.method() defined nowhere in the Python, JavaScript or Kotlin; heading: a numbered heading below its predecessor; config: a module-level *_DEFAULTS dict that disagrees key by key with its YAML config section (needs PyYAML in the interpreter); and, on request, routes nothing mentions. Derived Evidence: REA's bundled helper reads the tree under the caller's Python 3.8+ with prlimit, parsing source without importing or executing it and never following symlinks; the subject digest covers exactly the files read. Heuristic, regex-based for docs and frontend.",
    kind: "python-provider",
    inputSchema: pythonInputSchemas.inspect_python_docs_drift,
    outputSchema: evidenceResultOf(
      pythonResultSchemas.inspect_python_docs_drift,
    ),
    examples: [
      {
        title: "Check docs and frontend against the backend",
        input: { root: "/src/app" },
      },
      {
        title: "Include a config mirror and unmentioned routes",
        input: {
          root: "/src/app",
          config_mirrors: [
            { yaml: "config/config.yaml", module: "routes/config_routes.py" },
          ],
          undocumented: true,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
