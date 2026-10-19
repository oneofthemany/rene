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

## Agents in the workbench

**Agent** in the header opens a terminal that runs your own coding agent on
this computer, in the folder you choose (**Start in**, with **Browse…**).
Pick it under **Agent**: installed agents (found on the workbench's `PATH`)
come first, the rest are listed as not installed. Each is the same CLI you run
in a terminal, with your login, settings, skills and other MCP servers, and
each runs with this fork's REA as its `rea` MCP server, in one of two ways.

**For the session** (Claude Code, GitHub Copilot CLI): rene is added for that
session only, launched the way the workbench launches REA (the container
launcher by default), with its tools pre-approved and an instruction to use
them. This works even where no registration exists.

| Agent              | rene added with                                  | Pre-approved              | Instruction                                                         |
| ------------------ | ------------------------------------------------ | ------------------------- | ------------------------------------------------------------------- |
| Claude Code        | `--mcp-config`                                   | `--allowedTools mcp__rea` | `--append-system-prompt`                                            |
| GitHub Copilot CLI | `--additional-mcp-config @file` (`tools: ["*"]`) | `--allow-tool rea`        | `AGENTS.md` in a folder added to `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` |

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
it is current. Their rea tools ask for approval as the agent normally does,
and the guidance comes from the skill Agent setup installs. GUI-only clients
(VS Code, Cursor's editor, Windsurf, Trae, WorkBuddy, Claude Desktop) aren't
listed. Commands for agents not installed here were taken from REA's client
verifiers and docs; only Claude Code, Copilot CLI and agy were run from the
workbench.

The instruction asks the agent to use the rea tools and the
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
  stores every settled call in `--history-dir`, so history survives page
  reloads and workbench restarts. Stored entries load as summaries, and a
  result is fetched when you open it. The newest 500 calls and 200 MB of
  results are kept. A result over 8 MB is not stored; its entry records the
  size and says to run the call again. **Clear** removes stored history after
  a second click. Reloading the page still cancels calls that are running,
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
public/agent.js        agent picker and terminal view
public/installProviders.js  provider downloads, progress and updates
```

There's no build step and no dependencies beyond REA's own
`@modelcontextprotocol/client`.
