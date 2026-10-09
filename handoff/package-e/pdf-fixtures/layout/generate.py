"""Generate deterministic, original 10-page PDF layout source fixture (stdlib only)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys


PAGE_WIDTH = 612
PAGE_HEIGHT = 792
HEADER = "Synthetic Package E Layout Reference"


def pdf_literal(text: str) -> str:
    if not text.isascii():
        raise ValueError("the fixture intentionally uses ASCII-only Helvetica text")
    return "(" + text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ")"


def text_op(text: str, x: int, y: int, size: int = 12) -> bytes:
    return f"BT /F1 {size} Tf 1 0 0 1 {x} {y} Tm {pdf_literal(text)} Tj ET\n".encode("ascii")


def rules_op(lines: list[tuple[int, int, int, int]]) -> bytes:
    return ("".join(f"{x0} {y0} m {x1} {y1} l\n" for x0, y0, x1, y1 in lines) + "S\n").encode("ascii")


class Pdf:
    def __init__(self) -> None:
        self.objects: list[bytes] = [b"", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
        self.pages: list[int] = []

    def add(self, value: bytes | str) -> int:
        self.objects.append(value.encode("ascii") if isinstance(value, str) else value)
        return len(self.objects)

    def stream(self, content: bytes) -> int:
        return self.add(f"<< /Length {len(content)} >>\nstream\n".encode("ascii") + content + b"endstream")

    def page(self, content: bytes, rotation: int = 0) -> int:
        stream_id = self.stream(content)
        extra = f" /Rotate {rotation}" if rotation else ""
        page_id = self.add(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {stream_id} 0 R{extra} >>"
        )
        self.pages.append(page_id)
        return page_id

    def finish(self) -> bytes:
        self.objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
        kids = " ".join(f"{page} 0 R" for page in self.pages)
        self.objects[1] = f"<< /Type /Pages /Kids [{kids}] /Count {len(self.pages)} >>".encode("ascii")
        info = self.add(
            "<< /Title (Original synthetic layout fixture) /Author (docsluice fixture generator) "
            "/CreationDate (D:20261009000000Z) >>"
        )
        output = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0]
        for obj_id, value in enumerate(self.objects, 1):
            offsets.append(len(output))
            output.extend(f"{obj_id} 0 obj\n".encode("ascii") + value + b"\nendobj\n")
        xref = len(output)
        output.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode("ascii"))
        for offset in offsets[1:]:
            output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
        output.extend(
            f"trailer\n<< /Size {len(offsets)} /Root 1 0 R /Info {info} 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n".encode("ascii")
        )
        return bytes(output)


def page_content(body: list[tuple[str, int, int, int]], footer_page: int, rules: list[tuple[int, int, int, int]] | None = None) -> bytes:
    # Content stream order intentionally differs from visual reading order on column pages.
    content = bytearray(text_op(HEADER, 36, 766, 9))
    content.extend(text_op(f"{'ODD' if footer_page % 2 else 'EVEN'} FOOTER | page {footer_page:02d}", 36, 22, 9))
    if rules:
        content.extend(rules_op(rules))
    for text, x, y, size in body:
        content.extend(text_op(text, x, y, size))
    return bytes(content)


def build_fixture() -> tuple[bytes, dict[str, object]]:
    pdf = Pdf()
    content_records: list[dict[str, object]] = []

    pages: list[tuple[list[tuple[str, int, int, int]], int, list[tuple[int, int, int, int]] | None, dict[str, object]]] = []
    # 1: simple one-column sequence.
    pages.append(([
        ("Layout reference page one", 48, 710, 16),
        ("Single column first line", 48, 670, 12),
        ("Single column second line", 48, 650, 12),
    ], 0, None, {"features": ["one-column"], "order": ["Layout reference page one", "Single column first line", "Single column second line"]}))

    # 2: full-width title above two columns, with interleaved stream order.
    pages.append(([
        ("Full width title spans both reading columns clearly", 36, 720, 18),
        ("Left column first line", 48, 675, 12),
        ("Right column first line", 330, 675, 12),
        ("Left column second line", 48, 655, 12),
        ("Right column second line", 330, 655, 12),
    ], 0, None, {"features": ["two-columns", "full-width-title", "interleaved-stream-order"], "order": ["Full width title spans both reading columns clearly", "Left column first line", "Left column second line", "Right column first line", "Right column second line"]}))

    # 3: three columns; stream runs alternate across columns.
    pages.append(([
        ("Three column heading", 48, 710, 15),
        ("Column A row one", 48, 670, 11),
        ("Column B row one", 230, 670, 11),
        ("Column C row one", 412, 670, 11),
        ("Column A row two", 48, 650, 11),
        ("Column B row two", 230, 650, 11),
        ("Column C row two", 412, 650, 11),
    ], 0, None, {"features": ["three-columns"], "order": ["Three column heading", "Column A row one", "Column A row two", "Column B row one", "Column B row two", "Column C row one", "Column C row two"]}))

    # 4: font-size heading and paragraph.
    pages.append(([
        ("Font Size Heading", 48, 710, 24),
        ("The body sentence follows beneath the heading.", 48, 670, 12),
    ], 0, None, {"features": ["font-size-heading"], "order": ["Font Size Heading", "The body sentence follows beneath the heading."]}))

    # 5: body and a line intentionally placed at the page bottom as a footnote.
    pages.append(([
        ("Body sentence ends before the note.", 48, 660, 12),
        ("1. Bottom footnote source text.", 48, 42, 9),
    ], 0, None, {"features": ["bottom-footnote"], "order": ["Body sentence ends before the note.", "1. Bottom footnote source text."]}))

    # 6: separately positioned small numeral tests superscript association.
    pages.append(([
        ("Water", 48, 650, 12),
        ("2", 82, 657, 8),
        (" remains a synthetic source fact.", 88, 650, 12),
    ], 0, None, {"features": ["superscript"], "order": ["Water", "2", " remains a synthetic source fact."], "visualToken": "Water2 remains a synthetic source fact."}))

    # 7: expected source has a trailing hyphen followed by lowercase continuation.
    pages.append(([
        ("Inter-", 48, 650, 12),
        ("nationalization continues on the next line.", 48, 630, 12),
    ], 0, None, {"features": ["line-end-hyphenation"], "sourceLines": ["Inter-", "nationalization continues on the next line."], "joinedSourceText": "Inter-nationalization continues on the next line."}))

    # 8: clockwise-rotated media box page.
    pages.append(([
        ("Rotated page source geometry", 48, 710, 14),
        ("Rotation content line", 48, 680, 12),
    ], 90, None, {"features": ["rotation-90"], "order": ["Rotated page source geometry", "Rotation content line"], "sourceMediaBox": [0, 0, PAGE_WIDTH, PAGE_HEIGHT], "rotation": 90, "rotatedGeometry": {"width": PAGE_HEIGHT, "height": PAGE_WIDTH}}))

    # 9: complete ruled 2x2 table; PDF rule coordinates are explicit source facts.
    rules_2x2 = [(120, 560, 420, 560), (120, 520, 420, 520), (120, 480, 420, 480), (120, 560, 120, 480), (270, 560, 270, 480), (420, 560, 420, 480)]
    pages.append(([
        ("Ruled 2 by 2 table", 48, 700, 14),
        ("R1C1", 145, 535, 11), ("R1C2", 295, 535, 11),
        ("R2C1", 145, 495, 11), ("R2C2", 295, 495, 11),
    ], 0, rules_2x2, {"features": ["ruled-table-2x2"], "expectedCells": [["R1C1", "R1C2"], ["R2C1", "R2C2"]], "ruleCoordinates": rules_2x2}))

    # 10: aligned 3x2 text table, intentionally without drawn borders.
    pages.append(([
        ("Aligned 3 by 2 source table", 48, 700, 14),
        ("Name", 60, 650, 11), ("Value", 310, 650, 11),
        ("Alpha", 60, 628, 11), ("One", 310, 628, 11),
        ("Beta", 60, 606, 11), ("Two", 310, 606, 11),
    ], 0, None, {"features": ["aligned-table-3x2"], "expectedCells": [["Name", "Value"], ["Alpha", "One"], ["Beta", "Two"]], "sourceCellAnchors": [[60, 650], [310, 650], [60, 628], [310, 628], [60, 606], [310, 606]]}))

    for page_index, (body, rotation, rules, facts) in enumerate(pages, 1):
        pdf.page(page_content(body, page_index, rules), rotation)
        content_records.append({
            "page": page_index,
            "geometry": {"mediaBox": [0, 0, PAGE_WIDTH, PAGE_HEIGHT], "rotation": rotation,
                          "width": PAGE_HEIGHT if rotation in (90, 270) else PAGE_WIDTH,
                          "height": PAGE_WIDTH if rotation in (90, 270) else PAGE_HEIGHT},
            "header": HEADER,
            "footer": f"{'ODD' if page_index % 2 else 'EVEN'} FOOTER | page {page_index:02d}",
            **facts,
        })

    data = pdf.finish()
    sequence = [
        "Layout reference page one", "Single column first line", "Single column second line",
        "Full width title spans both reading columns clearly", "Left column first line", "Left column second line", "Right column first line", "Right column second line",
        "Three column heading", "Column A row one", "Column A row two", "Column B row one", "Column B row two", "Column C row one", "Column C row two",
        "Font Size Heading", "The body sentence follows beneath the heading.",
        "Body sentence ends before the note.", "1. Bottom footnote source text.",
        "Water", "2", " remains a synthetic source fact.",
        "Inter-", "nationalization continues on the next line.",
        "Rotated page source geometry", "Rotation content line",
        "Ruled 2 by 2 table", "R1C1", "R1C2", "R2C1", "R2C2",
        "Aligned 3 by 2 source table", "Name", "Value", "Alpha", "One", "Beta", "Two",
    ]
    facts = {
        "status": "ORIGINAL_SYNTHETIC_SOURCE_FACTS_ONLY",
        "readerAcceptance": "NOT_TESTED; these are not extraction goldens or an accuracy claim",
        "pageCount": 10,
        "fontClaim": "Standard Type 1 Helvetica, ASCII-only source strings; no embedded Unicode font claim.",
        "pageFacts": content_records,
        "independentLayoutOrderReference": sequence,
        "contiguousOrderReference": " ".join(sequence),
        "note": "The order reference is manually authored from generator source geometry and stream content. It is not asserted as actual reader output.",
    }
    return data, facts


def write_fixture(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    data, facts = build_fixture()
    name = "layout-reference-10-pages.pdf"
    output = root / name
    output.write_bytes(data)
    output.with_name(output.name + ".license").write_text(
        "SPDX-License-Identifier: CC0-1.0\n"
        "Source: original synthetic bytes generated by layout/generate.py from PDF syntax and first principles.\n"
        "Notes: ASCII-only Helvetica; no third-party or private document content. Source facts are not extraction goldens.\n",
        encoding="utf-8",
    )
    facts["sha256"] = hashlib.sha256(data).hexdigest()
    (root / "expected-source-facts.json").write_text(json.dumps(facts, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (root / "manifest.delta.json").write_text(
        json.dumps({
            "status": "PROPOSED_NOT_EXTRACTION_VERIFIED",
            "entries": [{
                "source_file": name,
                "proposed_target": "pdf/layout/" + name,
                "expect": {"pages": 10},
                "requirement": "PDF-2",
                "note": "Source-fact fixture only. Assign expected warnings/output only after testing the actual approved reader; do not use source facts as extraction goldens.",
            }],
        }, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: generate.py OUTPUT_DIRECTORY")
    write_fixture(Path(sys.argv[1]))
