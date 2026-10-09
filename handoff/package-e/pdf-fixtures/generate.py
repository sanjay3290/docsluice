"""Original deterministic PDF fixtures. Uses no runtime/library dependencies."""
import json
from pathlib import Path
import sys


def literal(text):
    return "(" + text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ")"


def text_at(text, x=48, y=740, size=12):
    return f"BT /F1 {size} Tf 1 0 0 1 {x} {y} Tm {literal(text)} Tj ET\n".encode("ascii")


class Pdf:
    def __init__(self):
        self.objects = [b"", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
        self.pages = []

    def add(self, value):
        self.objects.append(value.encode("ascii") if isinstance(value, str) else value)
        return len(self.objects)

    def stream(self, content, extra=""):
        return self.add(f"<< /Length {len(content)} {extra} >>\nstream\n".encode("ascii") + content + b"\nendstream")

    def page(self, content, resources="", extra=""):
        stream_id = self.stream(content)
        page_id = self.add(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> {resources} >> /Contents {stream_id} 0 R {extra} >>")
        self.pages.append(page_id)
        return page_id

    def finish(self, catalog_extra=""):
        self.objects[0] = f"<< /Type /Catalog /Pages 2 0 R {catalog_extra} >>".encode("ascii")
        kids = " ".join(f"{page} 0 R" for page in self.pages)
        self.objects[1] = f"<< /Type /Pages /Kids [{kids}] /Count {len(self.pages)} >>".encode("ascii")
        info = self.add("<< /Title (Original docsluice synthetic fixture) /Author (Synthetic author) /CreationDate (D:20260101000000Z) >>")
        result = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0]
        for obj_id, value in enumerate(self.objects, 1):
            offsets.append(len(result))
            result.extend(f"{obj_id} 0 obj\n".encode("ascii") + value + b"\nendobj\n")
        xref = len(result)
        result.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode("ascii"))
        for offset in offsets[1:]:
            result.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
        result.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R /Info {info} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii"))
        return bytes(result)


def fixtures():
    pdf = Pdf()
    first = pdf.page(text_at("Synthetic first page") + text_at("Example link", 48, 700))
    pdf.page(text_at("Synthetic second page"))
    pdf.page(text_at("Synthetic third page"))
    outline = pdf.add("")
    bookmark = pdf.add(f"<< /Title (Synthetic bookmark) /Parent {outline} 0 R /Dest [{first} 0 R /Fit] >>")
    pdf.objects[outline - 1] = f"<< /Type /Outlines /First {bookmark} 0 R /Last {bookmark} 0 R /Count 1 >>".encode("ascii")
    annotation = pdf.add("<< /Type /Annot /Subtype /Link /Rect [48 695 180 715] /Border [0 0 0] /A << /S /URI /URI (https://example.invalid/docsluice) >> >>")
    pdf.objects[first - 1] = pdf.objects[first - 1][:-2] + f" /Annots [{annotation} 0 R] >>".encode("ascii")
    labelled = pdf.finish(f"/PageLabels << /Nums [0 << /S /r >> 2 << /S /D /P (A-) /St 3 >>] >> /Outlines {outline} 0 R")
    result = {"labels-outline-links.pdf": (labelled, {"pages": 3, "text": ["Synthetic first page", "Synthetic second page", "Synthetic third page", "Example link"], "labels": ["i", "ii", "A-3"]})}

    pdf = Pdf()
    # Deliberately interleave content-stream order across two columns.
    pdf.page(text_at("Full width title", 48, 760, 20) + text_at("Left first", 48, 700) + text_at("Right first", 330, 700) + text_at("Left second", 48, 680) + text_at("Right second", 330, 680))
    result["two-columns.pdf"] = (pdf.finish(), {"pages": 1, "text": ["Full width title", "Left first", "Left second", "Right first", "Right second"], "readingOrder": ["Full width title", "Left first", "Left second", "Right first", "Right second"]})

    pdf = Pdf()
    image = pdf.stream(b"\x00\x80\xff", "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8")
    pdf.page(b"q 612 0 0 792 0 0 cm /Im1 Do Q\n", f"/XObject << /Im1 {image} 0 R >>")
    result["image-only.pdf"] = (pdf.finish(), {"pages": 1, "text": [], "noText": True, "imageCoverage": 1, "purpose": "Full-page synthetic image, no OCR ground truth."})

    pdf = Pdf()
    for page in range(1, 101):
        pdf.page(text_at(f"Synthetic performance page {page:03d}"))
    result["text-100-pages.pdf"] = (pdf.finish(), {"pages": 100, "text": [f"Synthetic performance page {page:03d}" for page in range(1, 101)]})
    return result


def action_fixture():
    pdf = Pdf()
    launch = pdf.add("<< /S /Launch /F (never-run.invalid) >>")
    remote = pdf.add("<< /S /GoToR /F (https://example.invalid/remote.pdf) /D [0 /Fit] >>")
    pdf.page(text_at("Action markers must remain inert"), extra=f"/AA << /O {launch} 0 R /C {remote} 0 R >>")
    js = pdf.add("<< /S /JavaScript /JS (this.docsluiceMarker = 1;) >>")
    return pdf.finish(f"/OpenAction {js} 0 R")


def write_file(root, name, data):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    path.with_name(path.name + ".license").write_text("SPDX-License-Identifier: CC0-1.0\nSource: original bytes made for docsluice by pdf-fixtures/generate.py, from PDF syntax and first principles.\nNotes: synthetic fixture; no third-party or private document content.\n", encoding="utf-8")


def generate(root):
    root.mkdir(parents=True, exist_ok=True)
    expected = {}
    samples = fixtures()
    for name, (data, content) in samples.items():
        write_file(root, name, data)
        expected[name] = content
    labelled = samples["labels-outline-links.pdf"][0]
    # Keep byte positions fixed while destroying the first in-use xref offset.
    xref = labelled.rindex(b"xref\n0 ")
    first_entry = labelled.index(b"\n", labelled.index(b"0000000000 65535 f", xref)) + 1
    corrupt = labelled[:first_entry] + b"9999999999" + labelled[first_entry + 10:]
    write_file(root, "hostile/corrupt-xref.pdf", corrupt)
    write_file(root, "hostile/truncated.pdf", labelled[:len(labelled) // 2])
    write_file(root, "hostile/actions.pdf", action_fixture())
    (root / "expected-fixture-content.json").write_text(json.dumps(expected, indent=2) + "\n", encoding="utf-8")
    proposals = [
        {"file": "pdf/actions.pdf", "expect": {"warnings": []}, "maxMs": 2000, "maxHeapMB": 256, "requirement": "PDF-10", "note": "Feature/no-execution/no-network assertions required; empty warning list alone is insufficient."},
        {"file": "pdf/corrupt-xref.pdf", "expect": {"warnings": ["UNREADABLE_PART"]}, "maxMs": 2000, "maxHeapMB": 256, "requirement": "PDF-9", "note": "Outcome tentative: engine may fully repair xref; confirm before registration."},
        {"file": "pdf/truncated.pdf", "expect": {"warnings": ["UNREADABLE_PART"]}, "maxMs": 2000, "maxHeapMB": 256, "requirement": "PDF-9", "note": "Outcome tentative: unrecoverable truncation may be CORRUPT_FILE; confirm before registration."},
    ]
    for entry in proposals:
        entry["source_file"] = "hostile/" + entry["file"].split("/", 1)[1]
        entry["proposed_target"] = "hostile/" + entry["file"]
    (root / "manifest.delta.json").write_text(json.dumps({"status": "PROPOSED_NOT_EXTRACTION_VERIFIED", "entries": proposals}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: generate.py OUTPUT_DIRECTORY")
    generate(Path(sys.argv[1]))
