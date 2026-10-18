# REA Workbench (prototype)

A local browser UI for REA. A small Node bridge runs one `rea mcp` child over
stdio and makes its tools available to the page over loopback HTTP. REA keeps
ownership of input validation, sessions, Evidence and cleanup. The bridge passes
MCP requests through unchanged.

```sh
frontend/start.sh              # stop the old one, install if needed, rebuild, start, open browser
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
`npm run build:cached` and starts the bridge with `--open`. It never installs
Node.js, npm, Java or analysis providers. A mismatch stops the script with
instructions. Use `--dry-run` to see the plan first, and `--no-install`,
`--no-build` or `--no-open` to skip steps. Anything after `--` is passed to the
bridge:

```sh
frontend/start.sh --dry-run -- --port 0 --max-concurrent 2
```

To start the bridge directly:

```sh
node frontend/server.mjs       # prints http://127.0.0.1:4417/#token=...
```

| Flag               | Default              | Purpose                                    |
| ------------------ | -------------------- | ------------------------------------------ |
| `--port`           | `4417`               | Loopback port (`0` picks a free one)       |
| `--rea`            | `../scripts/rea.mjs` | REA dispatcher to run as `<rea> mcp`       |
| `--timeout-ms`     | `600000`             | Per-call timeout; resets on each progress  |
| `--max-concurrent` | `4`                  | Calls sent to REA at once; the rest queue  |
| `--open`           | off                  | Open the UI in the default browser         |
| `--pid-file`       | none                 | Remove this pid file on exit if it is ours |

REA reads provider configuration (`REA_*`, Ghidra/IDA paths and similar) from
its environment, so start the bridge from a shell where those are set.

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
  badges taken from MCP annotations (`changes`, `read`, `live`).
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
  in the background doesn't take over the view you're reading.
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
- Static pages are served with a strict CSP (`'self'` only, no inline
  script/style). Strings from the analysis target are always rendered as text.
- The token is stored in `sessionStorage`. The last arguments used for each
  tool are kept in `localStorage` as a per-browser convenience. Results are
  never persisted by the page.

## Layout

```
server.mjs          bridge: MCP child owner, call queue, HTTP boundary
start.sh            stop previous, toolchain check, install/build when needed, launch
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
```

There's no build step and no dependencies beyond REA's own
`@modelcontextprotocol/client`.
