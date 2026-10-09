"""Independent fixture checks; these do not exercise docsluice."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class PdfFixtures(unittest.TestCase):
    def test_generator_creates_independently_readable_and_deterministic_pdfs(self):
        script = Path(__file__).with_name("generate.py")
        self.assertTrue(script.is_file(), "PDF fixture generator is missing")
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            for target in (first, second):
                subprocess.run([sys.executable, str(script), target], check=True, capture_output=True)
            root = Path(first)
            proposal = json.loads((root / "manifest.delta.json").read_text())
            for entry in proposal["entries"]:
                self.assertIn("source_file", entry, "proposal must identify the actual source fixture")
                self.assertTrue((root / entry["source_file"]).is_file())
                self.assertEqual(entry["proposed_target"], "hostile/" + entry["file"])
            files = sorted(root.rglob("*"))
            for path in files:
                if path.is_file():
                    relative = path.relative_to(root)
                    other = Path(second) / relative
                    self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), hashlib.sha256(other.read_bytes()).digest())
            self.assertTrue(shutil.which("pdftotext"), "independent Poppler tool required")
            expected = json.loads((root / "expected-fixture-content.json").read_text())
            for name, record in expected.items():
                path = root / name
                self.assertIn("CC0-1.0", path.with_name(path.name + ".license").read_text())
                data = path.read_bytes()
                xref_offset = int(data.rsplit(b"startxref\n", 1)[1].splitlines()[0])
                self.assertEqual(data[xref_offset:xref_offset + 4], b"xref")
                lines = data[xref_offset:].splitlines()
                for obj_id, entry in enumerate(lines[3:3 + int(lines[1].split()[1]) - 1], 1):
                    offset = int(entry.split()[0])
                    self.assertTrue(data[offset:].startswith(f"{obj_id} 0 obj\n".encode()))
                result = subprocess.run(["pdftotext", "-layout", str(path), "-"], check=True, capture_output=True, timeout=10)
                text = result.stdout.decode()
                self.assertEqual(text.count("\f"), record["pages"])
                for phrase in record["text"]:
                    self.assertIn(phrase, text)
                if record.get("noText"):
                    self.assertEqual(text.strip(), "")
                if record["pages"] > 1:
                    for page, phrase in ((1, record["text"][0]), (record["pages"], record["text"][-1])):
                        # The label/link sample has a fourth phrase on page 1.
                        if name == "labels-outline-links.pdf" and page == 3:
                            phrase = "Synthetic third page"
                        page_text = subprocess.run(["pdftotext", "-f", str(page), "-l", str(page), str(path), "-"], check=True, capture_output=True, timeout=10).stdout.decode()
                        self.assertIn(phrase, page_text)
            self.assertEqual(expected["text-100-pages.pdf"]["pages"], 100)
            labelled = (root / "labels-outline-links.pdf").read_bytes()
            for marker in (b"/PageLabels", b"/Outlines", b"/Subtype /Link", b"/S /URI"):
                self.assertIn(marker, labelled)
            self.assertIn(b"/Subtype /Image", (root / "image-only.pdf").read_bytes())
            damaged = (root / "hostile" / "corrupt-xref.pdf").read_bytes()
            self.assertNotEqual(damaged, labelled)
            actions = (root / "hostile" / "actions.pdf").read_bytes()
            for marker in (b"/S /JavaScript", b"/S /Launch", b"/S /GoToR"):
                self.assertIn(marker, actions)


if __name__ == "__main__":
    unittest.main()
