# Concepts, docs and subsystems in CodeGraph

22 Oct 2026 · @Sean, revised with Claude Code and Copilot CLI

## What changed from the first draft

The first draft of this plan added **Graphify** as a second provider beside
CodeGraph: `src/graphify/GraphifyProvider.ts` wrapping the `graphify` CLI,
`src/contracts/conceptGraphToolContracts.ts`, a `uv tool install` layer in the
container, a Parquet sidecar under `.graphify/`, and a join from concepts to
symbols on file path and line range.

That is no longer the plan. **CodeGraph absorbs the capabilities instead.**
The reasons:

- CodeGraph is already rene's own: merged into `packages/codegraph` (MIT), with
  its storage rebuilt on DuckDB/Parquet in `packages/codegraph-store`. New node
  kinds and tables are schema changes we own, so the draft's hardest
  constraint — "keep Graphify out of CodeGraph's store", because a schema
  mismatch makes the writer move the store aside and reindex — disappears.
- CodeGraph already has the pattern for non-tree-sitter sources. Beside its
  tree-sitter languages it has hand-written extractors (`liquid-extractor.ts`,
  `mybatis-extractor.ts`, `razor-extractor.ts`, `astro-extractor.ts`,
  `svelte-extractor.ts`, `vue-extractor.ts`, `cfml-extractor.ts`,
  `dfm-extractor.ts`), dispatched by detected language in
  `src/extraction/tree-sitter.ts`. A documentation extractor is one more of
  those.
- One graph means one query path. The draft's section on two tools each telling
  the agent "always use me" stops being a problem rather than being managed:
  `explore_source_graph` stays the first call, and the new answers come from
  the same index.
- No second CLI, no second output folder, no second install. The draft already
  had to forbid `graphify install` and `graphify claude install`, because their
  skill and `PreToolUse` hook make the agent call Graphify directly, bypassing
  `rene call` and breaking the Evidence rule in AGENTS.md.

**Graphify itself is not installed and its source is not fetched.** We take the
ideas described in the first draft — docs in the graph, EXTRACTED vs INFERRED
provenance, communities, god nodes — and build them natively. Nothing below
depends on a Graphify download or on its `graph.json` field names, which the
first draft itself flagged as unchecked.

## Where this sits

Current state, verified in the working tree at `f5b807bd9`:

- CodeGraph is reached only through rene tools: `src/codegraph/CodeGraphProvider.ts`,
  contracts in `src/contracts/sourceGraphToolContracts.ts`, registered by
  `src/server/registerSourceGraphTools.ts`.
- The DuckDB schema (`packages/codegraph/src/db/schema.duckdb.sql`) holds
  `nodes`, `edges`, `files`, `unresolved_refs`, `name_segment_vocab`,
  `node_search`, `node_tokens`, `synthesis_inputs`, `generation_summaries` and
  `project_metadata`.
- `generation_summaries(key, value)` already exists and is the landing place for
  whole-graph answers: `f5b807bd9` writes the dominant file, top route file, the
  15-entry code map, the counts behind `getStats` and the hub list into it as
  the writer seals each version. Subsystems and god nodes are the same shape of
  work.
- `NODE_KINDS` and `EDGE_KINDS` in `packages/codegraph/src/types.ts` cross the
  native kernel boundary as **indexes** (`src/extraction/kernel/layout.ts`), so
  new kinds must be **appended, never reordered**.
- Markdown is not in `LANGUAGES` and no Markdown is indexed today.
- `inspect_python_docs_drift` (`src/domain/python/pythonSourceAnalysis.ts`,
  contract in `src/contracts/python/pythonToolContracts.ts`) already does
  doc-to-code drift, but only for Python web apps.
- `frontend/assessment.mjs` writes the assessment's `## Code map` section from
  `map_source_graph`.

## What gets built

### 1. Docs in the graph — built

`packages/codegraph/src/extraction/markdown-extractor.ts`, dispatched from
`extractFromSource` for `.md` and `.markdown`, and covered by
`__tests__/markdown-extractor.test.ts` (13 tests).

What was built differs from the sketch below in three ways, each deliberate:

- The document reuses the existing `file` node kind, as every other extractor
  does, so only `section` was appended to `NODE_KINDS` — not `document`.
  File-record tracking and the file metrics keep working unchanged.
- Only inline code spans and link targets are mined. A fenced block is
  illustration, not a claim about this project's code, and prose produces false
  links. Comments citing a doc (`see design.md §3`) are not read yet: that is a
  change to each language extractor, not to this one.
- A code span becomes a reference only when it is shaped like a symbol or a
  path. `npm run check:fast` and `--deny-tool` are left alone rather than
  guessed at.

`markdown` is deliberately absent from `CODE_FAMILY`, so `gateLanguageMatch`
returns early and doc references are not refused by the cross-language boundary
gate. `documents` is deliberately absent from `CALL_KINDS` and from the
relevance edge sets: a doc naming a symbol is not call flow, and is not usage.

Unresolved doc references are kept, not dropped — they are what step 2 reads.

The original sketch, for the parts not yet built:

A Markdown extractor beside the other hand-written ones. Each doc becomes a
node; each heading becomes a section node. Its edges are deterministic, read
straight from the text:

- code spans and calls it names (`foo()`, `Class.method`, `` `Name` ``) link to
  those symbols;
- file paths it mentions link to file nodes;
- links to other docs link to those docs;
- code comments citing a doc or section (`see design.md §3`, `ADR-0012`) link
  from the symbol to that section.

These are the first draft's EXTRACTED edges. Unresolved mentions are recorded as
unresolved references with their class, as code references already are — a doc
naming a symbol that does not exist is a finding, not a dropped edge.

Schema work: append `document` and `section` to `NODE_KINDS`, and a
`documents` edge kind to `EDGE_KINDS` (appended, for the kernel wire contract).
Doc text is **target content**: it is marked untrusted wherever it reaches an
agent, exactly as CodeGraph's source excerpts are.

PDFs are out of scope here; they could follow later through rene's existing file
tools.

### 2. Docs drift for every language — built

With docs in the graph, drift is a set query over the index rather than a
language-specific analysis. Shipped as `source_docs_drift`
(`codegraph_docs_drift` upstream), it reports three kinds of finding:

- `path` — the document cites a file the index does not have.
- `symbol` — it cites a symbol no file declares.
- `undocumented` — an exported symbol no document mentions, ranked by how many
  places call it. Only when asked for: on most projects this is the bulk of the
  code, and the whole list is noise rather than a finding.

The signal is a `documents` reference the resolver attempted and could not match
(`status = 'failed'`). Whether it was reaching for a file or a symbol is decided
by `isFilePathReference` in `packages/codegraph/src/utils.ts` — the same predicate
the file-path resolution strategy uses, moved there so the two cannot disagree
and report a reference resolved as a path as a missing symbol.

The answer leads with how many documents and headings were indexed. Without
that, a project whose Markdown was never indexed reports no broken references,
which reads like health rather than an unmade check.

Two of the first draft's checks are deferred, not dropped:

- `cite` — citations to sections that are gone. The extractor strips the
  `#fragment` from a link target, so the anchor never reaches the index. Doing
  this properly means keeping the anchor on the reference and teaching the
  resolver to match it against `section` nodes by GitHub-style slug — which
  also earns doc-to-section edges, useful to step 3. Worth its own change.
- `heading` — heading order. `section` nodes carry their ranges, so this is
  available, but it is a style finding rather than drift and did not earn a
  place in the first cut.

`inspect_python_docs_drift` keeps its framework-specific checks (routes no
backend serves, config defaults) until the general tool covers them.

### 3. Subsystems

Community detection (Louvain or Leiden) over the call and import graph, computed
by the writer as it seals each version and stored in `generation_summaries`
beside the code map and hub list. Every node gets a subsystem label that queries
can filter and group on — the module and layer tag columns the TODO already
planned, and the low-cardinality, dictionary-compressed columns the DuckDB
design asks for.

### 4. God nodes and bridges

The most depended-on nodes already exist as a per-version summary. Add the nodes
that connect subsystems (bridges) as another summary at seal time.

### 5. The tools

No new tool family. The existing ones gain the answers:

| Question                                                         | Tool                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| How code works, who calls what, impact of a change               | `explore_source_graph` (unchanged, still the first call)                    |
| Which subsystem something belongs to, and which docs describe it | `explore_source_graph` results name each symbol's subsystem and linked docs |
| Subsystems, god nodes, bridges, doc coverage                     | `map_source_graph`                                                          |
| Docs that no longer match the code                               | the generalised docs-drift tool                                             |

`map_source_graph` gaining subsystems, god nodes and linked docs is what lets
`frontend/assessment.mjs` write an `## Architecture` section beside the existing
`## Code map`, from one more call to a tool it already makes. That is the
"operation map" in TODO.md, and it replaces the first draft's `GRAPH_REPORT.md`:
the agent reads it where it already looks first.

Freshness follows rene's existing rule — each query syncs the index first — not
Graphify's git hooks. The workbench already sets git hooks for agent sessions
through git's environment configuration, and whether the two would conflict is
unchecked.

### 6. The model pass, last and optional

Everything above is extracted, not guessed. The first draft's INFERRED edges
come from a model reading docs. That can come later through rene's own agent
providers, **off by default**, recorded as `inference` confidence with an
explicit limitation on the Evidence, never mixed with extracted edges. The
choice of local or cloud provider is the user's; nothing auto-selects a backend.

## Costs and limits

- **Divergence from upstream CodeGraph.** It becomes clearly its own thing, and
  merging upstream releases gets harder. Given how much is already rewritten,
  that is largely true today.
- **Parity.** The SQLite parity baseline covers existing features only. Doc
  nodes and subsystem labels change the index, so these features need their own
  tests rather than parity.
- **Ideas, not code.** This is built from what the first draft describes
  Graphify doing. Comparing against a real Graphify run would still need the
  download, and nothing here depends on it.

## Order

1. ~~The Markdown extractor and doc edges.~~ Built — see step 1.
2. ~~The docs-drift query and tool.~~ Built — see step 2.
3. Subsystems and bridges as per-version summaries, then `map_source_graph` and
   the assessment's `## Architecture` section.
4. Explore enrichment: subsystem and linked docs on each result.
5. The optional model pass.

## Still open from the DuckDB work

These are prerequisites in effort, not in design, and are tracked in TODO.md:

- **Bulk inserts** — indexing still costs about 3x the CPU of SQLite; the store
  must write through the native Appender, never row by row.
- **CodeGraph's tests on DuckDB**, with their raw SQLite SQL ported first.
- **The status text.**
- **Explore's remaining stages.** After the set-based rework, explore on rene's
  index runs 2.45 s of store time in memory (was 4.4 s) and 6.3 s read in place
  (was 15.8 s), both at about 120 queries per call. The in-memory reader stays
  the default; Parquet in place is available with
  `CODEGRAPH_STORE_READER=parquet`.
