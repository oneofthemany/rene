# REA Workbench (prototype)

A local browser UI for REA. A small Node bridge runs one `rea mcp` child over
stdio and makes its tools available to the page over loopback HTTP. REA keeps
ownership of input validation, sessions, Evidence and cleanup. The bridge passes
MCP requests through unchanged.

```sh
npm run build:cached           # the bridge runs the compiled REA runtime
node frontend/server.mjs       # prints http://127.0.0.1:4417/#token=...
```

Open the printed URL. Options:

| Flag           | Default              | Purpose                                   |
| -------------- | -------------------- | ----------------------------------------- |
| `--port`       | `4417`               | Loopback port (`0` picks a free one)      |
| `--rea`        | `../scripts/rea.mjs` | REA dispatcher to run as `<rea> mcp`      |
| `--timeout-ms` | `600000`             | Per-call timeout; resets on each progress |

REA reads provider configuration (`REA_*`, Ghidra/IDA paths and similar) from
its environment, so start the bridge from a shell where those are set.

## What it does

- **Catalog.** Lists every advertised tool, grouped by family, with effect
  badges taken from MCP annotations (`changes`, `read`, `live`).
- **Forms built from each tool's input schema.** Empty fields are left out of
  the call so REA applies its own defaults. Booleans have three states:
  omit/true/false. Shapes the form can't represent faithfully fall back to a
  JSON editor. A JSON mode and the schema's `examples` are also available.
- **Runs.** Results stream back as NDJSON with progress. Cancel, or closing the
  request, sends MCP `notifications/cancelled`. Tools annotated as destructive
  need a second click before they run.
- **Results.** Evidence records get a provenance panel: the
  observed/derived/inferred scale, subject digest, provider, authority,
  locations, limitations and linked Evidence. Clicking an Evidence ID opens
  `inspect_analysis_view` on it. Tagged REA errors show their remediation.
  Structured, content and raw views are always available, and results marked
  as containing target content are labelled.
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
server.mjs          bridge: MCP child owner + HTTP boundary
public/index.html   shell
public/api.js       token + bridge client + NDJSON reader
public/catalog.js   tool families and effect badges
public/form.js      JSON Schema → form widgets
public/render.js    Evidence/provenance, errors, lazy JSON tree
public/results.js   result view and history
public/app.js       state, tool view, run/cancel
```

There's no build step and no dependencies beyond REA's own
`@modelcontextprotocol/client`.
