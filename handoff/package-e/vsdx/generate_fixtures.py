#!/usr/bin/env python3
"""Generate original deterministic synthetic VSDX package fixtures."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import zipfile

OUT = Path(__file__).resolve().parent
CORE = "http://schemas.microsoft.com/office/visio/2011/1/core"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"
VISIO_REL = "http://schemas.microsoft.com/visio/2010/relationships/"


def xml_document() -> bytes:
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<VisioDocument xmlns="{CORE}" xmlns:r="{REL}"/>'''.encode()


def page_xml(kind: str, duplicate_id: bool = False) -> bytes:
    if kind == "opening":
        finish_id = "4" if duplicate_id else "9"
        text = '''<Shape ID="4" Name="Start" NameU="Start" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0"><Text xml:space="preserve">Start\nCafé Δ — 終わり &amp; continue</Text></Shape>'''
        group = '''<Shape ID="5" Name="Group" NameU="Group" Type="Group" LineStyle="0" FillStyle="0" TextStyle="0"><Shapes><Shape ID="6" Name="InnerA" NameU="InnerA" Type="Shape"><Text>Grouped child α</Text></Shape><Shape ID="7" Name="InnerB" NameU="InnerB" Type="Shape"><Text xml:space="preserve">Nested\nline</Text></Shape></Shapes></Shape>'''
        empty = '''<Shape ID="8" Name="Empty" NameU="Empty" Type="Shape"/>'''
        finish = f'''<Shape ID="{finish_id}" Name="Finish" NameU="Finish" Type="Shape"><Text>Finish</Text></Shape>'''
        connector = '''<Shape ID="10" Name="Connector" NameU="Connector" Type="Shape"/>'''
        connects = '''<Connects><Connect FromSheet="10" FromCell="BeginX" FromPart="9" ToSheet="4" ToCell="PinX" ToPart="3"/><Connect FromSheet="10" FromCell="EndX" FromPart="12" ToSheet="9" ToCell="PinX" ToPart="3"/></Connects>'''
        shapes = text + group + empty + finish + connector
    else:
        shapes = '''<Shape ID="4" Name="ReviewNote" NameU="ReviewNote" Type="Shape"><Text>Second page review</Text></Shape><Shape ID="5" Name="Blank" NameU="Blank" Type="Shape"/>'''
        connects = ""

    payload = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<PageContents xmlns="{CORE}" xmlns:r="{REL}" xml:space="preserve"><Shapes>{shapes}</Shapes>{connects}</PageContents>'''
    return payload.encode("utf-8")


def pages_xml() -> bytes:
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Pages xmlns="{CORE}" xmlns:r="{REL}" xml:space="preserve">
  <Page ID="1" Name="01 — Opening" NameU="Opening"><PageSheet LineStyle="0" FillStyle="0" TextStyle="0"><Cell N="PageWidth" V="8.5"/><Cell N="PageHeight" V="11"/><Cell N="PageScale" V="1"/><Cell N="DrawingScale" V="1"/></PageSheet><Rel r:id="rIdOpen"/></Page>
  <Page ID="2" Name="02 — Review" NameU="Review"><PageSheet LineStyle="0" FillStyle="0" TextStyle="0"><Cell N="PageWidth" V="8.5"/><Cell N="PageHeight" V="11"/><Cell N="PageScale" V="1"/><Cell N="DrawingScale" V="1"/></PageSheet><Rel r:id="rIdReview"/></Page>
</Pages>'''.encode("utf-8")


def root_rels() -> bytes:
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="{PKG_REL}"><Relationship Id="rIdDocument" Type="{VISIO_REL}document" Target="visio/document.xml"/></Relationships>'''.encode()


def document_rels() -> bytes:
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="{PKG_REL}"><Relationship Id="rIdPages" Type="{VISIO_REL}pages" Target="pages/pages.xml"/></Relationships>'''.encode()


def pages_rels(missing: bool = False, traversal: bool = False) -> bytes:
    open_target = "../../../../outside.xml" if traversal else "page2.xml"
    rows = ['<Relationship Id="rIdReview" Type="' + VISIO_REL + 'page" Target="page1.xml"/>']
    if not missing:
        rows.append('<Relationship Id="rIdOpen" Type="' + VISIO_REL + 'page" Target="' + open_target + '"/>')
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="{PKG_REL}">{''.join(rows)}</Relationships>'''.encode()


def content_types() -> bytes:
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="{CONTENT_TYPES}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/>
  <Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>
  <Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/>
  <Override PartName="/visio/pages/page2.xml" ContentType="application/vnd.ms-visio.page+xml"/>
</Types>'''.encode()


def package_parts(
    *,
    malformed: bool = False,
    missing_rel: bool = False,
    duplicate_id: bool = False,
    traversal: bool = False,
    hostile_xml: bool = False,
) -> dict[str, bytes]:
    page1 = page_xml("review")
    page2 = page_xml("opening", duplicate_id=duplicate_id)
    if malformed:
        page1 = f'<PageContents xmlns="{CORE}"><Shapes><Shape ID="4">'.encode()
    if hostile_xml:
        page2 = f'''<?xml version="1.0"?>
<!DOCTYPE PageContents [<!ENTITY leak SYSTEM "file:///etc/passwd">]>
<PageContents xmlns="{CORE}"><Shapes><Shape ID="4"><Text>&leak;</Text></Shape></Shapes></PageContents>'''.encode()

    # Zip member order is intentionally unrelated to page order and rel order.
    return {
        "[Content_Types].xml": content_types(),
        "_rels/.rels": root_rels(),
        "visio/document.xml": xml_document(),
        "visio/_rels/document.xml.rels": document_rels(),
        "visio/pages/pages.xml": pages_xml(),
        "visio/pages/_rels/pages.xml.rels": pages_rels(missing=missing_rel, traversal=traversal),
        "visio/pages/page1.xml": page1,
        "visio/pages/page2.xml": page2,
    }


def write_package(path: Path, parts: dict[str, bytes]) -> dict[str, object]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, payload in parts.items():
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.flag_bits = 0
            archive.writestr(info, payload)
    member_hashes = {
        name: hashlib.sha256(payload).hexdigest()
        for name, payload in parts.items()
    }
    return {
        "archiveSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "members": member_hashes,
    }


def license_text(label: str) -> str:
    return (
        "SPDX-License-Identifier: CC0-1.0\n"
        "Source: Original synthetic package parts generated by generate_fixtures.py using Python standard library only.\n"
        f"Notes: {label}. Not created or rendered with Microsoft Visio; not a complete Visio-app-validated document.\n"
    )


def make_fixtures(output_dir: Path = OUT) -> None:
    cases = {
        "tiny-flow.vsdx": ({}, "small synthetic two-page flow with shapes, grouped children, a connector, and an empty shape"),
        "bounded-malformed.vsdx": ({"malformed": True}, "page1 XML is intentionally truncated; not an extraction expectation"),
        "missing-relationship.vsdx": ({"missing_rel": True}, "Opening page rId has no relationship entry; source facts only"),
        "duplicate-id.vsdx": ({"duplicate_id": True}, "Opening page contains duplicate shape IDs 4; malformed source fact only"),
        "traversal-part.vsdx": ({"traversal": True}, "Opening page relationship target escapes package root; no outside member is present"),
        "xml-hostile-candidate.vsdx": ({"hostile_xml": True}, "Page XML contains an external entity declaration; tests inspect bytes only and do not parse it"),
    }
    all_hashes: dict[str, object] = {}
    source_facts: dict[str, object] = {}
    for filename, (kwargs, note) in cases.items():
        path = output_dir / filename
        all_hashes[filename] = write_package(path, package_parts(**kwargs))
        path.with_suffix(path.suffix + ".license").write_text(license_text(note), encoding="utf-8", newline="\n")
        source_facts[filename] = {"fixtureNote": note, "extractionGolden": False}

    source_facts["tiny-flow.vsdx"].update({
        "pageOrder": [
            {"id": "1", "name": "01 — Opening", "nameU": "Opening", "relationshipId": "rIdOpen", "part": "visio/pages/page2.xml"},
            {"id": "2", "name": "02 — Review", "nameU": "Review", "relationshipId": "rIdReview", "part": "visio/pages/page1.xml"},
        ],
        "textByShapePath": [
            {"page": "Opening", "shapeIds": ["4"], "text": "Start\nCafé Δ — 終わり & continue"},
            {"page": "Opening", "shapeIds": ["5", "6"], "text": "Grouped child α"},
            {"page": "Opening", "shapeIds": ["5", "7"], "text": "Nested\nline"},
            {"page": "Opening", "shapeIds": ["9"], "text": "Finish"},
            {"page": "Review", "shapeIds": ["4"], "text": "Second page review"},
        ],
        "emptyShape": {"page": "Opening", "shapeId": "8", "hasTextElement": False},
        "connector": {"page": "Opening", "shapeId": "10", "connectCount": 2},
    })

    (output_dir / "member-hashes.json").write_text(
        json.dumps(all_hashes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    (output_dir / "expected-source-facts.json").write_text(
        json.dumps(source_facts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )


if __name__ == "__main__":
    make_fixtures()
