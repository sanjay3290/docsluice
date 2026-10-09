"""Independent structural/source-fact checks; these are not reader acceptance tests."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from pypdf import PdfReader

from generate import (
    FIXTURE_OWNER_PASSWORD,
    FIXTURE_USER_PASSWORD,
    generate,
)


class AdvancedPdfFixtureTests(unittest.TestCase):
  def setUp(self) -> None:
    self.tempdir = tempfile.TemporaryDirectory()
    self.out = Path(self.tempdir.name) / "fixtures"
    generate(self.out)

  def tearDown(self) -> None:
    self.tempdir.cleanup()

  def test_advanced_fixture_source_facts(self) -> None:
    out = self.out
    facts = json.loads((out / "expected-source-facts.json").read_text())
    metadata = json.loads((out / "generation-metadata.json").read_text())
    assert metadata["status"] == "ORIGINAL_SYNTHETIC_FIXTURES_SOURCE_FACTS_ONLY"
    assert "not claimed" in metadata["byteDeterminism"]
    assert "not tested" in metadata["readerAcceptance"]

    owner = PdfReader(out / "owner-password-only.pdf")
    assert owner.is_encrypted
    assert owner.decrypt("") == 1
    assert len(owner.pages) == facts["owner-password-only.pdf"]["pages"]
    assert "Owner-password-only empty-user fixture." in owner.pages[0].extract_text()

    protected = PdfReader(out / "user-password.pdf")
    assert protected.is_encrypted
    assert protected.decrypt("wrong-password") == 0
    assert protected.decrypt(FIXTURE_USER_PASSWORD) == 1
    assert len(protected.pages) == facts["user-password.pdf"]["pages"]
    assert "User-password protected fixture." in protected.pages[0].extract_text()
    assert FIXTURE_OWNER_PASSWORD == facts["owner-password-only.pdf"]["ownerPassword"]
    owner_authenticated = PdfReader(out / "user-password.pdf")
    assert owner_authenticated.decrypt(FIXTURE_OWNER_PASSWORD) == 2

    form = PdfReader(out / "filled-form.pdf")
    fields = form.get_fields()
    assert fields is not None
    assert {key: str(value.get("/V")) for key, value in fields.items()} == facts[
        "filled-form.pdf"
    ]["fields"]
    widgets = [
        annot.get_object()
        for page in form.pages
        for annot in (page.get("/Annots") or [])
        if annot.get_object().get("/Subtype") == "/Widget"
    ]
    assert len(widgets) == facts["filled-form.pdf"]["widgetCount"]
    assert "Filled form source facts." in form.pages[0].extract_text()

    annotated = PdfReader(out / "annotations.pdf")
    actual_annotations = []
    for ref in annotated.pages[0].get("/Annots") or []:
        annot = ref.get_object()
        actual_annotations.append(
            {
                "subtype": str(annot.get("/Subtype")),
                "contents": str(annot.get("/Contents")),
                "author": str(annot.get("/T")),
            }
        )
    assert actual_annotations == facts["annotations.pdf"]["annotations"]
    assert "Annotation source facts." in annotated.pages[0].extract_text()

    for pdf in out.glob("*.pdf"):
        assert 0 < pdf.stat().st_size < 100_000
        assert pdf.with_name(pdf.name + ".license").read_text().startswith(
            "SPDX-License-Identifier: CC0-1.0"
        )


  @unittest.skipUnless(shutil.which("pdftotext"), "Poppler is unavailable")
  def test_poppler_passwords_and_extracted_text(self) -> None:
    out = self.out

    def extract(name: str, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["pdftotext", *args, str(out / name), "-"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

    owner = extract("owner-password-only.pdf", "-upw", "")
    assert owner.returncode == 0, owner.stderr
    assert "Owner-password-only empty-user fixture." in owner.stdout

    wrong = extract("user-password.pdf", "-upw", "wrong-password")
    assert wrong.returncode != 0
    correct = extract("user-password.pdf", "-upw", FIXTURE_USER_PASSWORD)
    assert correct.returncode == 0, correct.stderr
    assert "User-password protected fixture." in correct.stdout

    form = extract("filled-form.pdf")
    assert form.returncode == 0, form.stderr
    assert "Filled form source facts." in form.stdout


if __name__ == "__main__":
    unittest.main()
