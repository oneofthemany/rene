"""Static analyses over one source tree, for REA's Python provider.

Reads request.json (argv[1]) and prints one JSON report on stdout. Target
files are only read, through a bounded walker that never follows symlinks;
Python source is passed to ast.parse, never imported or executed. The report's
files.sha256 covers each read file's relative path and SHA-256.

  blocking_calls  event-loop blocking reachability (see blocking_report)
  docs_drift      docs, frontend and backend disagreeing about what exists
                  (see drift_report)
"""
from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import stat
import sys
from dataclasses import dataclass, field


# Source tree


class Tree:
    """Bounded reads of one tree; every file read or refused is accounted for."""

    def __init__(self, request):
        self.root = request["root"]
        self.skip = set(request["skip_dirs"])
        self.max_files = request["max_files"]
        self.max_bytes = request["max_file_bytes"]
        self.read_count = self.read_bytes = 0
        self.skipped = []
        self.digests = {}
        self.cache = {}

    def walk(self, suffixes):
        """(relative path, absolute path) of files with these suffixes, sorted."""
        for dirpath, dirnames, filenames in os.walk(self.root, followlinks=False):
            dirnames[:] = sorted(d for d in dirnames if d not in self.skip
                                 and not os.path.islink(os.path.join(dirpath, d)))
            for name in sorted(filenames):
                if name.endswith(tuple(suffixes)):
                    full = os.path.join(dirpath, name)
                    yield os.path.relpath(full, self.root).replace(os.sep, "/"), full

    def read(self, rel, full):
        """Bytes of one regular, non-symlink file, or None with the reason recorded."""
        if rel in self.cache:
            return self.cache[rel]
        if self.read_count >= self.max_files:
            return self._refuse(rel, "file budget exhausted")
        try:
            fd = os.open(full, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except OSError as error:
            return self._refuse(rel, f"unreadable: {error.strerror or error}")
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                return self._refuse(rel, "not a regular file")
            if info.st_size > self.max_bytes:
                return self._refuse(rel, f"larger than {self.max_bytes} bytes")
            chunks, total = [], 0
            while True:
                chunk = os.read(fd, 1 << 16)
                if not chunk:
                    break
                total += len(chunk)
                if total > self.max_bytes:
                    return self._refuse(rel, f"grew past {self.max_bytes} bytes while read")
                chunks.append(chunk)
        finally:
            os.close(fd)
        data = b"".join(chunks)
        self.read_count += 1
        self.read_bytes += len(data)
        self.digests[rel] = hashlib.sha256(data).hexdigest()
        self.cache[rel] = data
        return data

    def _refuse(self, rel, reason):
        self.cache[rel] = None
        if not any(s["path"] == rel for s in self.skipped):
            self.skipped.append({"path": rel, "reason": reason})
        return None

    def text(self, rel, full):
        data = self.read(rel, full)
        return None if data is None else data.decode("utf-8", errors="replace")

    def parse(self, rel, full):
        data = self.read(rel, full)
        if data is None:
            return None
        try:
            return ast.parse(data, rel)
        except (SyntaxError, ValueError) as error:
            self._refuse(rel, f"does not parse: {error}")
            return None

    def summary(self):
        tree_hash = hashlib.sha256()
        for rel in sorted(self.digests):
            tree_hash.update(f"{rel}\0{self.digests[rel]}\n".encode())
        return {"scanned": self.read_count, "bytes": self.read_bytes,
                "sha256": tree_hash.hexdigest(),
                "skipped_count": len(self.skipped), "skipped": self.skipped[:200]}


# Blocking calls
#
# A sync function is blocking when it calls a seed or another blocking sync
# function in the tree. A finding is an async def, or a sync function the loop
# runs (a scheduler callback target or a named loop-listener method), calling a
# blocking function directly. Hand-off callables (to_thread, run_in_executor)
# are references, not calls; lambda bodies are deferred. A function that probes
# where it runs picks its path at runtime and is not propagated.

LOOP_SCHEDULERS = {"call_soon", "call_later", "call_at", "call_soon_threadsafe",
                   "add_done_callback"}
HANDOFFS = {"to_thread", "run_in_executor", "run_sync"}


@dataclass
class Func:
    qual: str
    path: str
    line: int
    is_async: bool
    cls: str | None
    calls: list = field(default_factory=list)
    loop_root: str | None = None
    loop_guarded: bool = False


class Seeds:
    """Blocking and accepted names, each exact or a dotted prefix."""

    def __init__(self, blocking, accepted):
        self.entries = [(s, "high") for s in blocking] + [(s, "accepted") for s in accepted]

    def match(self, name):
        for seed, tier in self.entries:
            if name == seed["name"] or (seed.get("match") == "prefix" and name.startswith(seed["name"])):
                return {"name": name, "reason": seed["reason"], "tier": tier}
        return None


class ModuleScan(ast.NodeVisitor):
    def __init__(self, mod, path, is_pkg, request):
        self.mod, self.path, self.is_pkg = mod, path, is_pkg
        self.listeners = set(request["loop_methods"])
        self.probes = tuple(request["loop_probes"])
        self.aliases = {}
        self.funcs = []
        self.stack = []
        self.cls_stack = []
        self.scheduled = []

    def _resolve_from(self, node):
        if not node.level:
            return node.module or ""
        base = self.mod.split(".")
        drop = node.level - (1 if self.is_pkg else 0)
        base = base[:len(base) - drop] if drop else base
        return ".".join(base + ([node.module] if node.module else []))

    # One alias table per module, function-local imports included; shadowing
    # across functions is accepted imprecision.
    def visit_Import(self, node):
        for a in node.names:
            head = a.name.split(".")[0]
            self.aliases[a.asname or head] = a.name if a.asname else head

    def visit_ImportFrom(self, node):
        src = self._resolve_from(node)
        for a in node.names:
            self.aliases[a.asname or a.name] = f"{src}.{a.name}" if src else a.name

    def visit_ClassDef(self, node):
        self.cls_stack.append(node.name)
        self.generic_visit(node)
        self.cls_stack.pop()

    def _func(self, node, is_async):
        cls = self.cls_stack[-1] if self.cls_stack and not self.stack else None
        prefix = f"{self.mod}.{cls}" if cls else self.mod
        if self.stack:
            prefix = self.stack[-1].qual + ".<locals>"
        f = Func(f"{prefix}.{node.name}", self.path, node.lineno, is_async, cls)
        if cls and node.name in self.listeners and not is_async:
            f.loop_root = f"loop listener {node.name}()"
        self.funcs.append(f)
        self.stack.append(f)
        saved, self.cls_stack = self.cls_stack, []
        for stmt in node.body:
            self.visit(stmt)
        self.cls_stack = saved
        self.stack.pop()

    def visit_FunctionDef(self, node):
        self._func(node, False)

    def visit_AsyncFunctionDef(self, node):
        self._func(node, True)

    def visit_Lambda(self, node):
        return

    def dotted(self, expr):
        if isinstance(expr, ast.Name):
            return self.aliases.get(expr.id, f"{self.mod}.{expr.id}")
        if isinstance(expr, ast.Attribute):
            if isinstance(expr.value, ast.Name) and expr.value.id in ("self", "cls"):
                cls = next((f.cls for f in reversed(self.stack) if f.cls), None)
                return f"{self.mod}.{cls}.{expr.attr}" if cls else None
            base = self.dotted(expr.value)
            return f"{base}.{expr.attr}" if base else None
        return None

    def visit_Call(self, node):
        fn = node.func
        attr = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", None)
        if attr in HANDOFFS:
            skip = 2 if attr == "run_in_executor" else 1
            for a in node.args[skip:] + [k.value for k in node.keywords]:
                self.visit(a)
            return
        if attr in LOOP_SCHEDULERS:
            idx = 1 if attr in ("call_later", "call_at") else 0
            if len(node.args) > idx:
                target = self.dotted(node.args[idx])
                if target:
                    self.scheduled.append(target)
        if self.stack:
            name = self.dotted(fn)
            if name:
                self.stack[-1].calls.append((name, node.lineno))
                if not self.stack[-1].is_async and name.endswith(self.probes):
                    self.stack[-1].loop_guarded = True
        self.generic_visit(node)


def module_name(rel):
    parts = rel[:-3].split("/")
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def blocking_scan(tree, request):
    funcs, scheduled = {}, set()
    for rel, full in tree.walk([".py"]):
        parsed = tree.parse(rel, full)
        if parsed is None:
            continue
        ms = ModuleScan(module_name(rel), rel, rel.endswith("__init__.py"), request)
        ms.visit(parsed)
        for f in ms.funcs:
            funcs.setdefault(f.qual, f)
        scheduled.update(ms.scheduled)
    for q in scheduled:
        if q in funcs and not funcs[q].is_async and not funcs[q].loop_root:
            funcs[q].loop_root = "scheduled on the loop"
    return funcs


def chains(funcs, seeds):
    """One witness chain per blocking sync function, ending at a seed."""
    chain = {}
    changed = True
    while changed:
        changed = False
        for q, f in funcs.items():
            if f.is_async or f.loop_guarded or q in chain:
                continue
            for name, _ in f.calls:
                hit = seeds.match(name)
                if hit:
                    chain[q] = [hit]
                elif name in chain and name != q:
                    chain[q] = [{"name": name, "reason": None, "tier": None}] + chain[name]
                else:
                    continue
                changed = True
                break
    return chain


def blocking_findings(funcs, chain, seeds):
    out = []
    for q, f in funcs.items():
        if not (f.is_async or f.loop_root):
            continue
        seen = set()
        for name, line in f.calls:
            hit = seeds.match(name)
            path = [hit] if hit else (
                [{"name": name, "reason": None, "tier": None}] + chain[name] if name in chain else None)
            if not path or name in seen:
                continue
            seen.add(name)
            out.append({
                "kind": "async" if f.is_async else "loop",
                "severity": "accepted" if path[-1]["tier"] == "accepted" else "high",
                "file": f.path, "line": line, "function": q,
                "context": "async def" if f.is_async else f.loop_root,
                "chain": [{"name": c["name"], "reason": c["reason"]} for c in path],
            })
    out.sort(key=lambda d: (d["severity"] != "high", d["kind"], d["file"], d["line"]))
    return out


def blocking_report(request):
    tree = Tree(request)
    seeds = Seeds(request["blocking"], request["accepted"])
    funcs = blocking_scan(tree, request)
    found = blocking_findings(funcs, chains(funcs, seeds), seeds)
    shown = found if request.get("include_accepted") else [
        f for f in found if f["severity"] == "high"]
    return {
        "files": tree.summary(),
        "functions": len(funcs),
        "finding_count": len(shown),
        "accepted_count": sum(f["severity"] == "accepted" for f in found),
        "findings": shown[:request["max_findings"]],
    }


# Docs drift
#
#   route     a frontend call or a doc names an API path no backend route serves
#   cite      a source comment cites ``name.md §N`` and the doc or section is gone
#   path      a doc names a tree file (`dir/x.py`) that doesn't exist
#   symbol    a doc names ``func()`` or ``Class.method()`` defined nowhere
#   heading   a numbered heading out of order, or under the wrong section
#   config    a module-level mirror of a YAML config lacks a match in it
#   undocumented  a backend route no doc or frontend file mentions (on request)

ROUTE_METHODS = {"get", "post", "put", "delete", "patch", "websocket"}
# A path segment that is a parameter on either side normalises to {}.
PARAM = re.compile(r"\{[^}]*\}|\$\{[^}]*\}|:[A-Za-z_]\w*|<[^>]+>")
CITE = re.compile(r"([A-Za-z0-9_\-]+\.md)\s*§\s*(\d+(?:\.\d+)*)")
DOC_SYMBOL = re.compile(r"`([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\(\)`")
NUMBERED = re.compile(r"^#+\s*(?:Appendix\s+)?§?\s*(\d+(?:\.\d+)*)\.?\s")
# Names a doc may cite that belong to the language or platform, not the tree.
PLATFORM = set(getattr(sys, "stdlib_module_names", ())) | set(dir(__builtins__)) | {
    "performance", "AudioContext", "Date", "Math", "JSON", "window", "document",
    "navigator", "console", "Promise", "Object", "Array", "fetch", "setTimeout",
    "requestAnimationFrame", "super"}


def norm(path):
    path = path.split("?")[0].split("#")[0].rstrip("/") or "/"
    return PARAM.sub("{}", path)


def route_matches(path, routes):
    """A dynamic segment matches anything; a trailing {} swallows the rest."""
    p = norm(path)
    if p in routes:
        return True
    segs = p.split("/")
    for r in routes:
        rs = r.split("/")
        if len(rs) == len(segs) and all(a == b or "{}" in (a, b) or a.endswith("{}")
                                        or b.endswith("{}") for a, b in zip(rs, segs)):
            return True
        if rs[-1] == "{}" and segs[:len(rs) - 1] == rs[:-1]:
            return True
    return False


class RouteScan(ast.NodeVisitor):
    """FastAPI/Starlette-style decorators, with APIRouter(prefix=...) applied."""

    def __init__(self, rel, calls):
        self.rel = rel
        self.prefix = {}
        self.found = []
        self.templates = []
        self.calls = calls

    def visit_Assign(self, node):
        if isinstance(node.value, ast.Call) and getattr(node.value.func, "id", None) == "APIRouter":
            for kw in node.value.keywords:
                if kw.arg == "prefix" and isinstance(kw.value, ast.Constant):
                    for t in node.targets:
                        if isinstance(t, ast.Name):
                            self.prefix[t.id] = kw.value.value
        self.generic_visit(node)

    def _deco(self, node):
        for d in node.decorator_list:
            if not (isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute)
                    and d.func.attr in ROUTE_METHODS and d.args):
                continue
            arg = d.args[0]
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                path = arg.value
            elif isinstance(arg, ast.JoinedStr):
                path = "".join(v.value if isinstance(v, ast.Constant) else "{}" for v in arg.values)
            else:
                continue
            owner = d.func.value.id if isinstance(d.func.value, ast.Name) else ""
            self.found.append({"method": d.func.attr.upper(),
                               "path": self.prefix.get(owner, "") + path,
                               "file": self.rel, "line": d.lineno})

    def _path_of(self, arg, names):
        """A literal or f-string path; a parameter hole stays as {=name}."""
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            return arg.value
        if isinstance(arg, ast.JoinedStr):
            out = []
            for v in arg.values:
                if isinstance(v, ast.Constant):
                    out.append(v.value)
                elif isinstance(v.value, ast.Name) and v.value.id in names:
                    out.append(names[v.value.id])
                else:
                    out.append("{}")
            return "".join(out)
        if isinstance(arg, ast.Name):
            return names.get(arg.id)
        return None

    def visit_FunctionDef(self, node):
        self._deco(node)
        # app.get(path)(handler): routes registered by call, not decorator. A
        # path built from a parameter is a template, filled from call sites.
        params = [a.arg for a in node.args.args]
        names = {name: "{=" + name + "}" for name in params}
        for stmt in ast.walk(node):
            if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
                path = self._path_of(stmt.value, names)
                if path is not None:
                    names[stmt.targets[0].id] = path
        for call in ast.walk(node):
            inner = call.func if isinstance(call, ast.Call) else None
            if (isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute)
                    and inner.func.attr in ROUTE_METHODS and inner.args):
                path = self._path_of(inner.args[0], names)
                if path is None or not path.startswith("/"):
                    continue
                owner = inner.func.value.id if isinstance(inner.func.value, ast.Name) else ""
                route = {"method": inner.func.attr.upper(), "path": self.prefix.get(owner, "") + path,
                         "file": self.rel, "line": inner.lineno}
                if "{=" in path:
                    self.templates.append((node.name, params, route))
                else:
                    self.found.append(route)
        self.generic_visit(node)

    def visit_Call(self, node):
        # Literal arguments at each call site, for filling route templates.
        name = node.func.id if isinstance(node.func, ast.Name) else (
            node.func.attr if isinstance(node.func, ast.Attribute) else None)
        if name:
            self.calls.setdefault(name, []).append(
                [a.value if isinstance(a, ast.Constant) and isinstance(a.value, str) else None
                 for a in node.args])
        self.generic_visit(node)

    visit_AsyncFunctionDef = visit_FunctionDef


def headings(md):
    """Section numbers a doc defines, and numbered list items under one (§10.7)."""
    out, cur = set(), None
    for line in md.splitlines():
        m = NUMBERED.match(line)
        if m:
            cur = m.group(1)
            parts = cur.split(".")
            out.update(".".join(parts[:i]) for i in range(1, len(parts) + 1))
        elif line.startswith("#"):
            cur = None
        elif cur:
            item = re.match(r"^(\d+)\.\s", line)
            if item:
                out.add(f"{cur}.{item.group(1)}")
    return out


def misplaced_headings(md):
    """Numbered headings out of order among their siblings, or numbered under
    the wrong section: 7.6 placed outside a section 7 the doc does have.
    Headings in code fences are not headings."""
    heads, in_code = [], False
    for lineno, line in enumerate(md.splitlines(), 1):
        if line.lstrip().startswith("```"):
            in_code = not in_code
        m = None if in_code else re.match(r"^(#+)\s", line)
        if m:
            n = NUMBERED.match(line)
            num = tuple(int(x) for x in n.group(1).split(".")) if n else None
            heads.append((lineno, len(m.group(1)), num, line.lstrip("#").strip()))
    present = {num for _, _, num, _ in heads if num}
    stack = []  # open ancestors: [level, num, title, last numbered child]
    for lineno, level, num, title in heads:
        while stack and stack[-1][0] >= level:
            stack.pop()
        parent = stack[-1] if stack else None
        if num:
            owner = num[:-1]
            if len(num) > 1 and owner in present and not any(a[1] == owner for a in stack):
                where = parent[2] if parent else "the top of the doc"
                yield lineno, f"section {'.'.join(map(str, num))} sits under '{where}', not section {'.'.join(map(str, owner))}"
            if parent is not None:
                last = parent[3]
                # A heading numbered 1 starts a fresh run (steps in a recipe).
                if last and num < last[0] and num[-1] != 1:
                    yield lineno, f"section {'.'.join(map(str, num))} comes after section {'.'.join(map(str, last[0]))} (line {last[1]})"
                parent[3] = (num, lineno)
        stack.append([level, num, title, None])

def runtime_files(tree):
    """Anchored, literal .gitignore entries: files a doc may name that are made at runtime."""
    text = tree.text(".gitignore", os.path.join(tree.root, ".gitignore")) \
        if os.path.lexists(os.path.join(tree.root, ".gitignore")) else None
    return {l.strip().lstrip("/") for l in (text or "").splitlines()
            if l.strip() and not l.startswith("#") and not any(c in l for c in "*?[!")}


MISSING = object()


def diff(a, b, path):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b), key=str):
            yield from diff(a.get(k, MISSING), b.get(k, MISSING), f"{path}.{k}")
    elif a is MISSING or b is MISSING or a != b:
        # YAML has no tuples, and 1 == 1.0 already compares equal.
        if not (isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)) and list(a) == list(b)):
            yield path, a, b


def shown(value):
    return "nothing" if value is MISSING else json.dumps(value, default=str)[:200]


def config_findings(tree, mirrors):
    """Each mirror: module-level NAME<suffix> dict literals vs the YAML section name."""
    if not mirrors:
        return [], {"status": "not_requested", "reason": None}
    try:
        import yaml
    except ImportError:
        return [], {"status": "skipped",
                    "reason": "PyYAML is not importable by the selected interpreter"}
    out = []
    for mirror in mirrors:
        yaml_rel, module_rel = mirror["yaml"], mirror["module"]
        suffix = mirror.get("suffix", "_DEFAULTS")
        yaml_text = tree.text(yaml_rel, os.path.join(tree.root, yaml_rel))
        parsed = tree.parse(module_rel, os.path.join(tree.root, module_rel))
        if yaml_text is None or parsed is None:
            out.append({"kind": "config", "file": module_rel, "line": 1,
                        "detail": f"cannot compare {module_rel} with {yaml_rel}; see files.skipped"})
            continue
        try:
            config = yaml.safe_load(yaml_text) or {}
        except yaml.YAMLError as error:
            out.append({"kind": "config", "file": yaml_rel, "line": 1,
                        "detail": f"{yaml_rel} does not parse: {error}"})
            continue
        for node in parsed.body:
            if not (isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                    and node.targets[0].id.endswith(suffix)):
                continue
            name = node.targets[0].id
            section = name[:-len(suffix)].lower()
            try:
                defaults = ast.literal_eval(node.value)
            except ValueError:
                continue
            side = config.get(section) if isinstance(config, dict) else None
            if not isinstance(side, dict):
                out.append({"kind": "config", "file": module_rel, "line": node.lineno,
                            "detail": f"{name} mirrors '{section}', which {yaml_rel} lacks"})
                continue
            for path, a, b in diff(defaults, side, section):
                # A mirror fills gaps in what a settings UI edits; the YAML may
                # hold more. Only a default it lacks, or a different value, drifts.
                if a is MISSING:
                    continue
                out.append({"kind": "config", "file": module_rel, "line": node.lineno,
                            "detail": f"{path}: {name} has {shown(a)}, {yaml_rel} has {shown(b)}"})
    return out, {"status": "checked", "reason": None}


def drift_report(request):
    tree = Tree(request)
    prefixes = tuple(request["api_prefixes"])
    alternation = "|".join(re.escape(p.strip("/")) for p in prefixes)
    # A literal followed by `+` is only the prefix of a path built at runtime.
    js_call = re.compile(r"(?:fetch|api\w*|request|post|get|put|del\w*|WebSocket)\s*\(\s*"
                         r"(['\"`])(/(?:" + alternation + r")[^'\"`]*)\1(\s*\+)?")
    doc_route = re.compile(r"`(?:(?:GET|POST|PUT|DELETE|PATCH|WS)\s+)?(/(?:" + alternation + r")/[^`\s]*)`")
    doc_route_bare = re.compile(r"^\s*[-*|]?\s*\**(?:GET|POST|PUT|DELETE|PATCH)\**\s+`?(/(?:"
                                + alternation + r")/[^\s`|)]*)", re.M)
    top_dirs = sorted(d for d in os.listdir(tree.root)
                      if os.path.isdir(os.path.join(tree.root, d))
                      and not os.path.islink(os.path.join(tree.root, d)) and d not in tree.skip)
    doc_path = re.compile(r"`((?:" + "|".join(map(re.escape, top_dirs))
                          + r")/[\w./\-]+\.\w+)(?::\d+)?`") if top_dirs else None
    backend_skip = tuple(d.rstrip("/") + "/" for d in request["backend_exclude_dirs"])
    docs_dirs = tuple(d.rstrip("/") + "/" for d in request["docs_dirs"])
    ignore_symbols = set(request["ignore_symbols"]) | PLATFORM

    routes, defs, templates, calls = [], set(), [], {}
    for rel, full in tree.walk([".py"]):
        if rel.startswith(backend_skip):
            continue
        parsed = tree.parse(rel, full)
        if parsed is None:
            continue
        scan = RouteScan(rel, calls)
        scan.visit(parsed)
        routes += scan.found
        templates += scan.templates
        for n in ast.walk(parsed):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defs.add(n.name)
                if isinstance(n, ast.ClassDef):
                    defs.update(f"{n.name}.{m.name}" for m in n.body
                                if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)))
    # Docs cite frontend and app functions too, not only Python ones.
    for rel, full in tree.walk(request["symbol_suffixes"]):
        text = tree.text(rel, full)
        if text is None:
            continue
        defs.update(re.findall(r"\bfunction\s+([A-Za-z_$][\w$]*)", text))
        defs.update(re.findall(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(", text))
        defs.update(re.findall(r"^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{", text, re.M))
        defs.update(re.findall(r"\bfun\s+([A-Za-z_]\w*)", text))

    # Fill each parameter-built path from every call that passes literals; an
    # unresolved one is dropped, never kept as a wildcard that hides drift.
    for func, params, route in templates:
        for args in calls.get(func, []):
            path = route["path"]
            for index, param in enumerate(params):
                if f"{{={param}}}" in path and index < len(args) and args[index] is not None:
                    path = path.replace(f"{{={param}}}", args[index])
            if "{=" not in path:
                routes.append({**route, "path": path})
    served = {norm(r["path"]) for r in routes}
    mentioned = set()
    out = []
    frontend_calls = 0

    for rel, full in tree.walk(request["frontend_suffixes"]):
        if rel.startswith(docs_dirs):
            continue
        text = tree.text(rel, full)
        if text is None:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            for _, path, concat in js_call.findall(line):
                frontend_calls += 1
                mentioned.add(norm(path))
                tails = [path, path.rstrip("/") + "/{}"] if concat else [path]
                if not any(route_matches(t, served) for t in tails):
                    out.append({"kind": "route", "file": rel, "line": lineno,
                                "detail": f"frontend calls {path}; no backend route serves it"})

    # Every Markdown file can be cited and is checked for heading order; only
    # docs_dirs and root-level files are read for routes, paths and symbols.
    docs, checked = {}, []
    for rel, full in tree.walk([".md"]):
        text = tree.text(rel, full)
        if text is None:
            continue
        # Citations name a doc by file name; the first one found wins.
        docs.setdefault(rel.rsplit("/", 1)[-1], (text, rel))
        for lineno, detail in misplaced_headings(text):
            out.append({"kind": "heading", "file": rel, "line": lineno, "detail": detail})
        if "/" not in rel or rel.startswith(docs_dirs):
            checked.append((text, rel))
    made_at_runtime = runtime_files(tree)
    for text, rel in checked:
        in_code = False
        for lineno, line in enumerate(text.splitlines(), 1):
            if line.lstrip().startswith("```"):
                in_code = not in_code
            seen_here = set()
            for path in doc_route.findall(line) + doc_route_bare.findall(line):
                if path in seen_here or "*" in path:
                    continue
                seen_here.add(path)
                mentioned.add(norm(path))
                if path.endswith(("…", "...")) or any(r.startswith(norm(path) + "/") for r in served):
                    continue  # a namespace, not an endpoint
                if not route_matches(path, served):
                    out.append({"kind": "route", "file": rel, "line": lineno,
                                "detail": f"doc names {path}; no backend route serves it"})
            for ref in (doc_path.findall(line) if doc_path else []):
                if "*" in ref or "<" in ref:
                    continue
                if not os.path.lexists(os.path.join(tree.root, ref)) and ref not in made_at_runtime:
                    out.append({"kind": "path", "file": rel, "line": lineno,
                                "detail": f"doc names {ref}, which does not exist"})
            if in_code:
                continue
            for sym in DOC_SYMBOL.findall(line):
                if sym.split(".")[0] in ignore_symbols:
                    continue
                if sym not in defs and sym.split(".")[-1] not in defs:
                    out.append({"kind": "symbol", "file": rel, "line": lineno,
                                "detail": f"doc names {sym}(), defined nowhere in the tree"})

    known_sections = {}
    for rel, full in tree.walk(request["citation_suffixes"]):
        text = tree.text(rel, full)
        if text is None:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            for doc, sec in CITE.findall(line):
                if doc not in docs:
                    out.append({"kind": "cite", "file": rel, "line": lineno,
                                "detail": f"cites {doc} §{sec}; no such doc"})
                    continue
                known = known_sections.setdefault(doc, headings(docs[doc][0]))
                if sec not in known:
                    out.append({"kind": "cite", "file": rel, "line": lineno,
                                "detail": f"cites {doc} §{sec}; the doc has no section {sec}"})

    config, config_status = config_findings(tree, request["config_mirrors"])
    out += config

    if request["undocumented"]:
        for route in sorted(routes, key=lambda r: (r["path"], r["method"])):
            n = norm(route["path"])
            if n.startswith(prefixes) and not any(route_matches(m, {n}) for m in mentioned):
                out.append({"kind": "undocumented", "file": route["file"], "line": route["line"],
                            "detail": f"{route['method']} {route['path']}: no doc or frontend file mentions it"})

    out.sort(key=lambda r: (r["kind"], r["file"], r["line"], r["detail"]))
    counts = {}
    for r in out:
        counts[r["kind"]] = counts.get(r["kind"], 0) + 1
    return {
        "files": tree.summary(),
        "routes": len(routes),
        "frontend_calls": frontend_calls,
        "docs": len(checked),
        "config": config_status,
        "finding_count": len(out),
        "counts": counts,
        "findings": out[:request["max_findings"]],
    }


ANALYSES = {"blocking_calls": blocking_report, "docs_drift": drift_report}


def main():
    with open(sys.argv[1], encoding="utf-8") as handle:
        request = json.load(handle)
    report = ANALYSES[request["analysis"]](request)
    report["python"] = sys.version.split()[0]
    json.dump(report, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
