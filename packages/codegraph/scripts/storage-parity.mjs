#!/usr/bin/env node
// Storage parity: index fixed projects and record every table and the
// answers to a fixed battery of queries, so two storage backends can be
// compared result for result (packages/codegraph-store/DESIGN.md).
//
//   node scripts/storage-parity.mjs record <out-dir>    with the backend
//        CODEGRAPH_STORAGE selects (SQLite by default)
//   node scripts/storage-parity.mjs compare <a> <b>     report differences
//
// Each project is copied to a temporary folder first, so no index is
// written into the repository. Two runs compare only when they index the
// same files: CODEGRAPH_PARITY_INPUTS names a folder of frozen copies (one
// subfolder per project), and CODEGRAPH_PARITY_HOME the CodeGraph package
// whose build runs (this one by default), e.g. the committed version. Volatile columns (timestamps, row ids) are
// left out and rows put in a stable order; nothing else is normalised.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const home = process.env.CODEGRAPH_PARITY_HOME ? resolve(process.env.CODEGRAPH_PARITY_HOME) : root;
const inputs = process.env.CODEGRAPH_PARITY_INPUTS ? resolve(process.env.CODEGRAPH_PARITY_INPUTS) : undefined;
const SOURCES = {
  "codegraph-src": join(root, "src"),
  "kernel-parity": join(root, "__tests__/fixtures/kernel-parity"),
  "payroll-go": join(root, "__tests__/fixtures/payroll-go"),
  "php-import-alias-static": join(root, "__tests__/fixtures/php-import-alias-static"),
  "factory-closure-ts": join(root, "__tests__/fixtures/factory-closure-ts"),
};
const PROJECTS = inputs
  ? Object.fromEntries(Object.keys(SOURCES).map((name) => [name, join(inputs, name)]))
  : SOURCES;
// Searches beyond the sampled names: separators FTS5 splits on, operators it
// strips, diacritics it folds, very common and absent words.
const SEARCH_EXTRA = ["stage_apply::run", "query.builder", "get-node", "Node AND edge", "résumé", "the", "is", "x", "zzqqxy", "parse json", "*", "ÄBC"];
// Columns whose values differ between runs by design.
const VOLATILE = new Set(["id", "updated_at", "modified_at", "indexed_at", "applied_at", "rowid"]);
const TABLES = {
  nodes: "SELECT * FROM nodes",
  edges: "SELECT * FROM edges",
  files: "SELECT * FROM files",
  unresolved_refs: "SELECT * FROM unresolved_refs",
  name_segment_vocab: "SELECT * FROM name_segment_vocab",
  synthesis_inputs: "SELECT * FROM synthesis_inputs",
};

// Object keys in a canonical order: key order isn't meaningful in an object
// (a GROUP BY's groups, a row's columns), only what the keys hold.
const canonical = (v) =>
  typeof v === "bigint"
    ? Number(v)
    : Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
        : v;
const stable = (value) => JSON.stringify(canonical(value));
const sortRows = (rows) => rows.map(stable).sort();
const strip = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !VOLATILE.has(k)).sort(([a], [b]) => a.localeCompare(b)));
// Ids are content hashes, stable across runs; edge ids are row numbers, so
// edges keep their endpoints, not their own id.
const nodeView = (n) => n && { id: n.id, kind: n.kind, name: n.name, file: n.filePath, line: n.startLine };

// CODEGRAPH_PARITY_PLANS=<file>, on SQLite: every SELECT the run prepares
// without an ORDER BY, with SQLite's plan for it. A plan's index fixed the
// order those rows came in, which DuckDB doesn't reproduce by itself.
const plans = process.env.CODEGRAPH_PARITY_PLANS ? new Map() : undefined;
function watchPlans(db, work) {
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/^\s*(WITH|SELECT)\b/i.test(sql) && !/ORDER BY/i.test(sql) && !plans.has(sql)) {
      try {
        const count = (sql.match(/\?/g) ?? []).length;
        const detail = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...new Array(count).fill(null)).map((p) => p.detail);
        plans.set(sql, detail);
      } catch (error) {
        plans.set(sql, [`(no plan: ${error.message})`]);
      }
    }
    return prepare(sql);
  };
}

const edgeView = (e) => e && { source: e.source, target: e.target, kind: e.kind, line: e.line ?? null, col: e.column ?? null };
const subgraphView = (g) => ({ nodes: [...g.nodes.keys()], edges: g.edges.map(edgeView), roots: g.roots });

/** A node's traversals, every list in the order CodeGraph returned it. */
function ordered(cg, id) {
  const pairs = (list) => list.map(({ node, edge }) => [node.id, edgeView(edge)]);
  return {
    callers: pairs(cg.getCallers(id, 2)),
    callees: pairs(cg.getCallees(id, 2)),
    usages: pairs(cg.findUsages(id)),
    impact: subgraphView(cg.getImpactRadius(id, 2)),
    callGraph: subgraphView(cg.getCallGraph(id, 2)),
    typeHierarchy: subgraphView(cg.getTypeHierarchy(id)),
    bfs: subgraphView(cg.traverse(id, { direction: 'both', maxDepth: 3, limit: 60 })),
    outgoing: subgraphView(cg.traverse(id, { direction: 'outgoing', maxDepth: 4, limit: 60 })),
    ancestors: cg.getAncestors(id).map((n) => n.id),
    children: cg.getChildren(id).map((n) => n.id),
  };
}

async function record(out) {
  const require = createRequire(import.meta.url);
  const { CodeGraph } = require(join(home, "dist/index.js"));
  mkdirSync(out, { recursive: true });
  for (const [name, source] of Object.entries(PROJECTS)) {
    const work = mkdtempSync(join(tmpdir(), `cg-parity-${name}-`));
    cpSync(source, work, { recursive: true });
    const started = performance.now();
    const cg = await CodeGraph.init(work, { index: false });
    if (plans) watchPlans(cg.db.getDb(), work);
    await cg.indexAll();
    const indexMs = Math.round(performance.now() - started);
    const db = cg.db.getDb();
    const tables = {};
    for (const [table, sql] of Object.entries(TABLES)) tables[table] = sortRows(db.prepare(sql).all().map(strip));
    // The battery: a fixed sample of functions and methods, by id.
    const sample = db
      .prepare("SELECT id, name FROM nodes WHERE kind IN ('function', 'method') ORDER BY id LIMIT 40")
      .all();
    const words = [...new Set(sample.map((n) => n.name.slice(0, 5)))].slice(0, 20);
    // Code files: documents are the doc layer, which the SQLite baseline
    // never indexed, and the sync below edits the first two of these.
    const files = db.prepare("SELECT path FROM files WHERE language <> 'markdown' ORDER BY path LIMIT 20").all().map((f) => f.path);
    // Storage sizes differ by backend and the update time by run.
    const { dbSizeBytes: _size, walSizeBytes: _wal, lastUpdated: _when, ...stats } = cg.getStats();
    const battery = {
      stats,
      codeMap: cg.getCodeMap(15),
      topDependedOn: cg.getTopDependedOn(20),
      fileDependencyPairs: sortRows(cg.getFileDependencyPairs()),
      circular: cg.findCircularDependencies().map((cycle) => [...cycle].sort()).map(stable).sort(),
      deadCode: sortRows(cg.findDeadCode().map(nodeView)),
      fileDependents: Object.fromEntries(files.map((f) => [f, [...cg.getFileDependents(f)].sort()])),
      fileDependencies: Object.fromEntries(files.map((f) => [f, [...cg.getFileDependencies(f)].sort()])),
      search: Object.fromEntries(words.map((w) => [w, cg.searchNodes(w, { limit: 10 }).map((r) => nodeView(r.node))])),
      nodes: Object.fromEntries(
        sample.map(({ id }) => [
          id,
          {
            callers: sortRows(cg.getCallers(id).map(({ node }) => nodeView(node))),
            callees: sortRows(cg.getCallees(id).map(({ node }) => nodeView(node))),
            usages: sortRows(cg.findUsages(id).map(({ node, edge }) => ({ node: nodeView(node), kind: edge.kind, line: edge.line }))),
            impact: [...cg.getImpactRadius(id, 2).nodes.keys()].sort(),
            // The same answers in the order they come back: a limit, or a
            // reader taking the first few, depends on it.
            ordered: ordered(cg, id),
            metrics: cg.getNodeMetrics(id),
          },
        ]),
      ),
    };
    // Search in depth: scores, multi-token and separator phrases, filters,
    // paging, and the explore miss diagnostics; then again after a sync that
    // re-indexes one file and drops another, which reorders score ties.
    const searching = () => {
      const pairs = words.slice(0, 8).map((w, i) => `${w} ${words[(i + 3) % words.length] ?? w}`);
      const queries = [...words, ...pairs, ...SEARCH_EXTRA];
      return {
        scored: Object.fromEntries(queries.map((q) => [q, cg.searchNodes(q, { limit: 40 }).map((r) => [r.node.id, r.score])])),
        functions: Object.fromEntries(
          words.slice(0, 6).map((w) => [w, cg.searchNodes(w, { limit: 25, kinds: ["function", "method"] }).map((r) => r.node.id)]),
        ),
        paged: Object.fromEntries(words.slice(0, 4).map((w) => [w, cg.searchNodes(w, { limit: 5, offset: 5 }).map((r) => r.node.id)])),
        misses: Object.fromEntries([...pairs, ...SEARCH_EXTRA].map((q) => [q, cg.getExploreMissDiagnostics(q)])),
      };
    };
    battery.searching = searching();
    // The explore tool end to end: its whole text answer, as an agent gets it.
    const { ToolHandler } = require(join(home, "dist/mcp/tools.js"));
    const tools = new ToolHandler(cg);
    battery.explore = {};
    for (const query of [words.slice(0, 3).join(" "), `${words[3] ?? ""} ${words[5] ?? ""}`.trim(), "how does the main entry point work"]) {
      const result = await tools.executeReadTool("codegraph_explore", { query });
      battery.explore[query] = (result.content ?? []).map((c) => c.text ?? "").join("");
    }
    if (files.length >= 2) {
      writeFileSync(join(work, files[0]), `${readFileSync(join(work, files[0]), "utf8")}\n`);
      rmSync(join(work, files[1]));
      await cg.sync();
      battery.afterSync = {
        nodes: sortRows(db.prepare(TABLES.nodes).all().map(strip)),
        searching: searching(),
      };
    }
    // Volatile parts of the battery: index times, paths of the temporary copy.
    const text = stable({ project: name, backend: cg.getBackend(), indexMs, tables, battery }).replaceAll(work, "<project>");
    writeFileSync(join(out, `${name}.json`), text);
    console.log(`${name}: ${tables.nodes.length} nodes, ${tables.edges.length} edges, indexed in ${indexMs} ms (${cg.getBackend()})`);
    cg.close();
    rmSync(work, { recursive: true, force: true });
  }
  if (plans) {
    const text = [...plans].map(([sql, detail]) => `${sql.replace(/\s+/g, " ").trim()}\n  ${detail.join("\n  ")}`).join("\n\n");
    writeFileSync(process.env.CODEGRAPH_PARITY_PLANS, `${text}\n`);
  }
}

/** The differences between two recordings, section by section. */
function compare(a, b) {
  let differences = 0;
  for (const file of readdirSync(a).filter((f) => f.endsWith(".json"))) {
    const left = JSON.parse(readFileSync(join(a, file), "utf8"));
    const right = JSON.parse(readFileSync(join(b, file), "utf8"));
    const sections = [
      ...Object.keys(left.tables).map((t) => [`table ${t}`, left.tables[t], right.tables?.[t]]),
      ...Object.keys(left.battery).map((k) => [`battery ${k}`, left.battery[k], right.battery?.[k]]),
    ];
    for (const [label, x, y] of sections) {
      const hx = createHash("sha256").update(stable(x)).digest("hex");
      const hy = createHash("sha256").update(stable(y ?? null)).digest("hex");
      if (hx === hy) continue;
      differences += 1;
      let detail = "";
      if (Array.isArray(x) && Array.isArray(y)) {
        const sy = new Set(y), sx = new Set(x);
        const only = (p, q) => p.filter((v) => !q.has(v));
        const missing = only(x, sy), extra = only(y, sx);
        detail = ` (${x.length} vs ${y.length} rows; only in first ${missing.length}, only in second ${extra.length})`;
        if (missing[0]) detail += `\n      first only:  ${String(missing[0]).slice(0, 300)}`;
        if (extra[0]) detail += `\n      second only: ${String(extra[0]).slice(0, 300)}`;
      }
      console.log(`${file.replace(/\.json$/, "")}: ${label} differs${detail}`);
    }
  }
  console.log(differences === 0 ? "identical" : `${differences} sections differ`);
  process.exitCode = differences === 0 ? 0 : 1;
}

/** Copies each project's current files into `out`: inputs to freeze. */
function freeze(out) {
  for (const [name, source] of Object.entries(SOURCES)) cpSync(source, join(out, name), { recursive: true });
  console.log(`froze ${Object.keys(SOURCES).length} projects in ${out}`);
}

const [command, x, y] = process.argv.slice(2);
if (command === "freeze" && x) freeze(resolve(x));
else if (command === "record" && x) await record(resolve(x));
else if (command === "compare" && x && y) compare(resolve(x), resolve(y));
else {
  console.error("Usage: storage-parity.mjs freeze <dir> | record <out-dir> | compare <a> <b>");
  process.exitCode = 2;
}
