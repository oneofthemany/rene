import { execFileSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, onTestFinished, test } from "vitest";

import { PythonSourceProvider } from "../../../src/python/PythonSourceProvider.js";
import {
  pythonResultSchemas,
  type PythonRequest,
} from "../../../src/domain/python/pythonSourceAnalysis.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const hostPython = (() => {
  try {
    return execFileSync("/bin/sh", ["-c", "command -v python3"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
})();
const it = test.skipIf(process.platform !== "linux" || hostPython === "");

const TREE: Record<string, string> = {
  "app/__init__.py": "",
  "app/db.py": "def _get_db():\n    pass\n\ndef write_row(r):\n    _get_db()\n",
  "app/worker.py": [
    "import asyncio, time",
    "from app import db",
    "",
    "def helper():",
    "    db.write_row(1)",
    "",
    "async def direct():",
    "    helper()",
    "",
    "async def handed_off():",
    "    await asyncio.to_thread(helper)",
    "",
    "async def sleeps():",
    "    time.sleep(1)",
    "",
    // Would print to stdout and corrupt the report if the tree were ever imported.
    "print('imported')",
    "",
  ].join("\n"),
};

const sourceTree = async () => {
  const root = await createTestTempDirectory("rea-python-src-");
  for (const [rel, src] of Object.entries(TREE)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  return root;
};

const providerWith = (environment: Record<string, string>) => {
  const provider = new PythonSourceProvider({ environment });
  onTestFinished(() => provider.close());
  return provider;
};

const scan = (provider: PythonSourceProvider, input: Record<string, unknown>) =>
  provider.execute({
    operation: "inspect_python_blocking_calls",
    input,
  } as PythonRequest);

it("finds a project seed reached from an async def, and only parses the tree", async () => {
  const root = await sourceTree();
  const provider = providerWith({ REA_PYTHON_COMMAND: hostPython });
  const result = await scan(provider, {
    root,
    blocking: [{ name: "app.db._get_db", reason: "DB lock" }],
  });
  if (!result.ok) throw result.error;
  const report = pythonResultSchemas.inspect_python_blocking_calls.parse(
    result.value.result,
  );
  const byFunction = Object.fromEntries(
    report.findings.map((f) => [f.function, f]),
  );
  expect(byFunction["app.worker.direct"]?.chain.map((c) => c.name)).toEqual([
    "app.worker.helper",
    "app.db.write_row",
    "app.db._get_db",
  ]);
  expect(byFunction["app.worker.sleeps"]?.chain).toEqual([
    { name: "time.sleep", reason: "sleeps" },
  ]);
  expect(byFunction["app.worker.handed_off"]).toBeUndefined();
  expect(report.files.scanned).toBe(3);
  expect(result.value.subject).toMatchObject({
    format: "directory",
    sha256: report.files.sha256,
  });
});

it("without the project seed, the default seeds still see time.sleep but not the DB", async () => {
  const root = await sourceTree();
  const result = await scan(providerWith({ REA_PYTHON_COMMAND: hostPython }), {
    root,
  });
  if (!result.ok) throw result.error;
  const report = pythonResultSchemas.inspect_python_blocking_calls.parse(
    result.value.result,
  );
  expect(report.findings.map((f) => f.function)).toEqual(["app.worker.sleeps"]);
});

it("skips a symlinked file instead of reading through it", async () => {
  const root = await sourceTree();
  const outside = await createTestTempDirectory("rea-python-outside-");
  await writeFile(
    join(outside, "evil.py"),
    "import time\nasync def f():\n    time.sleep(1)\n",
  );
  await symlink(join(outside, "evil.py"), join(root, "app", "link.py"));
  const result = await scan(providerWith({ REA_PYTHON_COMMAND: hostPython }), {
    root,
  });
  if (!result.ok) throw result.error;
  const report = pythonResultSchemas.inspect_python_blocking_calls.parse(
    result.value.result,
  );
  expect(report.files.skipped.map((s) => s.path)).toContain("app/link.py");
  expect(report.findings.some((f) => f.file === "app/link.py")).toBe(false);
});

it("refuses a root that is not a directory", async () => {
  const root = await sourceTree();
  const result = await scan(providerWith({ REA_PYTHON_COMMAND: hostPython }), {
    root: join(root, "app", "db.py"),
  });
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(JSON.stringify(projectAnalysisError(result.error))).toContain(
      "is not a directory",
    );
});

it("refuses an interpreter older than 3.8 before reading any source", async () => {
  const bin = await createTestTempDirectory("rea-python-stub-");
  const stub = join(bin, "python");
  await writeFile(stub, "#!/bin/sh\nprintf 'Python 2.7.18\\n'\n", {
    mode: 0o755,
  });
  const provider = providerWith({ REA_PYTHON_COMMAND: stub });
  expect(await provider.inspectAvailability()).toMatchObject({
    status: "unavailable",
    code: "unsupported_version",
  });
  const result = await scan(provider, { root: bin });
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(projectAnalysisError(result.error).code).toBe(
      "capability_unavailable",
    );
});

const APP: Record<string, string> = {
  "routes/api.py": [
    "def register(app):",
    "    @app.get('/api/items/{item_id}')",
    "    async def item(item_id): ...",
    "",
  ].join("\n"),
  "static/app.js": "fetch(`/api/items/${id}`);\nfetch('/api/gone');\n",
  "docs/guide.md":
    "# Guide\n## 1. Items\nSee `GET /api/items/{id}` and `missing_helper()`.\n## 3. Later\n## 2. Misplaced\n",
  "routes/notes.py":
    "# guide.md §1 holds the design; guide.md §9 does not exist\n",
  "config/config.yaml": "media:\n  enabled: false\n",
  "routes/config_routes.py": "MEDIA_DEFAULTS = {'enabled': True}\n",
};

const appTree = async () => {
  const root = await createTestTempDirectory("rea-python-app-");
  for (const [rel, src] of Object.entries(APP)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  return root;
};

const drift = (
  provider: PythonSourceProvider,
  input: Record<string, unknown>,
) =>
  provider.execute({
    operation: "inspect_python_docs_drift",
    input,
  } as PythonRequest);

it("reports a frontend call, a citation, a symbol and a misplaced heading from one tree", async () => {
  const root = await appTree();
  const result = await drift(providerWith({ REA_PYTHON_COMMAND: hostPython }), {
    root,
  });
  if (!result.ok) throw result.error;
  const report = pythonResultSchemas.inspect_python_docs_drift.parse(
    result.value.result,
  );
  expect(report.findings.map((f) => `${f.kind}: ${f.detail}`)).toEqual([
    "cite: cites guide.md §9; the doc has no section 9",
    "heading: section 2 comes after section 3 (line 4)",
    "route: frontend calls /api/gone; no backend route serves it",
    "symbol: doc names missing_helper(), defined nowhere in the tree",
  ]);
  expect(report).toMatchObject({ routes: 1, frontend_calls: 2, docs: 1 });
  expect(report.config).toEqual({ status: "not_requested", reason: null });
  expect(result.value.subject).toMatchObject({
    format: "directory",
    sha256: report.files.sha256,
  });
});

it("states that a config mirror was skipped rather than reporting it clean", async () => {
  const root = await appTree();
  const bin = await createTestTempDirectory("rea-python-noyaml-");
  // An interpreter without PyYAML: the host Python with every site directory hidden.
  const stub = join(bin, "python");
  await writeFile(stub, `#!/bin/sh\nexec ${hostPython} -S "$@"\n`, {
    mode: 0o755,
  });
  const result = await drift(providerWith({ REA_PYTHON_COMMAND: stub }), {
    root,
    config_mirrors: [
      { yaml: "config/config.yaml", module: "routes/config_routes.py" },
    ],
  });
  if (!result.ok) throw result.error;
  const report = pythonResultSchemas.inspect_python_docs_drift.parse(
    result.value.result,
  );
  expect(report.config.status).toBe("skipped");
  expect(report.findings.some((f) => f.kind === "config")).toBe(false);
  expect(result.value.limitations.join("\n")).toContain(
    "Config mirrors were not compared",
  );
});
