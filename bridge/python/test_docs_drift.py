"""Source-owned tests for the docs-drift analysis, run as REA runs it."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "source_analysis.py")

TREE = {
    "routes/device_routes.py": """
        def register(app):
            @app.post("/api/device/command")
            async def send(): ...
            @app.get("/api/device/{ieee}/history")
            async def history(ieee): ...
            @app.get("/api/unmentioned")
            async def quiet(): ...
        """,
    "routes/lan.py": """
        def register(app, kind):
            base = f"/api/{kind}"
            app.get(base)(lambda: None)
            app.post(f"{base}/discover")(lambda: None)
        """,
    "main.py": "from routes.lan import register\nregister(app, 'shelly')\n",
    "modules/x_api.py": """
        from fastapi import APIRouter
        router = APIRouter(prefix="/api/x")
        @router.get("/status")
        async def status(): ...
        def helper(): ...
        # see design.md §2.1, design.md §3.2, design.md §3.4 and gone.md §1
        """,
    "static/app.js": """
        fetch('/api/device/command', {method: 'POST'});
        fetch(`/api/device/${ieee}/history`);
        fetch('/api/device/' + ieee + '/history');
        fetch('/api/x/status' + qs);
        fetch(`/api/device/${ieee}/command`, {method: 'POST'});
        """,
    "docs/design.md": """
        # Design
        ## 2. Model
        ### 2.1 Delay
        ## 3. Limits
        1. one
        2. two
        ## 4. Later
        ### 2.9 Misplaced
        Calls `helper()` and `vanished()` and `time.monotonic()`.
        Lives in `modules/x_api.py` and `modules/nope.py`; secrets in `config/secrets.yaml`.
        `GET /api/x/status` and `POST /api/x/gone`, and the `/api/device` namespace.
        `/api/shelly` and `POST /api/shelly/discover` come from a registration call.
        """,
    "README.md": "Health at `/api/healthz`.\n",
    "docs/steps.md": "# Steps\n## 1. Setup\n### 1.1 Pieces\n#### 1. One\n#### 2. Two\n#### 3. Three\n"
                     "```\n# not a heading\n```\n## 2. Use\n## 4. Later\n## 3. Misplaced\n",
    "nested/README.md": "Nothing here.\n",
    ".gitignore": "/config/secrets.yaml\n*.log\n",
    "config/config.yaml": "media:\n  enabled: false\n  port: 80\n  yaml_only: 1\nextra:\n  a: 1\n",
    "routes/config_routes.py": """
        MEDIA_DEFAULTS = {"enabled": True, "port": 80, "only_here": 1}
        OCTOPUS_DEFAULTS = {"enabled": False}
        """,
}


def request(root, **overrides):
    base = {
        "analysis": "docs_drift",
        "root": root,
        "skip_dirs": [".git"],
        "backend_exclude_dirs": [],
        "docs_dirs": ["docs"],
        "api_prefixes": ["/api"],
        "frontend_suffixes": [".js", ".html"],
        "symbol_suffixes": [".js"],
        "citation_suffixes": [".py", ".js", ".md"],
        "ignore_symbols": [],
        "config_mirrors": [],
        "undocumented": False,
        "max_files": 1000,
        "max_file_bytes": 65536,
        "max_findings": 1000,
    }
    base.update(overrides)
    return base


class DocsDriftTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="rea-drift-")
        for rel, src in TREE.items():
            path = os.path.join(cls.root, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(textwrap.dedent(src))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root)

    def run_helper(self, flags=("-I", "-S", "-B"), **overrides):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(request(self.root, **overrides), handle)
        try:
            out = subprocess.run([sys.executable, *flags, HELPER, handle.name],
                                 capture_output=True, text=True, check=True)
        finally:
            os.unlink(handle.name)
        return json.loads(out.stdout)

    def details(self, kind, **overrides):
        return [f["detail"] for f in self.run_helper(**overrides)["findings"] if f["kind"] == kind]

    def test_frontend_call_to_a_missing_route_is_the_only_frontend_finding(self):
        frontend = [d for d in self.details("route") if d.startswith("frontend calls")]
        self.assertEqual(frontend, ["frontend calls /api/device/${ieee}/command; no backend route serves it"])

    def test_doc_routes_respect_router_prefixes_and_namespaces(self):
        routes = self.details("route")
        self.assertIn("doc names /api/x/gone; no backend route serves it", routes)
        self.assertFalse(any("/api/x/status" in d or "/api/device;" in d for d in routes))

    def test_the_root_readme_is_checked_and_not_shadowed(self):
        self.assertIn("doc names /api/healthz; no backend route serves it", self.details("route"))

    def test_citations_resolve_headings_and_list_items(self):
        cites = self.details("cite")
        self.assertEqual(sorted(cites), [
            "cites design.md §3.4; the doc has no section 3.4",
            "cites gone.md §1; no such doc",
        ])

    def test_misplaced_heading(self):
        found = self.details("heading")
        self.assertIn("section 2.9 sits under '4. Later', not section 2", found)
        # Siblings only: a fresh 1-2-3 run under 1.1 and a fenced '#' line are fine.
        self.assertIn("section 3 comes after section 4 (line 11)", found)
        self.assertEqual(len(found), 2, found)

    def test_paths_skip_runtime_files_and_symbols_skip_the_platform(self):
        self.assertEqual(self.details("path"), ["doc names modules/nope.py, which does not exist"])
        self.assertEqual(self.details("symbol"), ["doc names vanished(), defined nowhere in the tree"])

    def test_undocumented_routes_on_request(self):
        found = self.details("undocumented", undocumented=True)
        self.assertEqual(found, ["GET /api/unmentioned: no doc or frontend file mentions it"])

    def test_config_mirror_needs_yaml_and_says_so(self):
        mirrors = [{"yaml": "config/config.yaml", "module": "routes/config_routes.py"}]
        isolated = self.run_helper(config_mirrors=mirrors)
        try:
            import yaml  # noqa: F401
        except ImportError:
            self.assertEqual(isolated["config"]["status"], "skipped")
            return
        report = self.run_helper(flags=("-I", "-B"), config_mirrors=mirrors)
        self.assertEqual(report["config"]["status"], "checked")
        found = [f["detail"] for f in report["findings"] if f["kind"] == "config"]
        self.assertIn("media.enabled: MEDIA_DEFAULTS has true, config/config.yaml has false", found)
        self.assertIn("media.only_here: MEDIA_DEFAULTS has 1, config/config.yaml has nothing", found)
        self.assertIn("OCTOPUS_DEFAULTS mirrors 'octopus', which config/config.yaml lacks", found)
        # config.yaml's media.port matches; extra YAML keys are not drift.
        self.assertFalse(any("extra" in d or ": MEDIA_DEFAULTS has nothing" in d for d in found), found)

    def test_reports_what_it_read(self):
        report = self.run_helper()
        self.assertGreater(report["files"]["scanned"], 5)
        # 4 decorated, plus the 2 the lan template fills for 'shelly'.
        self.assertEqual(report["routes"], 6)
        self.assertFalse(any("shelly" in d for d in self.details("route")))
        self.assertEqual(report["frontend_calls"], 5)


if __name__ == "__main__":
    unittest.main()
