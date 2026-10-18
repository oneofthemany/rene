# Python event-loop blocking

`inspect_python_blocking_calls` / `inspect-python-blocking-calls` finds work
that blocks an asyncio event loop in a Python source tree: an `async def`, a
scheduler callback, or a framework's loop-listener method that calls,
directly or through sync functions in the same tree, something that blocks
the thread. `inspect_python_client` / `inspect-python-client` reports the
selected interpreter.

REA does not install Python. It uses `python3` from `PATH`, or an absolute
`REA_PYTHON_COMMAND`; 3.8 or newer is required. Source is parsed with that
interpreter's grammar, so a file using newer syntax than the interpreter knows
is skipped with its parse error.

```sh
rea inspect-python-blocking-calls /src/service --json
rea inspect-python-blocking-calls /src/service --seeds project-seeds.json --include-accepted --json
```

```json
{
  "name": "inspect_python_blocking_calls",
  "arguments": {
    "root": "/src/service",
    "blocking": [{ "name": "app.db._get_db", "reason": "takes the DB lock" }],
    "accepted": [
      {
        "name": "app.cache._get_db",
        "reason": "short reads accepted on the loop"
      }
    ],
    "loop_methods": ["attribute_updated"],
    "loop_probes": ["_on_event_loop"]
  }
}
```

## What counts

- **Seeds** are fully qualified names after import resolution (`import x as
  y`, `from . import m` and function-local imports are followed). They match
  exactly, or by dotted prefix with `"match": "prefix"`. The default seeds are
  `time.sleep`, `subprocess.*` and `os.system`, `urllib.request.urlopen`,
  `socket.create_connection`, `requests.*`, `httpx.Client`, and
  `sqlite3.connect`/`duckdb.connect`. `default_seeds: false` (CLI
  `--no-default-seeds`) uses only yours.
- A sync function is **blocking** when it calls a seed or another blocking
  sync function in the tree. Calls through `self.`/`cls.` resolve within the
  class.
- A **finding** is a direct call to a blocking function or seed from an
  `async def` (`kind: async`), or from a sync function the loop runs
  (`kind: loop`). Loop-run functions are `call_soon`, `call_later`, `call_at`,
  `call_soon_threadsafe` and `add_done_callback` targets, and methods named in
  `loop_methods`. Each finding carries a witness chain from the direct callee
  to the seed.
- **Not calls**: the callable handed to `asyncio.to_thread` or
  `run_in_executor` is a reference, and lambda bodies are deferred.
- **Runtime choice**: a sync function that calls a `loop_probes` suffix
  (default `get_running_loop`) picks its path at runtime, for example cache on
  the loop and query off it, and is not propagated.
- **Accepted** seeds mark blocking that is known and accepted by design. Their
  findings are counted in `accepted_count` and listed only with
  `include_accepted`.

## Isolation and evidence

The bundled helper `bridge/python/source_analysis.py` runs as `python -I -S -B`
under prlimit on Linux (2 GiB address space, 300 CPU seconds), or a Job Object
on Windows. It reads `.py` files with `O_NOFOLLOW` and passes them to
`ast.parse`. Nothing in the tree is imported or executed, and symlinked files
and directories are skipped. Files over 4 MiB, and directories in `skip_dirs`
(added to `.git`, `__pycache__`, `node_modules` and virtualenvs), are not
analysed. Every skipped file is listed with its reason.

The tree is read in place, not snapshotted. The Evidence subject's SHA-256
covers each analysed file's relative path and SHA-256, so it names exactly
the bytes the findings came from. Confidence is `derived`. A callable reached
through a variable, parameter, attribute assignment or dependency injection
is invisible to static reachability, so a clean result means no path was
found, not that none exists.
