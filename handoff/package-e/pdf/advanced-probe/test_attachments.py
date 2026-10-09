from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parents[1] / "pdf-fixtures" / "attachments"
PDF = FIXTURES / "attachments-edge-cases.pdf"


class AttachmentFixtureTests(unittest.TestCase):
    def test_generator_repeats_identical_pdf_and_nested_zip(self) -> None:
        subprocess.run([sys.executable, str(HERE / "generate-attachments.py")], check=True, capture_output=True)
        first = {name: (FIXTURES / name).read_bytes() for name in (PDF.name, "nested.zip")}
        subprocess.run([sys.executable, str(HERE / "generate-attachments.py")], check=True, capture_output=True)
        second = {name: (FIXTURES / name).read_bytes() for name in (PDF.name, "nested.zip")}
        self.assertEqual(first, second)

    def test_xref_entries_point_at_their_indirect_objects(self) -> None:
        data = PDF.read_bytes()
        start = data.rfind(b"startxref\n")
        self.assertGreater(start, 0)
        xref_offset = int(data[start + len(b"startxref\n"):].splitlines()[0])
        self.assertEqual(data[xref_offset:xref_offset + 5], b"xref\n")
        lines = data[xref_offset:].splitlines()
        first, count = map(int, lines[1].split())
        self.assertEqual(first, 0)
        self.assertGreater(count, 1)
        entries = lines[2:2 + count]
        self.assertEqual(len(entries), count)
        for object_number, entry in enumerate(entries[1:], 1):
            offset = int(entry[:10])
            self.assertEqual(data[offset:].split(b" ", 2)[:2], [str(object_number).encode(), b"0"])

    def test_expected_sourcefacts_and_attachment_structure(self) -> None:
        facts = json.loads((FIXTURES / "expected-source-facts.json").read_text(encoding="utf-8"))
        self.assertEqual(facts["status"], "SYNTHETIC_SOURCE_FACTS_ONLY_NOT_READER_ACCEPTANCE")
        self.assertEqual(len(facts["attachments"]), 5)
        self.assertEqual(sum(item["filename"] == "data.csv" for item in facts["attachments"]), 2)
        self.assertTrue(any(item["nameTreeKey"] == "__proto__" for item in facts["attachments"]))
        self.assertTrue(any(item["filename"].startswith("../") for item in facts["attachments"]))
        payload_by_key = {item["nameTreeKey"]: item for item in facts["attachments"]}
        nested = (FIXTURES / "nested.zip").read_bytes()
        self.assertEqual(len(nested), payload_by_key["nested-zip"]["bytes"])
        self.assertEqual(hashlib.sha256(nested).hexdigest(), payload_by_key["nested-zip"]["sha256"])

    def test_pypdf_can_read_embedded_payloads(self) -> None:
        try:
            from pypdf import PdfReader
        except ImportError:
            self.skipTest("pypdf is a tool-only structural validation dependency")
        reader = PdfReader(PDF)
        self.assertEqual(len(reader.pages), 1)
        attachments = reader.attachments
        self.assertEqual(attachments["nested-zip"][0], (FIXTURES / "nested.zip").read_bytes())
        self.assertEqual(attachments["csv-primary"][0], b"id,value\n1,alpha\n")
        self.assertEqual(attachments["csv-duplicate"][0], b"id,value\n2,beta\n")


if __name__ == "__main__":
    unittest.main()
