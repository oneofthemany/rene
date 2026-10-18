"""Source-owned tests for the blocking-reachability helper, run as REA runs it."""

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest

HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "source_analysis.py")

TREE = {
    "app/__init__.py": "",
    "app/db.py": """
        def _get_db():
            pass
        def write_row(r):
            _get_db()
        """,
    "app/cache.py": """
        def _get_db():
            pass
        def read():
            _get_db()
        """,
    "app/worker.py": """
        import asyncio, time, subprocess
        from app import db, cache
        from . import db as rel_db

        def helper():
            db.write_row(1)

        def guarded():
            if _on_event_loop():
                return None
            helper()

        def _on_event_loop():
            return True

        async def direct():
            helper()

        async def relative():
            rel_db.write_row(2)

        async def handed_off():
            await asyncio.to_thread(helper)
            await asyncio.get_running_loop().run_in_executor(None, helper)
            await asyncio.to_thread(lambda: helper())

        async def asks_first():
            guarded()

        async def sleeps():
            time.sleep(1)

        async def reads_cache():
            cache.read()

        class Listener:
            def attribute_updated(self, attrid, value):
                self._store(value)
            def _store(self, value):
                subprocess.run(["true"])

        def tick():
            helper()

        def arm(loop):
            loop.call_later(5, tick)
        """,
    "app/broken.py": "def (:\n",
    "skipme/x.py": "import time\nasync def f():\n    time.sleep(1)\n",
}


def request(root, **overrides):
    base = {
        "analysis": "blocking_calls",
        "root": root,
        "skip_dirs": ["skipme"],
        "blocking": [
            {"name": "time.sleep", "reason": "sleeps"},
            {"name": "subprocess.", "reason": "runs a subprocess", "match": "prefix"},
            {"name": "app.db._get_db", "reason": "DB lock"},
        ],
        "accepted": [{"name": "app.cache._get_db", "reason": "accepted read"}],
        "loop_methods": ["attribute_updated"],
        "loop_probes": ["_on_event_loop"],
        "max_files": 100,
        "max_file_bytes": 65536,
        "max_findings": 100,
        "include_accepted": True,
    }
    base.update(overrides)
    return base


class BlockingCallsTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="rea-blocking-")
        for rel, src in TREE.items():
            path = os.path.join(self.root, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(textwrap.dedent(src))

    def tearDown(self):
        subprocess.run(["rm", "-rf", self.root], check=True)

    def run_helper(self, **overrides):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(request(self.root, **overrides), handle)
        try:
            out = subprocess.run([sys.executable, "-I", "-S", "-B", HELPER, handle.name],
                                 capture_output=True, text=True, check=True)
        finally:
            os.unlink(handle.name)
        return json.loads(out.stdout)

    def by_function(self, report):
        found = {}
        for f in report["findings"]:
            found.setdefault(f["function"].split(".")[-1], []).append(f)
        return found

    def test_async_caller_reaches_seed_through_helper(self):
        found = self.by_function(self.run_helper())
        chain = [c["name"] for c in found["direct"][0]["chain"]]
        self.assertEqual(chain, ["app.worker.helper", "app.db.write_row", "app.db._get_db"])
        self.assertEqual(found["direct"][0]["severity"], "high")

    def test_relative_import_resolves_to_the_same_seed(self):
        found = self.by_function(self.run_helper())
        self.assertEqual(found["relative"][0]["chain"][-1]["name"], "app.db._get_db")

    def test_handoffs_and_runtime_probes_are_not_findings(self):
        found = self.by_function(self.run_helper())
        self.assertNotIn("handed_off", found)
        self.assertNotIn("asks_first", found)

    def test_accepted_seed_is_reported_separately(self):
        found = self.by_function(self.run_helper())
        self.assertEqual(found["reads_cache"][0]["severity"], "accepted")

    def test_accepted_paths_are_counted_but_hidden_by_default(self):
        report = self.run_helper(include_accepted=False)
        self.assertEqual(report["accepted_count"], 1)
        self.assertNotIn("reads_cache", self.by_function(report))

    def test_loop_contexts(self):
        found = self.by_function(self.run_helper())
        self.assertEqual(found["attribute_updated"][0]["context"], "loop listener attribute_updated()")
        self.assertEqual(found["tick"][0]["context"], "scheduled on the loop")

    def test_skips_are_explicit_and_skip_dirs_are_not_walked(self):
        report = self.run_helper()
        skipped = {s["path"]: s["reason"] for s in report["files"]["skipped"]}
        self.assertTrue(skipped["app/broken.py"].startswith("does not parse"))
        self.assertFalse(any(f["file"].startswith("skipme/") for f in report["findings"]))

    def test_symlinks_are_never_followed(self):
        outside = tempfile.mkdtemp(prefix="rea-outside-")
        try:
            with open(os.path.join(outside, "evil.py"), "w") as handle:
                handle.write("import time\nasync def f():\n    time.sleep(1)\n")
            os.symlink(os.path.join(outside, "evil.py"), os.path.join(self.root, "app", "link.py"))
            os.symlink(outside, os.path.join(self.root, "linkdir"))
            report = self.run_helper()
            self.assertFalse(any("evil" in f["file"] or "link" in f["file"] for f in report["findings"]))
            self.assertIn("app/link.py", {s["path"] for s in report["files"]["skipped"]})
        finally:
            subprocess.run(["rm", "-rf", outside], check=True)

    def test_budgets_cut_explicitly(self):
        report = self.run_helper(max_findings=1, max_file_bytes=40)
        self.assertEqual(len(report["findings"]), min(1, report["finding_count"]))
        self.assertTrue(any("larger than 40 bytes" in s["reason"] for s in report["files"]["skipped"]))

    def test_tree_digest_tracks_source_bytes(self):
        first = self.run_helper()["files"]["sha256"]
        with open(os.path.join(self.root, "app", "db.py"), "a") as handle:
            handle.write("# changed\n")
        self.assertNotEqual(first, self.run_helper()["files"]["sha256"])


if __name__ == "__main__":
    unittest.main()
