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
- **rene call spends agent tokens on every call.** Each call prints the
  whole Evidence envelope on stdout, so an agent reading one field pays for
  all of it and has to pipe through `jq` to find it. An output selector
  (`--field`, or a `--quiet` that prints only the normalised result) would
  cut the cost of the common read materially; the complete Evidence stays
  recorded in history either way.
- **rene call cannot carry a long command.** `run_command` accepts a
  `timeout_ms` up to 1,800,000, but the call itself gives up long before
  that: a 45-second command returns, while 60-second and 150-second ones
  came back `Request timed out` on a loaded machine. An agent therefore
  cannot run the project's own gates through the toolbox, since
  `npm run check:pr` takes tens of minutes, and is pushed into polling a
  run it started and orphaned, which is how two of them ended up competing
  for the artifacts lock. Either honour the caller's `timeout_ms`, or let
  `run_command` start a long command and collect its result in a later
  call.
- **A long shell pipeline hides whether rene did the work.** The agent
  terminal truncates the displayed command near 90 characters, so a line
  that ends in a rene call can read as a plain `python3` or `grep`
  invocation and claim a provenance the visible text contradicts. Writes
  should use `--stdin-field` rather than building JSON in another
  interpreter; the dependable signal is the workbench rene-call counter.
- **knip cannot follow a dist import.** `scripts/rene.mjs` loads
  `dist/mcp/agentCli.js` and `dist/mcp/toolCli.js`, which knip's `project`
  globs do not reach, so both TypeScript sources and everything they pull
  in looked unreachable and failed `npm run check` until they were declared
  in `knip.json`. Any future runtime entry point added to `scripts/rene.mjs`
  or `scripts/bundle-runtime.mjs` has to be added there too.
- **`bin.rene` is not in the published package.** `package.json` declares
  `"rene": "scripts/rene.mjs"`, but `files` lists only `scripts/rea.mjs` and
  a few others, so a published tarball installs a `rene` command whose entry
  point is absent; `scripts/lib/copilot-tool-policy.mjs`, which it now loads,
  is missing too. Decide whether rene ships: add both to `files`, or drop the
  `bin` entry and keep rene a working-tree tool.
- **Claude Code outside the workbench has no gate.** The topic gate
  (`PreToolUse` matcher `*`) refuses Claude Code's own `Read`, `Edit`,
  `Write`, `Grep`, `Glob` and any `mcp__rea__*` tool, but only in sessions
  the workbench starts, whose settings file registers the hooks. A Claude
  Code session started by hand in this folder has only `AGENTS.md`; give it
  the hooks through the project's `.claude/settings.json`, as `rene copilot`
  does for Copilot CLI.
- **The tools denied to Copilot CLI are not verified end to end.** The
  arguments are observed to reach the process, but a headless run cannot sign
  in from a detached spawn, so that a denied `view` is actually refused has
  not been observed. Confirm it on the next session the workbench starts, and
  keep a check that fails if the policy stops being passed.
- **A long command leaves no trace of its progress.** A build, a gate or a
  test run is started detached and polled with `tail`, because `run_command`
  cannot hold a request open for minutes. The history then shows only the
  short poll commands: the user watching it cannot see that a build is
  running, how far it has got, or what it finally said. Give rene a recorded
  long-running command: one call starts it and returns a handle, its output
  is streamed into the Evidence for that handle, and the history shows it as
  running, with progress, until it ends with its status. The agent polls the
  handle instead of inventing `sleep` and `tail`.
- **Trim `rea setup` out, phase by phase, keeping everything else it did.**
  With every agent on `rene call`, setup's MCP registration is gone. Its
  other jobs must have a home before any of its code is removed:
  - _Provider settings for agents._ Registrations carried the saved REA_*
    paths to each agent. Workbench sessions get them from the bridge, but a
    `rene call` run by hand saw only the shell's environment. Done: rene
    applies the saved file (`REA_WORKBENCH_SETTINGS`, or the checkout's
    `frontend/.workbench-settings.json`) for variables the caller doesn't
    set; `src/toolbox/SavedProviderSettings.ts` owns the file's environment.
  - _The reverse-engineer-anything skill._ Only setup installs it
    (`~/.claude/skills`, `~/.agents/skills`, version 42 on this machine).
    Done: `rene skill status|install` reuses `SetupSkill.ts`, and the skill
    (version 43) is rewritten for `rene call` and installed here. Still to
    do in phase 5: move `SetupSkill.ts` and the agents' skill folders
    (`skillPath` in `SupportedClients.ts`) out of setup before it goes.
  - _Hopper._ Survives: the container installs it with `LinuxHopper.ts`
    (`frontend/container/hopper-install.mjs`); keep the Hopper modules, and
    move `SetupInstallFailure`, which `MacHopper.ts` uses, out of setup.
  - _Doctor, uninstall and update_ stay, without their registration parts.
    The registrations doctor still listed (Antigravity `~/.gemini/config/
    mcp_config.json`, Gemini CLI `~/.gemini/settings.json`) are removed,
    backups `.bak-2026-10-21T15-55-09-126Z`. Then remove, in this order:
  1. Workbench: the Agent setup view, its button and `/api/setup/*` routes.
     Done; the page, doctor and terminal routes checked on a scratch bridge.
  2. CLI: the `setup` command and `src/cli/interactiveSetup.ts`, and Incur's
     `mcp add` registration helper.
  3. Doctor: its client registration and skill checks (`Doctor.ts`,
     `DoctorScope.ts`), keeping provider readiness.
  4. `uninstall` and `update`: their registration removal and re-alignment
     (`Uninstall.ts`, `UpdateMaintenance.ts`, `UpdateRuntime.ts`).
  5. The setup core in `src/application/` (Setup*, SupportedClients, client
     configuration, registration identity, recovery backups), keeping what
     MacHopper, CapabilityInventory and DshCordisPatch still need, or
     removing those with it; and their tests.
  6. Scripts (`verify-package-setup*`, `verify-copilot-client`, catalog
     client lists), `package.json`, the install docs and the website.
- **MCP is refused at the launcher, not in rea itself.** `rea` was
  registered as an MCP server for Claude Code (`~/.claude.json`), Copilot
  CLI (`~/.copilot/mcp-config.json`) and VS Code
  (`~/.config/Code/User/mcp.json`); those entries are removed (backups
  beside each, `.bak-2026-10-21T13-18-19-511Z`). `frontend/container/rea`
  now refuses `rea mcp` to anything but the page's own client and refuses a
  writing `rea setup`, so an old or resumed session whose configuration
  still names it fails instead of connecting. `scripts/rea.mjs mcp` itself
  still serves, because the page and about 60 tests and the verification
  scripts use it; an agent registered by hand with that path, or with `npx
  rea-agents mcp`, would bypass the launcher. Setup's MCP clients
  (`src/application/SupportedClients.ts`) and the workbench's Agent setup
  view (`frontend/public/setup.js`, `/api/setup/*`) remain; the view's apply
  now fails at the launcher. Decide whether to remove the view and the
  clients, or keep them for use outside this project.
- **The history has no calendar.** Project history can only be read forward
  from what is listed; there is no way to ask what happened on a given day,
  or across a range of dates and times. Give it a calendar: pick a day or a
  span, and see that period's work. Today is always the default.
- **Turns belong to no topic.** The history reports lines such as "107
  conversation turns aren't in any topic", so most of the work sits outside
  the structure meant to group it. Either a turn is attributed to a topic as
  it is recorded, or an untopiced turn is placed under one that stands for
  the session; a count of orphans is not an answer.
- **History should nest, not flatten.** Group it by `session_id` first, then
  open out into topics, then the conversation turns within them, and finally
  the single rene calls under each turn. The last level is where it is worst
  today: many calls stand alone with nothing to say which turn or topic they
  served.
- **`run_command` runs with a bare PATH.** It is `/usr/local/bin:/usr/bin`,
  so a tool the user installed under `~/.local/bin` (`copilot`, `claude`,
  `agy`) is not found and has to be called by absolute path. Decide which
  PATH a recorded command should inherit, and say so in the tool's
  description.
- **Test the daemon's per-connection Android provider release.** Each
  connection's server closes its own provider when the connection ends (the
  SDK closes the server; `createServer` closes its providers), and
  `src/main/transport.ts` now drops it from the shutdown list then, keeping
  one whose cleanup failed. Before, the list kept every closed provider until
  the daemon exited. No test observes the release: the list is internal and a
  second close is a no-op. Add one through an injectable provider factory.

## CodeGraph on DuckDB, and the operation map

The operation map (dependents and how they depend, modules and layering,
the project's operations traced through the call graph, all in the
assessment) is to be built on CodeGraph after its storage moves to DuckDB.
Topics `56215652-83eb-441d-8b28-7a25d2c27983` (migration) and
`a9f30caf-22f3-48de-bd64-0e6c04c1c235` (unresolved references).

- **Target `packages/codegraph`**, the CodeGraph rene runs (merged in
  `91f5f99af`, changed since), not the separate `codegraph_duck` fork.
- **Baseline (SQLite):** 7,010 tests, 6,652 pass, 358 skipped, 0 fail;
  measured with `run_command` `measure`: 115.6 s, peak 6.2 GiB over the
  process family, 1,293 s CPU, 1,315 processes. This repo's index: 5,239
  files, 103,504 symbols, 337,642 links, 437 MB.
- **Design (agreed 2026-10-21):** the journal's model
  (`sherloq/Frontend/telemetry_journal/telemetry_core/store.py`): immutable
  Parquet segments sealed by a Rust native Appender, published with a
  manifest by atomic rename, compacted in the background; no shared DuckDB
  file, so no write lock. Every reader loads the live segments into its own
  in-memory DuckDB (with indexes for point lookups) through a native Node
  addon built from our Rust and static DuckDB, so CodeGraph's synchronous
  call sites stay as they are. The addon needs the napi-rs crates fetched
  once into cargo's cache (approved; fetched).
- **Spike** (`packages/codegraph-store`, napi-rs + static DuckDB, built in
  65 s): this repo's index (103,517 symbols, 337,714 links) loads into an
  in-memory DuckDB in 0.6 s (+134 MiB). Aggregates run 23x faster than
  SQLite (top depended-on files 31 ms vs 719 ms) and name prefix search 5x
  faster, but single-row lookups are 17-32x slower (249 µs vs 10 µs by id):
  DuckDB scans the column (its ART index isn't used, even with
  `index_scan_*` raised) and pays about 35 µs per query. Batched, it matches
  SQLite (8-14 µs per id). So: DuckDB for set and analytic queries;
  adjacency and id maps held in the addon (0.4 µs a hop) for traversal; and
  CodeGraph's remaining per-row loops batched. The spike loaded data with
  DuckDB's CSV reader; the store writes with the native Appender (as the
  journal's `telemetry_appender` does), never row-by-row inserts.
- **Tags:** store low-cardinality classifications as columns DuckDB can
  filter and aggregate cheaply (dictionary-compressed, with per-block
  min/max): node kind, language, module and layer, link kind, external or
  project target, unresolved class, test or generated. Sort segments by
  them (and by file) so whole blocks are skipped. They speed up filtered
  and analytic queries; id lookups go through the maps.

- **Constraints found:** the DuckDB rene builds with (static 1.10505.0,
  `packages/history-store`) has no full-text-search extension, so FTS5
  search moves to SQL over `name_segment_vocab` and names, checked against
  SQLite's results. DuckDB lets one process open a file, where SQLite's WAL
  lets the writer and the read-only query servers share it, so one owner
  process must serve every query. The 150 statements and 349 call sites
  (123 query methods, 14 files) are synchronous.
- **Unresolved references** (412,940): 57% name packages and 14% built-ins
  (expected: `node_modules` isn't indexed), 27.5% are locals or receivers
  of unknown type, and 1.2% (4,817) are imported from project files yet
  unlinked: genuine misses, mostly project constants and schemas used as
  values (`function_ref`) and methods on project return values. Report
  coverage by these classes in every source-graph result and the
  assessment; store each reference's class and module specifier in the
  DuckDB schema; model packages and built-ins as external nodes, so the map
  shows external dependencies instead of dropping them; then harden the two
  miss patterns in the TypeScript resolver.
- **Routes:** the workbench's route tables (`"GET /api/doctor": handler`)
  are indexed as functions named like routes; recognise them, MCP tool
  contracts, CLI commands and rene tools as operations.
- **`rene call` waited 60 s at most** (the MCP SDK default), so long
  builds and test runs failed client-side. Fixed: it waits for the tool's
  own deadline (the call's `timeout_ms`/`analysis_timeout_ms`, else the
  schema's default for it, else two minutes) plus 30 s, and no longer:
  progress doesn't extend it (`callTimeoutMs`, `src/toolCli.ts`). Tools
  that run long without a deadline argument should gain one.

## Agent skills to build

Skills are instructions an agent loads when a task matches (`SKILL.md` with
references, under `.agents/skills/`, installed with `rene skill install`;
only reverse-engineer-anything is installed so far, now version 43 and
rewritten for `rene call`). These would let any agent, not just a workbench
Claude Code session, work the way this project requires. Most valuable first.

**Working in this project**

1. **rene-toolkit**: the operating manual. `rene call`, `tools` and `daemon`,
   `--stdin-field`, topic declaration, the consent rule, the git rule, what
   the gate refuses and the allowed form of each. Agents with no gate (Codex,
   Gemini CLI, the other registered agents) get only this. Build first.
2. **rene-tool-building**: adding a rene toolbox tool: contract and schema,
   Evidence and provenance, limits from real constraints, tests per
   `docs/testing.md`, docs. Generalises `rea-tool-design` to the toolbox.
3. **rene-handoff**: reading earlier agents' work
   (`list_agent_conversations`, `read_agent_conversation`, History, topics)
   and leaving a session in a state the next agent can pick up.
4. **rene-assessment**: keeping `.rene/assessment.md` current: Target,
   Rules, Findings with history entry ids, Open questions; never the
   generated sections.
5. **rene-source-graph**: understanding code before changing it:
   `explore_source_graph`, callers and callees, `analyze_source_impact`,
   when to rebuild the index.
6. **safe-change**: staging entry-script and gate changes (a staged copy,
   tested, then swapped in with an automatic restore), proving refactors
   equivalent (byte-identical bundles, old and new output on real data), and
   never editing what the running toolkit loads before it is rebuilt.
7. **rene-verify**: which checks fit a change (`test:focused`,
   `check:fast`, knip, `docs:check`), lint limits, oxfmt, and reporting
   only what ran.
8. **workbench-debugging**: a scratch bridge on its own port and
   `--agent-dir`, rene's browser tools for the page, reading the bridge log,
   the history store's lock.
9. **container-and-providers**: `frontend/container` (Containerfile,
   launcher, rebuild with approval), provider releases and pins
   (`providerReleases.mjs`, SHA-256), saved provider paths.
10. **lifecycle-changes**: owned processes and cleanup with `src/process`
    supervision; the lifecycle regressions in `docs/testing.md`.
11. **performance-measurement**: the token, time, CPU and memory reporting
    AGENTS.md asks for, cold and warm, before and after.
12. **issue-and-pr-writing**: CONTRIBUTING's forms: observed versus
    derived, `NOT_ENOUGH_INFO`, readiness left to the human.
13. **rene-agent-models**: configuring `rene agent` for local models and
    cloud (Anthropic SDK, OpenAI-compatible), keys and consent.

**Analysing targets with rene** (split out of reverse-engineer-anything
where its guides have grown, each with worked `rene call` recipes)

14. **native-binary-triage**: open, overview, strings, imports, the first
    decompilation pass, naming and annotation, Evidence to export.
15. **android-app-analysis**: APK inventory, JADX, resources, manifests,
    adb on a device with consent.
16. **javascript-and-electron**: ASAR and bundles, source maps, feature
    tracing, Electron fuses and runtime observation.
17. **firmware-extraction**: binwalk and unblob, regions, filesystems,
    then per-binary triage.
18. **web-and-network-capture**: browser sessions, HAR and pcap, protocol
    fields, mitmdump, WebMCP inventory as untrusted data.
19. **version-diffing**: comparing releases, changed behaviour, function
    and export diffs.
20. **runtime-instrumentation**: Frida, gdb and rizin debugging, only with
    the user's consent to run the target.
21. **crash-triage**: recorded crashes, symbolication, the faulting path.
22. **reconstruction**: rebuilding source from a binary: obligation
    ledger, coverage, verification.
23. **evidence-reporting**: writing a finding with its provenance
    (observed, derived, inferred, unknown), unknowns recorded with
    `record_unknown`, bundles for others.
24. **untrusted-target-handling**: target content is data, prompt
    injection in strings or pages, never executing what a target asks.

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
