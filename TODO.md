## Now

- **Trim rene's CodeGraph copy.** Done: no git-hook installs, no update
  check, no agent installer (`install`/`uninstall`/`upgrade`/`prompt-hook`,
  `src/installer/`, `src/upgrade/`, `install.sh`/`.ps1`). The viewer stays
  (see the next item). Remaining candidates: release tooling (`scripts/build-bundle.sh`,
  `pack-npm.sh`, `npm-shim.js`, `local-install.sh`), the docs site (`site/`)
  and the hosted telemetry backends (`telemetry-worker/`,
  `telemetry-dashboard/`).
- **CodeGraph's viewer for all of rene (paused, plan agreed).** The viewer
  (`packages/codegraph/ui`, Svelte + @xyflow) reads through a `GraphAdapter`
  seam (`ui/src/lib/adapter.ts`, 13 read methods, `Wire*` shapes in
  `wire.ts`) with views for map, entry points, dead code, screens, steps and
  flow. rene's graphs each have their own schema (the shared application
  graph, `NativeInvestigationGraph`, the Android/Apple/Harmony inventories,
  call paths), and the `Wire*` shapes carry no Evidence or unknowns. Three
  steps:
  1. A neutral view-graph contract in `src/domain` (nodes, edges, Evidence,
     coverage, unknowns) that each producer projects to.
  2. A rene `GraphAdapter` over that contract, and the viewer mounted in the
     workbench, fed by CodeGraph first.
  3. The other producers (application graphs, native investigation graph,
     call paths) projected to the contract.
- **Telemetry for all of rene, into the journal (placeholder).** Every part
  of rene reports to the user's telemetry journal (sherloQ,
  `http://127.0.0.1:5007`), never off the machine. CodeGraph already does:
  `POST /ingest/codegraph`, one record per event. To design before code:
  - **One owner.** A rene telemetry module the parts share: the record
    shape, the journal sink (`POST /ingest/<topic>` with `{"records": [...]}`;
    loopback needs no token), fail-silent and never blocking a call.
  - **Topics, one per part:** `rene-mcp` (tool name, duration, outcome,
    provider; never arguments, paths or results), `rene-workbench` (bridge
    and agent-session events), `rene-history` (store start, crash, query
    timings), `rene-source-graph` (index builds, auto-sync timings),
    `rene-setup` (provider installs), and `codegraph`.
  - **Questions:** on by default or opt-in? One switch for all of rene
    (e.g. `REA_TELEMETRY_ENDPOINT`), and should rene's own CodeGraph
    processes stop forcing CodeGraph telemetry off? Who enables each new
    topic in the journal (it holds unknown topics until enabled)?
- **rene tools for the remaining built-ins.** The topic gate refuses Claude
  Code's Bash, Read, Write, Edit, Grep and Glob; still allowed until rene
  has a replacement: Read for images and PDFs (the `read_file` item below),
  WebFetch (`fetch_url`), NotebookEdit (`edit_notebook`) and WebSearch
  (`web_search`, backed by SearXNG in the container: needs a Containerfile
  change and a rebuild). Add each built-in to `RENE_REPLACEMENTS` in
  `frontend/topicGate.mjs` as its tool lands.
- **A long-running process tool.** Nothing in rene keeps a server up across
  calls (start, read output, stop, owned by rene). Needed to drive a web UI
  with the browser tools, e.g. CodeGraph's viewer.
- **Assessment summary from queries.** `summarize` (the Tools used table and
  pathways) and the topic tree still read every summary. The store now has
  one aggregate, `usage` (calls and last start per tool, used by the
  sidebar); the Tools used table can read it, and pathways need their own.
- **Browser scenarios can't move the mouse.** `capture_browser_scenario`
  has click, fill, press, select and wait actions but no hover or mouse
  move, so a bug that follows the pointer (the agent terminal's mouse
  reports) can only be driven with clicks and keys. Add a `move`/`hover`
  action.
- **Browser results too big for an agent.** `capture_browser_scenario` with
  network capture (80–170 KB) and `inspect_web_page` with accessibility text
  (260 KB) exceed what an agent can take inline, so every check went through
  a saved file and a script. Return a summary (step outcomes, request counts
  by method and path, WebSocket counts, errors) with the full Evidence kept
  for paging.
- **`read_file` can't show an image.** A PNG comes back as "binary" with a
  digest, so checking a screenshot (e.g. a workbench capture) needs Claude
  Code's own Read. Return image files as MCP image content.
- **Turn attribution.** `frontend/topics.mjs` files a turn under the last
  topic it declares. File calls under the topic in force when they were
  made, and list a turn under every topic it declared.
  `tests/boundary/workbenchTopics.test.ts` pins today's last-declared rule;
  change it with the fix.
- **Feed Evidence links.** Pathways and Evidence links stay empty because no
  call names Evidence. Add an `evidence` field to `record_topic` so a
  topic's conclusion cites the Evidence it rests on.

- **Measure the source-graph instruction.** Agents are now told to ask the
  source graph first. Compare tool calls, tokens and time on one real code
  question with and without it.

## Closing items (MCP → local CLI toolkit)

Finish these before the move off MCP is called done.

- **Lint warnings in touched code.** `bundleRuntime` in
  `scripts/bundle-runtime.mjs` is 120 lines (limit 100); split the rolldown
  plugin and the write options into their own functions. `topicTree` in
  `frontend/topics.mjs` has complexity 28 (limit 20); split turn filing,
  shared-key links and the hierarchy into helpers. Topic
  `65f6dabe-1a6f-4fee-b5d7-a0d7c4c81a18`.
- **Older lint warnings in files the move touches** (all present at
  `15cd20fda`): `frontend/server.mjs` is 1722 lines (limit 500) and
  `routeApi` (22), `callTool` (21) and `routeProjects` (30) are over the
  complexity limit of 20; `createTerminal` in `frontend/terminal.mjs` is 114
  lines (limit 100); `claudeEvents` in `src/toolbox/AgentConversations.ts`
  has complexity 26 (was 28).
- **Run the cli toolkit in a live workbench session.** Tested against the
  host rea only: the session daemon behind the container launcher
  (`frontend/container/rea`, through `podman exec -i`) is unverified, in
  particular that closing its stdin on the host ends it in the container.
- **Registered agents with the cli toolkit.** Agents without a session flag
  (Codex, Gemini CLI, OpenCode, …) now start without an MCP registration and
  get `rea` on `PATH`, the session daemon and history reporting. The root
  `AGENTS.md` now carries the instruction to use `rene call`, so the agents
  that read it (Claude Code, Copilot CLI, Codex) get it in any session, one
  the workbench started or one started by hand; before that only
  workbench-launched Copilot sessions were told, through
  `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`. Agents reading another file (Gemini
  CLI's `GEMINI.md`) still need their own way in, and none of them has a
  topic gate (that is Claude Code's hooks).
- **A workbench setting for the toolkit.** It is chosen by
  `REA_AGENT_TOOLKIT` in the workbench's environment; put it in the settings
  page beside the model source (local or cloud) when that lands.
- **Daemon keeps one Android provider per connection.** `rene daemon` serves
  each connection from the MCP transport's factory, which creates an Android
  analysis provider per server and closes them only at shutdown. Close each
  connection's provider when that connection ends.

## Roadmap

- **Link topics to code.** Map the files a topic's calls touched to source
  graph symbols, and show an open topic's blast radius
  (`analyze_source_impact`). The links come from graph ids, not similarity.
- **File the turns from before topics existed.** A declaration that names
  turns by their recorded identity (session and turn index), so the 59
  earlier turns can be filed without guessing.
- **CodeGraph on DuckDB.** Replace CodeGraph's SQLite store with a DuckDB
  store (a Rust appender, single writer, read-only readers), checked against
  the SQLite baseline.
- **Resume markers.** "Resume from here" on any turn in History, and a
  `resume_context` tool, so an agent can pick up earlier work.
- **The rest of the toolbox.** `fetch_url`, `web_search`, notebook editing,
  long-running processes and interactive browser actions, so agents can run
  on rene's tools alone.
- **Capture the other agents.** The workbench records Claude Code and Copilot
  CLI conversations; Codex, Gemini CLI and the other registration agents
  aren't captured yet. Add their readers to `src/toolbox/AgentConversations.ts`
  so the workbench and the conversation tools pick them up together.

## To check

- **Shift+Enter in the agent terminal.** Try it in the browser, and check
  whether Copilot CLI takes ESC+Enter as a new line (Claude Code does).
- **Topic tree in History.** Check how it looks with real topics.
- **rdk_vcpe's assessment.** Its line about `map_source_graph` failing with
  "Connection closed" is out of date since the read-only query servers;
  remove it there.
