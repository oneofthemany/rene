## Now

- **Run CodeGraph's own tests in rene's checks.** `packages/codegraph`
  has its own suite (Objective-C, Solidity and extraction: 770 tests pass),
  but no rene script runs it. Decide where it belongs (`check:pr`, a turbo
  task) given its run time. 13 of its test files commit in throwaway temp
  repos (CodeGraph itself only reads git), so they fail inside agent
  sessions; the task that runs them should drop the inherited `GIT_CONFIG_*`
  for that child only.
- **Trim rene's CodeGraph copy.** Done: no git-hook installs, no update
  check, no agent installer (`install`/`uninstall`/`upgrade`/`prompt-hook`,
  `src/installer/`, `src/upgrade/`, `install.sh`/`.ps1`). The viewer stays
  (see the next item). Remaining candidates: release tooling (`scripts/build-bundle.sh`,
  `pack-npm.sh`, `npm-shim.js`, `local-install.sh`), the docs site (`site/`)
  and the hosted telemetry backends (`telemetry-worker/`,
  `telemetry-dashboard/`). Known failing before the trim:
  `explore-cross-call-dedup` (re-sends lines on a second call) and
  `bundle-launcher` (needs `zip`).
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
- **CodeGraph's tests inside agent sessions.** Its 13 commit tests see the
  session's agent hooks, so they fail there. Decide whether the suite's
  sandbox (`__tests__/setup-home-sandbox.ts`) should drop the inherited
  `GIT_CONFIG_*` for its throwaway repos.
- **Assessment summary from queries.** `summarize` (the Tools used table and
  pathways) and the topic tree still read every summary; give the store
  aggregate queries for them.
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
