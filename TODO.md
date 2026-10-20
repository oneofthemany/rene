## Now

- **Switch to the DuckDB history.** Built and tested (`rene-history`,
  `packages/history-store`). Stop the workbench, run
  `node ~/.cache/rene-scratch/import-history-backup.mjs` to import the live
  JSON history and the 2026-10-20 backup, then start it again. Until then the
  old store keeps deleting the oldest calls past 500.
- **History queries.** `list` still returns every summary; add paging and
  filters (by tool, topic, time) so the page and the assessment ask for what
  they show.
- **Turn attribution.** `frontend/topics.mjs` files a turn under the last
  topic it declares. File calls under the topic in force when they were
  made, and list a turn under every topic it declared.
- **Feed Evidence links.** Pathways and Evidence links stay empty because no
  call names Evidence. Add an `evidence` field to `record_topic` so a
  topic's conclusion cites the Evidence it rests on.

## Roadmap

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
- **Agent git hooks on the host.** They rely on git's `reference-transaction`
  hook (git 2.31 or later). REA's environment has git 2.56; confirm the
  host's git, which the agents use outside the container.

## Housekeeping

- **IntelliJ `.iml` files.** `rene.iml`, `bridge/bridge.iml`,
  `packages/packages.iml` and `tests/tests.iml` are tracked; untrack them
  (`git rm --cached`) and add `*.iml` to `.gitignore` beside `.idea/`.
