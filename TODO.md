## Now

- **Run CodeGraph's own tests in rene's checks.** `packages/codegraph`
  has its own suite (Objective-C, Solidity and extraction: 770 tests pass),
  but no rene script runs it. Decide where it belongs (`check:pr`, a turbo
  task) given its run time. 13 of its test files commit in throwaway temp
  repos (CodeGraph itself only reads git), so they fail inside agent
  sessions; the task that runs them should drop the inherited `GIT_CONFIG_*`
  for that child only.
- **Trim rene's CodeGraph copy, stages 2 and 3.** Done: CodeGraph never
  installs git hooks (removal of old ones only, never in a session's hooks
  folder) and has no update check. Next: the agent installer
  (`src/installer/`, the `install`/`uninstall`/`upgrade`/`prompt-hook`
  commands, `src/upgrade/`, `preuninstall`, `install.sh`/`install.ps1`),
  then the viewer (`ui` command, `src/ui-server/`, the `ui/` workspace and
  `build:ui`).
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
