"""Generate original encrypted, filled-form, and annotation PDFs for preparation only.

Tooling used in this environment: pypdf 6.10.0 (test/generation dependency only).
Output bytes are not promised stable across pypdf/cryptography versions; tests
assert structure and source facts, not file hashes or reader behavior.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys
from io import BytesIO

import pypdf
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import FreeText, Text
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
    RectangleObject,
    TextStringObject,
)


FIXTURE_USER_PASSWORD = "fixture-user-secret"
FIXTURE_OWNER_PASSWORD = "fixture-owner-secret"


def base_pdf(text: str) -> bytes:
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    stream = DecodedStreamObject()
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream.set_data(f"BT /F1 14 Tf 48 740 Td ({escaped}) Tj ET\n".encode("ascii"))
    stream_ref = writer._add_object(stream)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_ref = writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref})}
    )
    page[NameObject("/Contents")] = stream_ref
    writer.add_metadata(
        {
            "/Title": "Original synthetic Package E fixture",
            "/Author": "Synthetic fixture author",
            "/CreationDate": "D:20260101000000Z",
        }
    )
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def encrypted_pdf(data: bytes, user_password: str) -> bytes:
    reader = PdfReader(BytesIO(data))
    writer = PdfWriter()
    writer.append(reader)
    writer.encrypt(
        user_password=user_password,
        owner_password=FIXTURE_OWNER_PASSWORD,
        algorithm="AES-256",
    )
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def filled_form_pdf() -> bytes:
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 12 Tf 48 740 Td (Filled form source facts.) Tj ET\n")
    stream_ref = writer._add_object(stream)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})}
    )
    page[NameObject("/Contents")] = stream_ref

    text_widget = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Widget"),
            NameObject("/FT"): NameObject("/Tx"),
            NameObject("/T"): TextStringObject("applicant.name"),
            NameObject("/V"): TextStringObject("Ada Example"),
            NameObject("/Rect"): RectangleObject([48, 680, 300, 710]),
            NameObject("/F"): NumberObject(4),
            NameObject("/DA"): TextStringObject("/Helv 12 Tf 0 g"),
        }
    )
    check_widget = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Widget"),
            NameObject("/FT"): NameObject("/Btn"),
            NameObject("/T"): TextStringObject("consent"),
            NameObject("/V"): NameObject("/Yes"),
            NameObject("/AS"): NameObject("/Yes"),
            NameObject("/Rect"): RectangleObject([48, 630, 68, 650]),
            NameObject("/F"): NumberObject(4),
        }
    )
    text_ref = writer._add_object(text_widget)
    check_ref = writer._add_object(check_widget)
    text_widget[NameObject("/P")] = page.indirect_reference
    check_widget[NameObject("/P")] = page.indirect_reference
    page[NameObject("/Annots")] = ArrayObject([text_ref, check_ref])
    acro_form = DictionaryObject(
        {
            NameObject("/Fields"): ArrayObject([text_ref, check_ref]),
            NameObject("/NeedAppearances"): NumberObject(1),
            NameObject("/DA"): TextStringObject("/Helv 12 Tf 0 g"),
        }
    )
    writer._root_object[NameObject("/AcroForm")] = writer._add_object(acro_form)
    writer.add_metadata(
        {
            "/Title": "Original synthetic filled form",
            "/Author": "Synthetic fixture author",
            "/CreationDate": "D:20260101000000Z",
        }
    )
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def annotations_pdf() -> bytes:
    writer = PdfWriter()
    writer.append(PdfReader(BytesIO(base_pdf("Annotation source facts."))))
    writer.add_annotation(
        0,
        Text(
            rect=(48, 650, 72, 674),
            text="Synthetic sticky note text.",
            title_bar="Fixture Annotation Author",
        ),
    )
    writer.add_annotation(
        0,
        FreeText(
            rect=(80, 640, 280, 680),
            text="Synthetic free-text annotation.",
            title_bar="Fixture Annotation Author",
            font_size="12pt",
        ),
    )
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def write_pdf(root: Path, name: str, data: bytes, note: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    path = root / name
    path.write_bytes(data)
    path.with_name(path.name + ".license").write_text(
        "SPDX-License-Identifier: CC0-1.0\n"
        "Source: original synthetic fixture generated by advanced/generate.py.\n"
        f"Notes: {note} Tool used: pypdf {pypdf.__version__} (generation only).\n",
        encoding="utf-8",
    )


def generate(root: Path) -> None:
    if pypdf.__version__ != "6.10.0":
        raise SystemExit(
            f"Regeneration was reviewed with pypdf 6.10.0; found {pypdf.__version__}. "
            "Review output before changing the tool version."
        )
    root.mkdir(parents=True, exist_ok=True)
    write_pdf(
        root,
        "owner-password-only.pdf",
        encrypted_pdf(base_pdf("Owner-password-only empty-user fixture."), ""),
        "AES-256 encryption; empty user password; synthetic owner password is held in the test only.",
    )
    write_pdf(
        root,
        "user-password.pdf",
        encrypted_pdf(base_pdf("User-password protected fixture."), FIXTURE_USER_PASSWORD),
        "AES-256 encryption; synthetic user and owner passwords are held in the test only.",
    )
    write_pdf(
        root,
        "filled-form.pdf",
        filled_form_pdf(),
        "One filled text widget and one selected checkbox; no private form data.",
    )
    write_pdf(
        root,
        "annotations.pdf",
        annotations_pdf(),
        "One sticky note and one free-text annotation with a synthetic author value.",
    )
    facts = {
        "owner-password-only.pdf": {
            "pages": 1,
            "encrypted": True,
            "userPassword": "",
            "ownerPassword": FIXTURE_OWNER_PASSWORD,
            "text": "Owner-password-only empty-user fixture.",
        },
        "user-password.pdf": {
            "pages": 1,
            "encrypted": True,
            "userPassword": FIXTURE_USER_PASSWORD,
            "ownerPassword": FIXTURE_OWNER_PASSWORD,
            "text": "User-password protected fixture.",
        },
        "filled-form.pdf": {
            "pages": 1,
            "fields": {"applicant.name": "Ada Example", "consent": "/Yes"},
            "widgetCount": 2,
            "text": "Filled form source facts.",
        },
        "annotations.pdf": {
            "pages": 1,
            "annotations": [
                {
                    "subtype": "/Text",
                    "contents": "Synthetic sticky note text.",
                    "author": "Fixture Annotation Author",
                },
                {
                    "subtype": "/FreeText",
                    "contents": "Synthetic free-text annotation.",
                    "author": "Fixture Annotation Author",
                },
            ],
            "text": "Annotation source facts.",
        },
    }
    (root / "expected-source-facts.json").write_text(
        json.dumps(facts, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (root / "generation-metadata.json").write_text(
        json.dumps(
            {
                "status": "ORIGINAL_SYNTHETIC_FIXTURES_SOURCE_FACTS_ONLY",
                "generator": "advanced/generate.py",
                "generatorTool": f"pypdf {pypdf.__version__} (tool-only; no repository dependency)",
                "byteDeterminism": "not claimed; encryption may use randomized file identifiers",
                "readerAcceptance": "not tested; requires the future PDF reader/engine",
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: generate.py OUTPUT_DIRECTORY")
    generate(Path(sys.argv[1]))
