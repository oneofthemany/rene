# REA Workbench (prototype)

A local browser UI for REA. A small Node bridge runs one `rea mcp` child over
stdio and makes its tools available to the page over loopback HTTP. REA keeps
ownership of input validation, sessions, Evidence and cleanup. The bridge passes
MCP requests through unchanged.

```sh
frontend/start.sh              # stop the old one, install if needed, rebuild, offer providers, start, open browser
frontend/start.sh --stop       # stop the running workbench
```

Running `start.sh` again restarts the workbench. It records the bridge in
`frontend/.workbench.pid` (pid and process start time). On the next run it
stops that process before rebuilding: SIGTERM first, which closes REA's MCP
child, then SIGKILL after 15 s if needed. It stops the process only if the pid,
the start time and the `frontend/server.mjs` command all still match. A pid
alone can belong to an unrelated process after a reboot or pid reuse, so a
pidfile that doesn't match is removed and nothing is killed. A bridge started
directly with `node frontend/server.mjs` isn't tracked; if it holds the port,
the new bridge exits with a "port in use" message.

`start.sh` checks Node.js against `package.json#engines` and npm against
`packageManager`. It runs `npm ci` only when `scripts/check-dependency-install.mjs`
reports that installed dependencies don't match `package-lock.json`, then runs
`npm run build:cached`, offers to download missing analysis providers (see
[Installing providers](#installing-providers)), builds and starts the REA
container (see [The REA container](#the-rea-container)) and starts the bridge
with `--open`. It never installs Node.js or npm; a mismatch stops the script with
instructions. Use `--dry-run` to see the plan first, `--install-providers` to
download without asking, and `--no-install`, `--no-build`, `--no-providers`,
`--no-container` or `--no-open` to skip steps. Anything after `--` is passed to the
bridge:

```sh
frontend/start.sh --dry-run -- --port 0 --max-concurrent 2
```

To start the bridge directly:

```sh
node frontend/server.mjs       # prints http://127.0.0.1:4417/#token=...
```

| Flag               | Default                      | Purpose                                    |
| ------------------ | ---------------------------- | ------------------------------------------ |
| `--port`           | `4417`                       | Loopback port (`0` picks a free one)       |
| `--rea`            | `../scripts/rea.mjs`         | REA dispatcher to run as `<rea> mcp`       |
| `--timeout-ms`     | `600000`                     | Per-call timeout; resets on each progress  |
| `--max-concurrent` | `4`                          | Calls sent to REA at once; the rest queue  |
| `--open`           | off                          | Open the UI in the default browser         |
| `--pid-file`       | none                         | Remove this pid file on exit if it is ours |
| `--history-dir`    | `./.workbench-history`       | Where settled calls are stored             |
| `--settings`       | `./.workbench-settings.json` | Provider paths saved from the page         |
| `--providers-dir`  | see below                    | Where provider downloads are unpacked      |
| `--projects-dir`   | see [Projects](#projects)    | Where each project's history is stored     |

REA reads provider configuration (`REA_*`, Ghidra/IDA paths and similar) from
its environment. Set them in the shell you start the bridge from, or choose
them on the Providers page, which saves them for later launches.

## Installing providers

REA itself never downloads Java, Ghidra, JADX or Kuna; it reads their
locations from its environment. The workbench can fetch them, so a fresh
checkout ends up fully usable:

| Provider          | Release                          | Download | Sets                 |
| ----------------- | -------------------------------- | -------- | -------------------- |
| Java              | Eclipse Temurin JDK 21.0.12.1+1  | 198 MiB  | `JAVA_HOME`          |
| Ghidra            | 12.1.4                           | 543 MiB  | `GHIDRA_INSTALL_DIR` |
| jadx-headless-mcp | 0.7.1 (the JAR REA pins)         | 41 MiB   | `REA_JADX_MCP_JAR`   |
| Kuna              | 1.833 (the release REA verified) | 21 MiB   | `REA_KUNA_COMMAND`   |

It also installs the tools REA's guides name for other kinds of targets, at
the versions they name:

| Tool      | Release                                | Sets                     |
| --------- | -------------------------------------- | ------------------------ |
| Apktool   | 3.0.3 JAR, run with the Java above     | `REA_APKTOOL_COMMAND`    |
| WABT      | 1.0.42                                 | `REA_WABT_BIN_DIRECTORY` |
| pwntools  | 4.15.0, pyelftools 0.33, Unicorn 2.1.2 | `REA_PWNTOOLS_PYTHON`    |
| Unblob    | 26.6.4, with sasquatch for SquashFS    | `REA_UNBLOB_COMMAND`     |
| mitmproxy | 12.2.3 (mitmdump)                      | `REA_MITMDUMP_COMMAND`   |
| DuckDB    | 1.5.6 CLI, updated to newer 1.x        | `REA_DUCKDB_COMMAND`     |
| Wakaru    | 1.14.0 (Linux x64 only)                | `REA_WAKARU_COMMAND`     |

The Python tools are built with your `uv` into relocatable environments from
pinned versions (uv checks PyPI's hashes), with a uv-managed Python 3.13 kept
in `<providers-dir>/python`. Every install ends with a version check.

Each release, its URL and its SHA-256 are pinned in `providerReleases.mjs` for
Linux x64 and arm64. A download that differs in size or digest is discarded.
Archives are unpacked with `tar`/`unzip` into a staging folder and published by
one rename into `--providers-dir`, by default
`${XDG_DATA_HOME:-~/.local/share}/rea-workbench/providers/<id>-<version>/`,
with a marker recording the release. Nothing is written outside that folder
and the settings file, and no administrator access is used. Installed paths
are saved through the same settings file as the Provider paths form (with its
`.bak`), and the workbench restarts REA with them.

- **From the terminal:** `node frontend/install-providers.mjs` prints the plan
  (what, where, URLs and digests) and asks before downloading; `--yes`,
  `--dry-run` and `--only jdk,ghidra` are available. `start.sh` runs it after
  the build. A declined or failed install doesn't stop the workbench.
- **From the page:** Providers → **Install providers** lists each provider's
  state, preselects missing ones and shows progress. **Cancel** stops the
  download; finished providers are kept. Closing the page doesn't stop an
  install, and reopening it waits for that install to finish.

By default only providers with nothing configured are chosen; one REA already
finds somewhere else is left alone unless you pick it. Choosing Ghidra or JADX
also chooses Java when REA has no `JAVA_HOME`. Running it again downloads
nothing for providers already installed.

### What you use

The Providers page starts with **What you use**: a switch for each engine and
tool (`choices.mjs` lists them), and the **Default analysis engine**. A tool
that is off isn't offered by the installer or `start.sh`, and its `rea doctor`
checks show as "Not used" rather than counting as something to fix; nothing
is uninstalled. Everything starts on except IDA, which needs your own licence.
The default engine is saved as `REA_ANALYSIS_PROVIDER` ("Let REA choose" is
`auto`, which asks when several engines can open a program); only engines
that are on can be chosen. Agents get it the next time you run Agent setup,
which records it in their registration. Both are kept in the `--settings`
file, with its `.bak`.

### Updates

After installing, the terminal installer checks for newer releases REA accepts
and asks before taking them; on the page, **Check for updates** does the same.
Only Java 21 (Temurin) patch releases, Ghidra 12.1.x and DuckDB 1.x are
offered: REA requires Ghidra 12.1 and a DuckDB 1.x CLI at least as new as the
DuckDB that wrote a database, and JADX and Kuna stay on the versions REA pins
and verified. Each candidate's size and SHA-256 come from the upstream release
metadata (Adoptium's API, GitHub's release asset digest) and are shown before
you approve. An update installs like any provider; once it is in use its
release is recorded in `<providers-dir>/pins.json` and the older install is
removed. A pin only ever moves a provider forward from the built-in release.
Use `--no-updates` to skip the check; a check that can't reach upstream says
so instead of reporting "up to date".

### The REA container

REA itself runs in a podman container, `rene`, built from
`frontend/container/Containerfile` on Fedora 44. The image carries what can't
go in a home folder on a read-only (rpm-ostree) host, so the host itself never
changes:

- Node.js 24 (`.nvmrc`), and `ps` for REA's process supervision
- a build toolchain for the agent toolbox's `run_command`: npm, Rust
  (`cargo`, `rustc`) and gcc-c++/make, from Fedora's repositories; Cargo's
  cache stays in the mounted `~/.cargo`
- Hopper's official demo with Xvfb, installed by this fork's own Linux
  installer (publisher PGP signature, launcher identity); its evidence goes to
  `~/.cache/rea/hopper-releases` so `rea doctor` accepts the launcher offline
- binwalk 3.1, sigrok-cli 0.7.2, gdb with pwndbg 2026.09.15 (from its
  source release and hash-locked `uv.lock`), tshark/capinfos, rizin,
  objdump, a baseline DuckDB 1.5.6 CLI (official release, pinned SHA-256;
  the workbench's updatable DuckDB install takes precedence), Unblob's
  extractors, Chromium and adb, with the `REA_*` paths REA needs set in the
  image

The container runs as your user ID with your home folder mounted at the same
path and the host's network, so file paths, the settings file and the tools
installed under `~/.local/share` work unchanged. Files outside your home
folder are not visible to it. REA runs from this checkout through the mount,
so `npm run build:cached` takes effect without rebuilding the image.

`frontend/container/rea` is the launcher: it starts the container if needed,
forwards provider settings (`REA_*`, `JAVA_HOME`, `GHIDRA_*`, `HOPPER_*`) and
runs `scripts/rea.mjs` inside it over stdio. The workbench bridge uses it, and
it sets `REA_REGISTRATION_ENTRYPOINT`, so `rea setup` (the Agent setup page)
registers agents to run the launcher. Agents registered earlier still run REA
on the host; `rea doctor` reports them as `registration:<client>` until you
register them again.

`start.sh` builds the image when its recipe changed (it asks first; about
2 GB), starts the container and points the bridge at the launcher.
`--rebuild-container` rebuilds anyway (for Fedora updates or a newer Hopper),
`--no-container` runs REA on the host. `frontend/container/container.sh`
also has `status`, `stop` and `shell`.

### IDA

IDA isn't installed: it is commercial Hex-Rays software, and even IDA Free
needs a Hex-Rays account and license file. An IDA MCP server must be reachable
from the container. Once you have IDA and an IDA MCP
server installed, choose its registration file under **Provider paths**.

Upstream REA's installers deliberately don't install Java or Ghidra (see
`AGENTS.md`). This download step belongs to the workbench, not to `rea setup`.
To change a built-in release, edit its version, URL, size and SHA-256 in
`providerReleases.mjs`.

## Projects

The bar at the top of the middle column picks the **Project**: the folder
your agent works in. Calls you run from the page and every rea tool call the
agent makes are recorded in that project's history, so each folder keeps a
record of who ran what, with which arguments and with what result. With no
project open, calls go to the unassigned history (`--history-dir`, as before).
The right-hand column has two tabs: **History** (the active project's calls,
filtered by **All**, **Agent** or **You**) and **Project** (the active
folder's assessment, and the other known projects to switch to).

The bridge keeps one folder per project under `--projects-dir`, by default
`${XDG_DATA_HOME:-~/.local/share}/rea-workbench/projects/<id>/`: a
`project.json` with the folder's real path, device and inode, and `history/`
(the same store and limits as the unassigned history). A project is the
folder: the same real path and inode is the same project, so its history
survives restarts and reboots. The device number isn't part of that test,
because btrfs and composefs (Fedora Atomic) can renumber devices at each
boot. A folder moved within one boot keeps its project (device and inode find
it and the path is updated), while a different folder at the same path
(deleted and recreated, so another inode) becomes a new project, so histories
never mix. If several stored projects match, the oldest is used. A listed
project whose folder is gone or replaced says so and can't be opened from the
list.

### Agent calls

An agent session reaches rene through its **toolkit** (`agentToolkit.mjs`):

- **cli** (the default): the agent runs `rene call <tool> '<json>'` in its
  shell. The session gets a `rea` command on its `PATH`
  (`frontend/.workbench-agent/bin/rea`, which runs the workbench's rea
  command, the container launcher by default) and one `rene daemon` of its
  own, named to `rene call` by `REA_DAEMON_SOCKET`, so every call shares one
  session: a target one call opens stays open for the next. The daemon is an
  owned process held by an open stdin pipe and ends with the agent. Claude
  Code shows these calls as shell commands, so its topic gate also prints a
  line for each one in the console naming the rene tool and its main
  argument (`rene · read_file /path`).
- **mcp** (`REA_AGENT_TOOLKIT=mcp` in the workbench's environment): the agent
  runs `relay.mjs` as its `rea` MCP server, which starts REA and passes every
  byte between them unchanged.

Either way each call is reported to the bridge when it starts (shown as
running in History) and when it settles, with the result: `rene call` reports
its own calls, and the relay reads each `tools/call` off the JSON-RPC traffic
(both through `src/toolbox/HistoryReport.ts`). Reports authenticate with a
token issued for that agent session only, written to
`frontend/.workbench-agent/relay-report.json` (mode 0600) and named to
`rene call` by `REA_HISTORY_REPORT` (the path, not the token); the page's token
is never given to the agent. A report never changes or delays a call: if the
bridge is down, one line goes to stderr and the call carries on. Calls REA
never answers settle as failed when it exits. Results over 8 MiB are recorded
by size only, as for page calls. With MCP, agents that get rene from their
registration talk to REA directly, so their calls aren't recorded; the agent
picker says so. The agent's chat and reasoning aren't recorded yet.

### Conversations and audit trail

Claude Code writes every conversation run in a folder to
`${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<folder>/<id>.jsonl` (a resumed
conversation keeps its own file and `/clear` starts a new one), and GitHub
Copilot CLI writes each session to `~/.copilot/session-state/<id>/`, with the
folder it ran in as `cwd` in its `workspace.yaml`. rene owns reading both
(the same code behind its `list_agent_conversations` and
`read_agent_conversation` tools). The bridge follows every conversation rene
finds for the project folder and keeps, per project, the prompts, the agent's
reasoning (as the agent records it) and replies, its tool uses and the
results it saw, with a cursor so a restart neither loses nor repeats
anything; conversations written while the bridge was down are caught up when
the project is opened. Agents that use their registration (Codex, Gemini CLI
and others) aren't captured yet.

Each rene call in a transcript is tied to the call recorded for it by
timestamp and identity: the same tool with identical arguments, recorded just
after the tool use (the closest such call, within a short window). A shell
tool use that runs `rene call` counts as a call of the tool it names
(`src/toolbox/ReaCallCommand.ts` reads the command line); when its arguments
aren't on the line (read from stdin), it is matched by tool and time alone. That gives
every recorded agent call an **audit trail**, shown under its result: what was
asked, why the call was made (the reasoning and replies just before it), what
the agent saw, and what came of it (what it said and did next, up to its next
rene call).

Conversation turns appear in History as the quoted request, and the agent
calls tied to a turn are listed under it, folded behind "▸ N calls" so the
list stays short; calls no turn links (yours, or an agent call whose turn
hasn't been read yet) stay at the top level. **Expand all** opens every turn's
calls at once, in the list and in the Topics view. Opening a turn shows the
whole turn in order. The assessment's **Conversations** section quotes the
most recent turns: the request, the rene calls with their entry ids, and the
agent's conclusion.

Actions the agent takes with its own built-in tools (shell, file edits) show
in a turn only by tool name; they aren't rene calls, so they have no recorded
result or audit trail of their own.

### Topics

Work is grouped by its relationship: a **thread** (the chat relationship, the
top of the hierarchy), the topics under it (feature, question, bug,
investigation, refactor, docs, decision, other), then the conversation turns
and their calls. Topics are declared with rene's `record_topic` tool, by an
agent or from the **Topics** view in History; a declaration is a recorded call,
so the tree and every change to it are in the history, and the latest
declaration of a topic is its current state (title, status, summary,
relations such as `fixes` or `depends_on`).

A turn belongs to the topic declared in it and to no other: nothing carries
over from an earlier turn, so a turn without a declaration is listed as not
in any topic rather than filed under one it may not be about. Claude Code
sessions started from the workbench are held to a declaration in every turn
by hooks the bridge adds for the session (`topicGate.mjs`, through
`--settings`; the user's own settings are untouched): each prompt reminds the
agent, every other tool is refused until `record_topic` has been called in the
turn (calls sent in the same message as it pass), and a turn that would end
without a successful declaration is sent back once. The gate follows the
turn from the hook events themselves, keeping one small state file per
session in `.workbench-agent/topic-gate/`, rather than from the transcript,
which Claude Code writes a little after the fact.

### The user makes every commit

No agent writes git history, whichever agent it is and whatever tool it uses.
The workbench starts every agent (Claude Code, Copilot CLI and the
registration agents alike) with git's environment configuration
(`GIT_CONFIG_COUNT`/`KEY`/`VALUE`) pointing `core.hooksPath` at
`frontend/agent-git-hooks/`. Every process the agent starts inherits it,
including rene in its container, which the container launcher forwards it to.
There, git's own hooks refuse:

- `reference-transaction`: any reference update that writes history. That's
  moving or deleting a branch (commit, merge, rebase, cherry-pick, revert,
  reset, pull), creating or changing tags, stashes, notes and replacements,
  and new commits only HEAD or a brand-new branch would hold (a first commit,
  an orphan branch, a commit on a detached HEAD).
- `pre-push`: every push.

Fetching, creating and switching branches at existing commits, detaching,
staging, unstaging and reading history stay allowed. You, outside an agent
session, are unaffected. In agent sessions the repository's own hooks don't
run, since nothing they guard can happen there. For Claude Code the topic gate
also refuses those git commands before they run, so the agent is told why
straight away; the agent instructions and each project assessment's Rules say
the same. While rene is disconnected the agent can't use tools until it is
reconnected. Copilot CLI and registration agents only get the instruction.

Besides declared relations, topics are linked by fact: two topics whose calls
read or changed the same file, or named or returned the same Evidence, show
what they share. The assessment's **Topics** section lists the threads and
topics with their ids, so an agent can continue an existing topic.

### Evidence links

Links between calls are recorded only when they are confirmed, never guessed.
REA identifies each Evidence record by a SHA-256 digest of its content
(`ev_<64 hex>`). When a call settles, the bridge records the Evidence IDs it
issued: its result's own Evidence, plus the parent Evidence REA says it
retained (a summary receipt's `normalized_result.parent_evidence_id`) when the
call wasn't given that ID. It also looks for argument values that are exactly
an Evidence ID. Each one is linked to every earlier call in the project that
issued that ID, whichever session made it. Because the
identifier is a content digest, the call really did name that call's result.
An ID that no recorded call returned (imported, from another project, or
from a result too large to keep) is recorded as an unresolved reference and
linked to nothing. Calls that pass values by other means (an address, a path,
a session) aren't linked: those relationships can't be confirmed from the
traffic. History shows `← tool` under a call with confirmed links, and the
result view links **Uses Evidence from** to those calls.

### Project survey

The bridge runs rene's `survey_project_directory` on the project folder
through its own MCP connection, and records the call in the project's history
(source "You", from the workbench) like any other call:

- when a folder is opened, if it has no survey yet or the last one is more
  than 10 minutes old;
- when you press **Run assessment now** on the Project tab;
- in the background after calls are recorded: a minute after the last one, and
  at most every 5 minutes, because tools such as `extract_artifact` change what
  the folder holds.

The survey walks the folder (not following symbolic links, skipping `.git` and
`node_modules`, reading at most 4 KiB of each file) and reports its structure
to depth 2, the file types in use, and the rene tools that accept those types.
Types come from content signatures where a format has one (ELF and core
dumps, PE, Mach-O, ZIP and the APK/IPA/JAR/HAP packages, ASAR, plist, WASM,
SQLite, DuckDB, pcap, DEX, squashfs, ...), and from names only otherwise; each
type says which. Agents can call the same tool from the left-hand list.

### Project assessment

Each project can keep `.rene/assessment.md` in its folder: markdown project
memory for you and your agent. The workbench asks once per project (Project →
**Create it** or **Not for this project**) and writes nothing into the folder
unless you agree. The file starts with sections for Target, Rules, Findings
and Open questions, which belong to you and your agent, and one generated
section between `<!-- rene:generated -->` and `<!-- /rene:generated -->`.
The bridge rewrites only that section, 1.5 s after a project's calls stop
settling, with:

- **Folder structure, File types, Applicable tools, Coverage:** from the
  latest survey in the project's history, with its entry id.
- **Code map:** from the latest `map_source_graph` call, with its entry id
  and when the index was built: files per language, the files the most other
  files depend on and the symbols called from the most places, as places to
  start. The bridge runs `map_source_graph` itself (recorded like the
  survey) when a project with a CodeGraph index (`.codegraph/`) is opened and
  its last map is over an hour old, and right after an `index_source_graph`
  call succeeds. It never builds an index: that is `index_source_graph`,
  which the agent or you run.
- **Pathways:** chains of calls joined by confirmed Evidence links (up to 6
  steps), counted by tool sequence, with how many ended successfully and
  example entry ids.
- **Evidence links:** which tool's Evidence was named by which tool's
  argument, how often, and how many references stayed unresolved.
- **Tools used:** runs, failures and agent runs per tool.

If you remove the markers, the section isn't put back. An edit saved while the
bridge is rewriting wins; the bridge's version is dropped until the next call.
A Claude Code or Copilot CLI session started in a project with an assessment
is told to read it first, follow its Rules, keep the other sections current
(citing history entry ids) and leave the generated section alone. Every
session is also told to ask the source graph (`explore_source_graph` and the
other source-graph tools) before searching text or reading files one by one,
and to build the index with `index_source_graph` when there is none. Your own
`CLAUDE.md` and `AGENTS.md` aren't touched.

## Agents in the workbench

The project bar also picks the **Agent** and starts or stops it; it always
starts in the active project's folder, and while it runs the project can't be
changed. **Agent terminal** in the header shows its terminal; Shift+Enter
there sends ESC+Enter, which agents such as Claude Code take as a new line
rather than a submit. Pick it under
**Agent**: installed agents (found on the workbench's `PATH`)
come first, the rest are listed as not installed. Each is the same CLI you run
in a terminal, with your login, settings, skills and other MCP servers, and
each reaches this fork's REA through the session's toolkit (see
[Agent calls](#agent-calls)), in one of two ways.

**For the session** (Claude Code, GitHub Copilot CLI): rene is added for that
session only, launched the way the workbench launches REA (the container
launcher by default), with its tools pre-approved and an instruction to use
them. This works even where
no registration exists.

| Agent              | Toolkit | rene added with                   | Pre-approved                                          | Instruction                                                         |
| ------------------ | ------- | --------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| Claude Code        | cli     | `rea` on `PATH`, a session daemon | `--allowedTools Bash(rea:*)` (and head, tail, wc, jq) | `--append-system-prompt`                                            |
| Claude Code        | mcp     | `--mcp-config`                    | `--allowedTools mcp__rea`                             | `--append-system-prompt`                                            |
| GitHub Copilot CLI | cli     | `rea` on `PATH`, a session daemon | `--allow-tool shell(rea)`                             | `AGENTS.md` in a folder added to `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` |
| GitHub Copilot CLI | mcp     | `--additional-mcp-config @file`   | `--allow-tool rea`                                    | `AGENTS.md` in a folder added to `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` |

With the cli toolkit, Claude Code's topic gate (`topicGate.mjs`) lets its
shell run rea and nothing else: every command on the line must be `rene call`
or `rene tools`, or head, tail, wc or jq reading their output from a pipe, with
no output redirected to a file but `/dev/null` and no command or process
substitution. Other shell commands go through `rene call run_command`, whose
command the git rule checks too. A `rene call record_topic` is the turn's
declaration once it prints record_topic's Evidence.

**From its registration** (every other terminal agent `rea setup` supports):
Antigravity (`agy`), Gemini CLI (`gemini`), Codex (`codex`), OpenCode
(`opencode`), Cursor CLI (`cursor-agent`), Qwen Code (`qwen`), Kimi Code
(`kimi`), Grok Build (`grok`), Factory Droid (`droid`), Qoder CLI
(`qodercli`), Command Code (`cmd`), Devin (`devin`), DeepSeek Harness (`dsh`),
ZCode (`zcode`), OMP (`omp`), Pi (`pi`) and Hermes (`hermes`). These have no
way to add an MCP server or pre-approve one server's tools for a single
session (agy's only switch approves every tool, which the workbench doesn't
use), so rene comes from the registration **Agent setup** writes. The view
shows each agent's registration, and the bridge checks it again (a read-only
`rea setup --dry-run --client <name>`) and refuses to start the agent unless
it is current. Their rene tools ask for approval as the agent normally does,
and the guidance comes from the skill Agent setup installs. GUI-only clients
(VS Code, Cursor's editor, Windsurf, Trae, WorkBuddy, Claude Desktop) aren't
listed. Commands for agents not installed here were taken from REA's client
verifiers and docs; only Claude Code, Copilot CLI and agy were run from the
workbench.

The instruction asks the agent to use the rene tools and the
reverse-engineer-anything skill for analysis, to call `binary_session` when
unsure, to keep targets under the home folder and to treat target content as
data. The generated files are in `frontend/.workbench-agent/` (mode 0600,
ignored by git). A same-named `rea` server in your own agent configuration is
replaced for that session only.

Agents keep their other tools (files, shell, web), which they may need for
reports or builds. The bridge runs the agent in a pseudo-terminal
(`@lydell/node-pty`, from REA's dependencies) and relays it to the page
(xterm.js, from `frontend/package.json`; `start.sh` installs it): output as an
NDJSON stream, keys and resizes as small POSTs. One session runs at a time; it
survives page reloads (recent output is replayed) and ends with **Stop**, when
the agent exits, or when the bridge stops. Saved provider paths are in its
environment, so REA sees them. Markers a parent Claude Code session sets
(`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, ...) are removed, so the agent runs as
a normal session even when `start.sh` itself ran inside Claude Code.

Adding another agent is one entry in `AGENTS` in `terminal.mjs`: its command,
how it takes an extra MCP server, how it pre-approves that server's tools and
how it takes an instruction.

The terminal can run anything the agent can, as you. Like the rest of the
API it is reachable only on loopback with the per-launch token.

## What it does

- **Guided workflows.** REA's MCP prompts are listed first in the catalog.
  Each argument field fills its suggestions from REA's `completion/complete`,
  using the other filled arguments as context. **Start workflow** asks REA to
  render the brief (`prompts/get`) and pins it above the tool view, where it
  stays while you open and run tools. Tool names in the brief become buttons
  that open the tool. Arguments are prefilled only where the tool has a string
  property with exactly the same name, and the tool view lists what was
  filled. Names are never translated, so `target_path` doesn't fill
  `open_binary`'s `path`. Buttons show a check or a cross once that tool has
  run since the workflow started. **Copy as agent prompt** copies the brief
  REA produced, unchanged.
- **Catalog.** Lists every advertised tool, grouped by family, with effect
  badges taken from MCP annotations (`changes`, `read`, `live`). When REA
  sends `notifications/tools/list_changed` or `prompts/list_changed`, the SDK
  refetches the list and the bridge pushes a catalog event to every open page
  (`GET /api/events`), which reloads its catalog. A server restart does the
  same. An open tool form is left as it is; reopen it to load a changed
  definition.
- **Forms built from each tool's input schema.** Empty fields are left out of
  the call so REA applies its own defaults. Booleans have three states:
  omit/true/false. Shapes the form can't represent faithfully fall back to a
  JSON editor. A JSON mode and the schema's `examples` are also available.
- **Runs.** Calls run concurrently. Each run starts a new call without
  waiting for earlier ones. The bridge sends at most `--max-concurrent` calls to
  REA at a time and queues the rest in order, with live queue positions. REA
  admits analysis calls concurrently and waits for in-flight calls before
  switching targets. Each call streams its own progress and has its own
  Cancel, in the result view and in History. Cancelling a queued call removes it
  before it reaches REA. Cancelling a running call, or closing its request,
  sends MCP `notifications/cancelled`. Tools annotated as destructive need a
  second click before they run.
- **History.** Shows calls in progress and settled calls. Selecting one shows
  its live status or result and restores its arguments. A call that finishes
  in the background doesn't take over the view you're reading. The bridge
  stores every settled call in a DuckDB file (`<--history-dir>.duckdb`, and
  `history.duckdb` in each project's store), so history survives page reloads
  and workbench restarts. Stored entries load as summaries, and a result is
  fetched when you open it. Every call is kept, with no count or age limit. A
  result over 8 MB is not stored; its entry records the size and says to run
  the call again. **Clear** removes stored history after a second click.

  The list shows the newest 200 calls (and the conversation turns in the same
  span); **Load older calls** fetches the next 200 (`GET /api/history?limit=&before=`).

  The file belongs to `rene-history` (`packages/history-store`), a small Rust
  program the bridge starts on first use and talks to over JSON lines. It is
  the file's only writer, and the bridge starts it again if it stops. The
  bridge launches and stops it through rene's owned-process supervision
  (`src/process/ProviderProcess.ts`): its own process group, a run id, and a
  verified stop after it has closed the database. Lookups ask it for just
  what they need (a tool's calls, the newest survey, the calls that issued an
  Evidence id) instead of reading every entry. Build it
  with `npm run history-store:build` (part of `npm run build:cached`). As in
  sherloq, a fingerprint of its sources, the Rust toolchain and how DuckDB is
  linked decides whether the built program is reused. DuckDB's compiled
  static library is cached in
  `${RENE_DUCKDB_CACHE:-~/.cache/rene/duckdb/<version>}` and linked when
  present (seconds); otherwise DuckDB compiles from source once (a few
  minutes) and fills that cache. Crates come from cargo's local cache, and
  nothing is downloaded. Without Rust installed, a program already built from
  the same sources is reused.

  History kept as JSON files by earlier versions (`<id>.json` and
  `<id>.result.json`) is imported on first use. Entries already in the
  database are kept, and once every entry is confirmed the folder is renamed
  to `history.json-imported` rather than deleted. Reloading the page still cancels calls that are running,
  because each call belongs to the request that started it.

- **Providers.** Offers to download missing providers (see
  [Installing providers](#installing-providers)), runs `rea doctor` in the bridge's environment, which is also
  the environment REA's MCP child runs in, and shows each check with its state,
  detail and REA's remediation. The header button counts the checks that need
  attention. **Check again** reruns it.
- **Provider paths.** Below the checks, the Providers page has one field per
  provider location REA reads: `GHIDRA_INSTALL_DIR`, `JAVA_HOME`,
  `HOPPER_LAUNCHER_PATH`, `REA_IDA_MCP_CONFIG`, `REA_JADX_MCP_JAR` and
  `REA_KUNA_COMMAND`, each with **Browse…**. **Save and restart REA** checks
  that each changed path exists and is a folder or file as expected, saves it
  to `--settings`, restarts REA's MCP child with it and reruns `rea doctor`.
  Each badge is REA's own verdict on that provider, so a path can be saved and
  still be not ready (for example, Ghidra without a Java runtime). Saved paths
  take precedence over the same variables in your shell; clearing a field
  falls back to the shell. Only unchanged fields are left alone, so saving one
  path never copies shell values into the file. Restarting REA cancels running
  calls, so the page asks for a second click when any are running. The
  bridge applies the file itself and never runs it as shell. `rea doctor` and
  `rea setup` see the same paths, so agents you register afterwards get them
  too. Use these fields for providers you installed yourself; the
  **Install providers** section above the checks downloads the common ones.
- **Results.** Evidence records get a provenance panel: the
  observed/derived/inferred scale, subject digest, provider, authority,
  locations, limitations and linked Evidence. Clicking an Evidence ID opens
  `inspect_analysis_view` on it. Tagged REA errors show their remediation.
  Structured, content and raw views are always available, and results marked
  as containing target content are labelled.
- **Path fields.** Fields REA declares as host paths (its NUL-free local-path
  pattern) get a **Browse…** button. The bridge lists one directory at a time,
  names and entry types only, never file contents, because a browser file
  input never reveals a real path. Fields named `root` or `*_directory` pick a
  folder. Others pick a file or the current folder. Device paths, such as
  `device_path`, keep a plain text box.
- **Agent setup.** Registers this REA build as an MCP server with Claude Code,
  Codex, Cursor and the other agents `rea setup` supports. The view lists each
  agent setup knows, detected ones first, with its current registration
  (current or stale), and previews the exact changes and backup paths before
  anything is written. Apply needs a second click, and the bridge re-plans
  first, refusing if the plan changed since it was shown. `rea setup` makes
  every edit, additively and with backups. REA_* provider settings in the
  bridge's environment are registered with the server. Restart an agent after
  registering it.
- **Sessions.** Sessions live in the single MCP child, so `open_binary` state
  carries over between calls until `close_binary` or **Restart server**.

## Security model

- Listens only on `127.0.0.1`. The API requires a random per-launch token sent
  in the `x-rea-token` header.
- Rejects requests with an unexpected `Host` (DNS rebinding) or a foreign
  `Origin`.
- Static pages are served with a strict CSP: scripts only from `'self'`;
  inline styles are allowed for the xterm.js terminal. Strings from the analysis target are always rendered as text.
- The token is stored in `sessionStorage`. The last arguments used for each
  tool are kept in `localStorage` as a per-browser convenience.
- Call history is stored by the bridge as plain JSON in `--history-dir`
  (mode `0700`, files `0600`), with arguments as you entered them and results
  as REA returned them. REA redacts transport credentials and explicitly
  marked values in its results; the workbench doesn't redact anything else.
  Clear history, or delete the directory, after working with anything you
  don't want kept on disk. The directory is ignored by git.
- Project histories are stored the same way under `--projects-dir`. The
  bridge writes into a project folder only `.rene/assessment.md`, and only
  after you agree for that project.
- Agent relays report calls to `/api/relay` with a token issued for their
  session, not the page's token; reports with any other token are refused.
- Provider paths are stored as JSON in `--settings` (mode `0600`), with the
  previous version kept as `<file>.bak`. Only the six provider variables are
  accepted, each must be an absolute path to an existing folder or file, and
  the file is never evaluated as shell. A damaged file is reported on the
  Providers page and nothing from it is applied.
- Provider downloads come only from the URLs pinned in `providerInstall.mjs`
  and are checked against their pinned size and SHA-256 before unpacking.
  The bridge never runs a downloaded file; REA runs the providers as usual.

## Layout

```
server.mjs          bridge: MCP child owner, call queue, HTTP boundary
history.mjs         stored call history: summaries, results, pruning
projects.mjs        projects: folder identity and per-project history
assessment.mjs      Evidence links, pathways, .rene/assessment.md
relay.mjs           MCP relay agents run; reports their tool calls
conversations.mjs   agent transcripts: following, turns, audit trails
settings.mjs        saved provider paths added to REA's environment
choices.mjs            what the user uses, and the default analysis engine
providerReleases.mjs   built-in provider releases, pinned per host
providerInstall.mjs    download, verify, unpack, save paths
providerUpdates.mjs    update checks and approved pins
providerBuild.mjs      download, unpack, uv environments, launchers, checks
container/             Containerfile, container.sh, rea launcher, Hopper step
install-providers.mjs  terminal provider installer used by start.sh
start.sh            stop previous, toolchain check, install/build when needed, launch
terminal.mjs        agent list and sessions in a pseudo-terminal
package.json        the page's own packages (xterm.js)
public/index.html   shell
public/api.js       token + bridge client + NDJSON reader
public/catalog.js   sidebar: workflows, tool families, effect badges
public/form.js      JSON Schema → form widgets, exact-name workflow prefill
public/markdown.js  workflow brief Markdown → DOM (no innerHTML)
public/workflows.js workflow argument form, completions, pinned brief
public/render.js    Evidence/provenance, errors, lazy JSON tree
public/results.js   result view, live call view, history
public/calls.js     call lifecycle: start, queue/progress events, cancel
public/app.js       state, tool view, render scheduling
public/browse.js    host path picker over the bridge's directory listing
public/setup.js     agent registration through rea setup's plan and apply
public/doctor.js    provider readiness from rea doctor
public/providerPaths.js  provider path fields, save and restart
public/choices.js      "What you use" switches and default engine
public/agent.js        agent picker, Start/Stop and terminal view
public/projects.js     project bar and Project tab
public/installProviders.js  provider downloads, progress and updates
```

There's no build step and no dependencies beyond REA's own
`@modelcontextprotocol/client`.
