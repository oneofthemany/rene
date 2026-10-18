# Python application docs drift

`inspect_python_docs_drift` / `inspect-python-docs-drift` cross-checks what a
Python web application's docs, frontend and backend each say exists. It uses
the same caller-supplied Python 3.8+ as
[event-loop blocking](python-blocking-calls.md) (`python3` on `PATH`, or
`REA_PYTHON_COMMAND`).

```sh
rea inspect-python-docs-drift /src/app --json
rea inspect-python-docs-drift /src/app --settings drift.json --undocumented --json
```

```json
{
  "name": "inspect_python_docs_drift",
  "arguments": {
    "root": "/src/app",
    "backend_exclude_dirs": ["scripts"],
    "config_mirrors": [
      { "yaml": "config/config.yaml", "module": "routes/config_routes.py" }
    ]
  }
}
```

## Findings

| Kind           | Reported when                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `route`        | A frontend call (`fetch`, `api…`, `request`, `WebSocket` with a literal path) or a doc names an API path that no backend route serves                                                        |
| `cite`         | A source or doc line cites `name.md §N` and that doc, heading or numbered list item under a heading does not exist                                                                           |
| `path`         | A doc names a backticked tree file, such as `` `routes/x.py` ``, that does not exist and is not an anchored `.gitignore` entry                                                               |
| `symbol`       | A doc names `` `func()` `` or `` `Class.method()` `` that no Python, JavaScript or Kotlin file defines; the stdlib, builtins and browser globals are ignored, and `ignore_symbols` adds more |
| `heading`      | A numbered heading sorts below the one before it, e.g. a `7.6` after `11`; a heading numbered 1 starts a fresh run                                                                           |
| `config`       | A module-level `NAME_DEFAULTS` dict literal has a default its YAML config section `name` lacks, or a different value. YAML keys the mirror doesn't repeat are not drift                      |
| `undocumented` | With `undocumented`, a backend route that no doc or frontend file mentions                                                                                                                   |

Backend routes are FastAPI/Starlette-style decorators (`@app.get(...)`,
`@router.post(...)`) with literal or f-string paths, with an
`APIRouter(prefix=...)` applied. `{param}`, `${expr}`, `:param` and `<param>`
segments match any segment, and a literal followed by `+` in JavaScript
matches as a prefix. A doc path that is a prefix of served routes (the
`/api/device` namespace) is not an endpoint. `api_prefixes` (default `/api`
and `/ws`) selects which paths name the backend.

Every Markdown file in the tree can be cited and is checked for heading order.
Routes, paths and symbols are checked in `docs_dirs` (default `docs`) and
root-level `.md` files. Python under `backend_exclude_dirs` is neither a route
nor a symbol source.

## Config mirrors

A config mirror compares module-level dict literals against a YAML file. This
is the pattern where a settings API repeats the shipped defaults. PyYAML must
be importable by the selected interpreter, so for this check only the helper
runs with the interpreter's site-packages (`-I -B` instead of `-I -S -B`).
Without PyYAML, `config.status` is `skipped`, with the reason.

## Isolation and evidence

The helper shares the blocking analysis' walker, which reads files with
`O_NOFOLLOW`, skips symlinks, files over 4 MiB and `skip_dirs`, and lists
each skipped file with its reason. Python is parsed with `ast`, never imported
or executed. Docs and frontend checks are regular expressions over text, so
they are heuristic. The subject SHA-256 covers each read file's relative path
and SHA-256, and confidence is `derived`.
