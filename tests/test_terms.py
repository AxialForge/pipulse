"""PiPulse's glossary (hub/web/terms.js) on top of the kit's: every entry is complete, every
related term and [[link]] points at a term that exists, and every UI.term / T() key the pages use
is defined. Runs the real scripts in Node's vm; skipped when Node is not installed.
"""
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NODE = r"""
const fs = require('fs'), vm = require('vm');
const window = {}; const ctx = { window };
vm.runInNewContext(fs.readFileSync(process.argv[1], 'utf8'), ctx);
ctx.Glossary = window.Glossary;
vm.runInNewContext(fs.readFileSync(process.argv[2], 'utf8'), ctx);
console.log(JSON.stringify(window.Glossary.all().map(t => ({ key: t.key, term: t.term, short: t.short, text: [t.long, t.healthy, t.fix].join(' '), related: [...t.related] }))));
"""


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class TermsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        out = subprocess.run(["node", "-e", NODE, str(REPO / "kit" / "renderer" / "glossary.js"), str(REPO / "hub" / "web" / "terms.js")],
                             capture_output=True, text=True, check=True).stdout
        cls.terms = {t["key"]: t for t in json.loads(out)}

    def test_entries_complete_and_links_resolve(self):
        for k, t in self.terms.items():
            self.assertTrue(t["term"] and t["short"], k)
            for r in t["related"]:
                self.assertIn(r, self.terms, f"{k}: related '{r}' is not a term")
            for m in re.findall(r"\[\[([a-z0-9][a-z0-9_.-]*)", t["text"]):
                self.assertIn(m, self.terms, f"{k}: [[{m}]] is not a term")

    def test_every_marked_term_in_the_pages_exists(self):
        src = (REPO / "hub" / "web" / "app.js").read_text(encoding="utf-8")
        used = set(re.findall(r"\bT\('([a-z0-9-]+)'", src)) | set(re.findall(r"UI\.term\('([a-z0-9-]+)'", src))
        self.assertTrue(used)
        self.assertEqual(used - set(self.terms), set(), "pages mark terms the glossary does not define")


if __name__ == "__main__":
    unittest.main()
