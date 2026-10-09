#!/usr/bin/env python3
"""Create a tiny original PDF attachment fixture using only Python stdlib.

The fixed object ordering, metadata, document IDs and ZIP timestamps make this
fixture byte-stable across reruns with the same Python version. It is synthetic
and CC0; it is not a PDF reader acceptance test.
"""
from __future__ import annotations

import hashlib
import json
import os
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2] / "pdf-fixtures" / "attachments"
ROOT.mkdir(parents=True, exist_ok=True)


def pdf_literal(text: str) -> bytes:
    raw = text.encode("ascii")
    return b"(" + raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)") + b")"


def stream_object(data: bytes, extra: bytes = b"") -> bytes:
    return b"<< /Length " + str(len(data)).encode() + (b" " + extra if extra else b"") + b" >>\nstream\n" + data + b"\nendstream"


def write_pdf(objects: list[bytes], target: Path) -> None:
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, value in enumerate(objects, 1):
        offsets.append(len(out))
        out.extend(f"{index} 0 obj\n".encode())
        out.extend(value)
        out.extend(b"\nendobj\n")
    xref = len(out)
    out.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    out.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        out.extend(f"{offset:010d} 00000 n \n".encode())
    out.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /ID [<00112233445566778899AABBCCDDEEFF><00112233445566778899AABBCCDDEEFF>] >>\nstartxref\n{xref}\n%%EOF\n".encode())
    target.write_bytes(out)


csv = b"id,value\n1,alpha\n"
zip_path = ROOT / "nested.zip"
with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    info = zipfile.ZipInfo("inside.txt", (2020, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o100644 << 16
    archive.writestr(info, b"Nested attachment sample.\n")
nested_zip = zip_path.read_bytes()

payloads = [
    ("csv-primary", "data.csv", csv),
    ("csv-duplicate", "data.csv", b"id,value\n2,beta\n"),
    ("nested-zip", "nested.zip", nested_zip),
    ("traversal-name", "../../../../etc/passwd.csv", b"not a real passwd file\n"),
    ("__proto__", "__proto__", b"prototype-key filename\n"),
]
payloads.sort(key=lambda item: item[0])
objects: list[bytes] = [b"", b"", b""]
stream_refs = [4 + i * 2 for i in range(len(payloads))]
filespec_refs = [5 + i * 2 for i in range(len(payloads))]
page_ref = 4 + len(payloads) * 2
content_ref = page_ref + 1
facts = []
for key, filename, data in payloads:
    stream_id = len(objects) + 1
    objects.append(stream_object(data, b"/Type /EmbeddedFile /Subtype /application#2Foctet-stream"))
    file_id = len(objects) + 1
    encoded = filename.encode("ascii").hex().upper()
    objects.append(
        b"<< /Type /Filespec /F <" + encoded.encode() + b"> /UF <" + encoded.encode()
        + b"> /Desc " + pdf_literal("Synthetic attachment " + key)
        + b" /AFRelationship /Data /EF << /F " + str(stream_id).encode() + b" 0 R /UF "
        + str(stream_id).encode() + b" 0 R >> >>"
    )
    assert file_id == len(objects)
    facts.append({"nameTreeKey": key, "filename": filename, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
objects.append(
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents "
    + str(content_ref).encode() + b" 0 R >>"
)
objects.append(stream_object(b""))
objects[0] = (
    b"<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 3 0 R >> /AF ["
    + b" ".join(f"{ref} 0 R".encode() for ref in filespec_refs) + b"] >>"
)
objects[1] = b"<< /Type /Pages /Kids [" + str(page_ref).encode() + b" 0 R] /Count 1 >>"
objects[2] = b"<< /Names [" + b" ".join(
    pdf_literal(key) + b" " + f"{filespec_refs[i]} 0 R".encode()
    for i, (key, _, _) in enumerate(payloads)
) + b"] >>"
# The body text stream has no font resources intentionally; keep page recovery
# independent from attachment extraction. The attachment fixture itself is a
# structurally valid xref/trailer PDF and each file stream is independently
# checked below.
pdf_path = ROOT / "attachments-edge-cases.pdf"
write_pdf(objects, pdf_path)
(ROOT / "attachments-edge-cases.pdf.license").write_text(
    "CC0 1.0 Universal. Original synthetic fixture generated for DocSluice preparation.\n"
    "Contains no personal or third-party document content.\n", encoding="utf-8")
(ROOT / "expected-source-facts.json").write_text(json.dumps({
    "status": "SYNTHETIC_SOURCE_FACTS_ONLY_NOT_READER_ACCEPTANCE",
    "license": "CC0-1.0",
    "pages": 1,
    "attachments": facts,
    "expectations": [
        "The PDF has five embedded-file filespecs under a sorted name tree.",
        "Two distinct name-tree keys refer to the same filename data.csv.",
        "One filename contains path traversal segments and must never be used as a filesystem path.",
        "One name-tree key and filename are exactly __proto__; attachment records must not be stored in ordinary prototype-bearing objects keyed by untrusted values.",
        "nested.zip is a ZIP containing inside.txt with fixed 2020-01-01 timestamp.",
    ],
    "generator": "generate-attachments.py (Python standard library only)",
    "byteDeterminism": "fixed object ordering, ID, payloads and ZIP timestamps; generator test compares repeated output bytes",
}, indent=2, sort_keys=True) + "\n", encoding="utf-8")

print(json.dumps({"pdf": str(pdf_path), "bytes": pdf_path.stat().st_size, "sha256": hashlib.sha256(pdf_path.read_bytes()).hexdigest()}, sort_keys=True))
