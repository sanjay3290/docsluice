"""Structural checks for original layout PDFs; not docsluice acceptance tests."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

from generate import write_fixture


def read_classic_pdf(path: Path) -> tuple[bytes, list[bytes]]:
    data = path.read_bytes()
    if not data.startswith(b"%PDF-1.7\n") or not data.endswith(b"%%EOF\n"):
        raise AssertionError("missing PDF header or EOF")
    xref_offset = int(data.rsplit(b"startxref\n", 1)[1].splitlines()[0])
    if data[xref_offset : xref_offset + 5] != b"xref\n":
        raise AssertionError("startxref does not point to classic xref")
    lines = data[xref_offset:].splitlines()
    count = int(lines[1].split()[1])
    objects: list[bytes] = []
    for object_id, entry in enumerate(lines[3 : 3 + count - 1], 1):
        offset = int(entry.split()[0])
        marker = f"{object_id} 0 obj\n".encode("ascii")
        if not data[offset:].startswith(marker):
            raise AssertionError(f"xref offset for object {object_id} is invalid")
        end = data.index(b"\nendobj\n", offset)
        objects.append(data[offset + len(marker) : end])
    return data, objects


class LayoutPdfFixtures(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "generated"
        write_fixture(self.root)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_deterministic_generation_and_cc0_sidecar(self) -> None:
        second = Path(self.temp.name) / "second"
        write_fixture(second)
        for path in self.root.rglob("*"):
            if path.is_file():
                relative = path.relative_to(self.root)
                self.assertEqual(path.read_bytes(), (second / relative).read_bytes(), relative)
        pdf = self.root / "layout-reference-10-pages.pdf"
        self.assertIn("CC0-1.0", pdf.with_name(pdf.name + ".license").read_text())
        facts = json.loads((self.root / "expected-source-facts.json").read_text())
        self.assertEqual(hashlib.sha256(pdf.read_bytes()).hexdigest(), facts["sha256"])
        self.assertLess(pdf.stat().st_size, 15_000_000)

    def test_pdf_structure_geometry_text_operators_and_source_facts(self) -> None:
        pdf = self.root / "layout-reference-10-pages.pdf"
        data, objects = read_classic_pdf(pdf)
        facts = json.loads((self.root / "expected-source-facts.json").read_text())
        self.assertEqual(facts["pageCount"], 10)
        self.assertEqual(len(re.findall(rb"/Type /Page /Parent", data)), 10)
        self.assertIn(b"/Count 10", data)
        self.assertIn(b"/BaseFont /Helvetica", data)

        page_objects = [obj for obj in objects if b"/Type /Page /Parent" in obj]
        self.assertEqual(len(page_objects), 10)
        stream_ids = []
        for page in page_objects:
            match = re.search(rb"/Contents (\d+) 0 R", page)
            self.assertIsNotNone(match)
            stream_ids.append(int(match.group(1)))
        for page_number, stream_id in enumerate(stream_ids, 1):
            stream_obj = objects[stream_id - 1]
            length = int(re.match(rb"<< /Length (\d+) >>", stream_obj).group(1))
            content = stream_obj.split(b"\nstream\n", 1)[1][:length]
            strings = re.findall(rb"\((.*?)(?<!\\)\) Tj", content)
            self.assertGreaterEqual(len(strings), 3)
            self.assertIn(HEADER_BYTES, strings)
            expected_footer = f"{'ODD' if page_number % 2 else 'EVEN'} FOOTER | page {page_number:02d}".encode()
            self.assertIn(expected_footer, strings)

        self.assertIn(b"/Rotate 90", page_objects[7])
        page_facts = facts["pageFacts"]
        self.assertEqual(page_facts[7]["rotatedGeometry"], {"width": 792, "height": 612})
        self.assertEqual(page_facts[8]["expectedCells"], [["R1C1", "R1C2"], ["R2C1", "R2C2"]])
        self.assertEqual(page_facts[8]["ruleCoordinates"], [[120, 560, 420, 560], [120, 520, 420, 520], [120, 480, 420, 480], [120, 560, 120, 480], [270, 560, 270, 480], [420, 560, 420, 480]])
        self.assertEqual(page_facts[9]["expectedCells"], [["Name", "Value"], ["Alpha", "One"], ["Beta", "Two"]])
        self.assertIn("Full width title spans both reading columns clearly", facts["independentLayoutOrderReference"])
        self.assertEqual(facts["status"], "ORIGINAL_SYNTHETIC_SOURCE_FACTS_ONLY")
        self.assertIn("NOT_TESTED", facts["readerAcceptance"])

    def test_manifest_is_proposal_not_extraction_verified(self) -> None:
        proposal = json.loads((self.root / "manifest.delta.json").read_text())
        self.assertEqual(proposal["status"], "PROPOSED_NOT_EXTRACTION_VERIFIED")
        self.assertEqual(len(proposal["entries"]), 1)
        entry = proposal["entries"][0]
        self.assertEqual(entry["source_file"], "layout-reference-10-pages.pdf")
        self.assertIn("not use source facts as extraction goldens", entry["note"])

    def test_optional_poppler_independent_rendered_text_order_facts(self) -> None:
        # Poppler is optional development tooling; its result is not reader acceptance.
        import shutil

        if not shutil.which("pdftotext"):
            self.skipTest("pdftotext unavailable")
        pdf = self.root / "layout-reference-10-pages.pdf"
        result = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], check=True, capture_output=True, timeout=10)
        text = result.stdout.decode("ascii")
        self.assertEqual(text.count("\f"), 10)
        for marker in (
            "Full width title spans both reading columns clearly",
            "Column C row two",
            "1. Bottom footnote source text.",
            "Inter-",
            "nationalization continues on the next line.",
            "R2C2",
            "Aligned 3 by 2 source table",
            "EVEN FOOTER | page 10",
        ):
            self.assertIn(marker, text)


HEADER_BYTES = b"Synthetic Package E Layout Reference"


if __name__ == "__main__":
    unittest.main()
