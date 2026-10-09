#!/usr/bin/env python3
"""Build deterministic, self-authored PresentationML edge-case fixtures.

Uses only Python's standard library. ZIP member timestamps and permissions are
fixed so repeated generation produces byte-identical archives.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import posixpath
import re
import zipfile
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parent
CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
DGM = "http://schemas.openxmlformats.org/drawingml/2006/diagram"

PFX = f'xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}"'
CHART_PFX = f'xmlns:c="{C}" xmlns:a="{A}"'
REL_OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
REL_SLIDE = f"{R}/slide"
REL_LAYOUT = f"{R}/slideLayout"
REL_NOTES = f"{R}/notesSlide"
REL_NOTES_MASTER = f"{R}/notesMaster"
REL_CHART = f"{R}/chart"
REL_DIAGRAM_DATA = f"{R}/diagramData"


def xml_bytes(text: str) -> bytes:
    return ("<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n" + text).encode("utf-8")


def rels(entries: list[tuple[str, str, str]]) -> str:
    body = "".join(
        f'<Relationship Id="{rid}" Type="{kind}" Target="{target}"/>'
        for rid, kind, target in entries
    )
    return f'<Relationships xmlns="{REL_NS}">{body}</Relationships>'


def shape(text: str, *, name: str = "Text", x: int = 0, y: int = 0,
          placeholder: str | None = None, no_transform: bool = False,
          placeholder_idx: int | None = None, body_text: str | None = None) -> str:
    ph_idx = f' idx="{placeholder_idx}"' if placeholder_idx is not None else ""
    ph = f'<p:ph type="{placeholder}"{ph_idx}/>' if placeholder else ""
    xfrm = "" if no_transform else f'<a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="100000" cy="50000"/></a:xfrm>'
    paragraphs = "".join(f"<a:p><a:r><a:t>{t}</a:t></a:r></a:p>" for t in (body_text or text).split("\n"))
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="2" name="{name}"/><p:cNvSpPr/><p:nvPr>{ph}</p:nvPr>'
        f'</p:nvSpPr><p:spPr>{xfrm}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>{paragraphs}</p:txBody></p:sp>'
    )


def group(inner: str, *, x: int = 0, y: int = 0, cx: int = 100000,
          cy: int = 100000, chx: int = 0, chy: int = 0,
          chcx: int = 100000, chcy: int = 100000) -> str:
    return (
        '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="3" name="Group"/><p:cNvGrpSpPr/>'
        '<p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm>'
        f'<a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/>'
        f'<a:chOff x="{chx}" y="{chy}"/><a:chExt cx="{chcx}" cy="{chcy}"/>'
        f'</a:xfrm></p:grpSpPr>{inner}</p:grpSp>'
    )


def assign_shape_ids(children: str) -> str:
    next_id = 2

    def assign_id(match: re.Match[str]) -> str:
        nonlocal next_id
        tag = f'<p:cNvPr id="{next_id}"'
        next_id += 1
        return tag

    return re.sub(r'<p:cNvPr id="\d+"', assign_id, children)


def slide_xml(children: str, *, show: bool = True) -> str:
    children = assign_shape_ids(children)
    hidden = "" if show else ' show="0"'
    return (
        f'<p:sld {PFX}{hidden}><p:cSld><p:spTree><p:nvGrpSpPr>'
        '<p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        f'<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
        f'<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>{children}'
        '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
    )


def table_xml() -> str:
    rows = []
    for values in (("Header A", "Header B"), ("Cell 1", "Cell 2")):
        cells = "".join(f'<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{v}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>' for v in values)
        rows.append(f'<a:tr h="100000">{cells}</a:tr>')
    return (
        f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Feature table"/>'
        '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="600000"/>'
        '<a:ext cx="400000" cy="200000"/></p:xfrm><a:graphic><a:graphicData '
        'uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>'
        '<a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="200000"/><a:gridCol w="200000"/></a:tblGrid>'
        f'{"".join(rows)}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
    )


def chart_xml(kind: str, labels: list[tuple[int, str]], values: list[tuple[int, str]]) -> str:
    cats = "".join(f'<c:pt idx="{i}"><c:v>{v}</c:v></c:pt>' for i, v in labels)
    vals = "".join(f'<c:pt idx="{i}"><c:v>{v}</c:v></c:pt>' for i, v in values)
    chart_kind = {"bar": "barChart", "line": "lineChart", "pie": "pieChart"}[kind]
    grouping = '<c:grouping val="clustered"/>' if kind == "bar" else ""
    bar_dir = '<c:barDir val="col"/>' if kind == "bar" else ""
    axis = '<c:axId val="10"/><c:axId val="20"/>' if kind != "pie" else ""
    axes = (
        '<c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling>'
        '<c:axPos val="b"/><c:crossAx val="20"/></c:catAx><c:valAx><c:axId val="20"/>'
        '<c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="10"/></c:valAx>'
        if kind != "pie" else ""
    )
    return (
        f'<c:chartSpace {CHART_PFX}><c:chart><c:plotArea><c:layout/><c:{chart_kind}>'
        f'{bar_dir}{grouping}<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>{kind.title()} series</c:v></c:tx>'
        f'<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f><c:strCache><c:ptCount val="3"/>{cats}</c:strCache></c:strRef></c:cat>'
        f'<c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f><c:numCache><c:formatCode>0</c:formatCode>'
        f'<c:ptCount val="3"/>{vals}</c:numCache></c:numRef></c:val></c:ser>{axis}'
        f'</c:{chart_kind}>{axes}</c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>'
    )


def content_types(parts: dict[str, bytes]) -> str:
    overrides = []
    types = {
        "ppt/presentation.xml": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
        "ppt/slideMasters/slideMaster1.xml": "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
        "ppt/slideLayouts/slideLayout1.xml": "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
        "ppt/notesMasters/notesMaster1.xml": "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml",
    }
    for name in parts:
        if re.fullmatch(r"ppt/slides/slide\d+\.xml", name):
            types[name] = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
        elif re.fullmatch(r"ppt/notesSlides/notesSlide\d+\.xml", name):
            types[name] = "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"
        elif re.fullmatch(r"ppt/charts/chart\d+\.xml", name):
            types[name] = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
        elif re.fullmatch(r"ppt/diagrams/data\d+\.xml", name):
            types[name] = "application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"
    for name, ctype in types.items():
        overrides.append(f'<Override PartName="/{name}" ContentType="{ctype}"/>')
    return (
        f'<Types xmlns="{CONTENT_TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        f'<Default Extension="xml" ContentType="application/xml"/>{"".join(overrides)}</Types>'
    )


def package_parts(*, deep_group: bool = False) -> dict[str, bytes]:
    parts: dict[str, bytes] = {}
    slides = [f"ppt/slides/slide{i}.xml" for i in range(1, 13)] if not deep_group else ["ppt/slides/slide1.xml"]
    order = [10, 2, 1, 3, 4, 5, 6, 7, 8, 9, 11, 12] if not deep_group else [1]
    # Root/package and presentation relationships.
    parts["_rels/.rels"] = xml_bytes(rels([("rId1", REL_OFFICE, "ppt/presentation.xml")]))
    sld_ids = "".join(f'<p:sldId id="{256+i}" r:id="rId{i}"/>' for i in range(1, len(order)+1))
    parts["ppt/presentation.xml"] = xml_bytes(
        f'<p:presentation {PFX}><p:sldMasterIdLst><p:sldMasterId id="1" r:id="rId99"/></p:sldMasterIdLst>'
        f'<p:sldIdLst>{sld_ids}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="wide"/>'
        '<p:notesSz cx="6858000" cy="9144000"/></p:presentation>'
    )
    pres_rels = [(f"rId{i}", REL_SLIDE, f"slides/slide{slide}.xml") for i, slide in enumerate(order, 1)]
    pres_rels.append(("rId99", f"{R}/slideMaster", "slideMasters/slideMaster1.xml"))
    parts["ppt/_rels/presentation.xml.rels"] = xml_bytes(rels(pres_rels))
    parts["ppt/slideMasters/slideMaster1.xml"] = xml_bytes(
        f'<p:sldMaster {PFX}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/>'
        '<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/>'
        '<p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>'
        '<a:lstStyle/><a:p><a:r><a:t>Master title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>'
        '<p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>'
    )
    parts["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = xml_bytes(rels([("rId1", REL_LAYOUT, "../slideLayouts/slideLayout1.xml")]))
    parts["ppt/slideLayouts/slideLayout1.xml"] = xml_bytes(
        f'<p:sldLayout {PFX} type="title"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/>'
        '<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Inherited title"/>'
        '<p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="250000"/>'
        '<a:ext cx="8000000" cy="600000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>'
        '<a:p><a:r><a:t>Layout title placeholder</a:t></a:r></a:p></p:txBody></p:sp>'
        '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Inherited body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr>'
        '</p:nvSpPr><p:spPr><a:xfrm><a:off x="600000" y="1000000"/><a:ext cx="7500000" cy="3000000"/></a:xfrm></p:spPr>'
        '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Layout body placeholder</a:t></a:r></a:p></p:txBody></p:sp>'
        '</p:spTree></p:cSld>'
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
    )
    parts["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = xml_bytes(rels([("rId1", f"{R}/slideMaster", "../slideMasters/slideMaster1.xml")]))
    parts["ppt/notesMasters/notesMaster1.xml"] = xml_bytes(
        f'<p:notesMaster {PFX}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/>'
        '<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:notesMaster>'
    )

    slide_rels: dict[int, list[tuple[str, str, str]]] = {}
    if deep_group:
        node = shape("Deep leaf", x=25, y=50)
        for depth in range(1000):
            node = group(node, x=1000 + depth, y=2000 + depth,
                         cx=800000-depth, cy=900000-depth,
                         chx=0, chy=0, chcx=1000000, chcy=1000000)
        children = node
    else:
        children_by_slide = {i: shape(f"Slide {i} content", x=100000, y=100000) for i in range(1, 13)}
        # slide2: title, inherited placeholder, two columns, and a tied-coordinate pair.
        children_by_slide[2] = (
            shape("Order and layout fixture", name="Title", placeholder="title", x=0, y=0)
            + shape("Inherited placeholder content", name="Inherited body", placeholder="body", placeholder_idx=1, no_transform=True)
            + shape("Left column", x=100000, y=300000)
            + shape("Right column", x=900000, y=300000)
            + shape("Top row right before lower row left", x=900000, y=250000)
            + shape("Lower row left after top row right", x=100000, y=275000)
            + shape("Tie document order first", x=100000, y=600000)
            + shape("Tie document order second", x=100000, y=600000)
            + table_xml()
            + group(shape("Transformed group child", x=25000, y=50000), x=1000000, y=1200000,
                    cx=400000, cy=300000, chx=0, chy=0, chcx=100000, chcy=100000)
        )
        # SmartArt-like graphicData and chart references are attached to slide10.
        children_by_slide[10] = (
            shape("SmartArt and chart slide", placeholder="ctrTitle", name="Centered title")
            + f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="SmartArt"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
            '<p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData '
            'uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="' + DGM + '" r:dm="rId2"/>'
            '</a:graphicData></a:graphic></p:graphicFrame>'
            + "".join(
                f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="{i+10}" name="{kind} chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
                f'<p:xfrm><a:off x="{i*100}" y="{i*200}"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData uri="{C}">'
                f'<c:chart xmlns:c="{C}" xmlns:r="{R}" r:id="rId{i+2}"/></a:graphicData></a:graphic></p:graphicFrame>'
                for i, kind in enumerate(("bar", "line", "pie"), 1)
            )
        )
        # slide4 is hidden; slide3 has notes with body plus excluded image/number placeholders.
        children_by_slide[4] = shape("This slide is hidden", x=0, y=0)
        for n in (3, 4):
            parts[f"ppt/notesSlides/notesSlide{n}.xml"] = xml_bytes(
                f'<p:notes {PFX}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/>'
                '<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
                + assign_shape_ids(
                    shape("Speaker note body", name="Notes body", placeholder="body", body_text="Speaker note body\nSecond note paragraph")
                    + shape("Must skip slide image", name="Slide image", placeholder="sldImg")
                    + shape("Must skip slide number", name="Page number", placeholder="sldNum")
                )
                + '</p:spTree></p:cSld></p:notes>'
            )
            slide_rels.setdefault(n, []).append(("rId2", REL_NOTES, f"../notesSlides/notesSlide{n}.xml"))
            parts[f"ppt/notesSlides/_rels/notesSlide{n}.xml.rels"] = xml_bytes(rels([
                ("rId1", REL_SLIDE, f"../slides/slide{n}.xml"),
                ("rId2", REL_NOTES_MASTER, "../notesMasters/notesMaster1.xml"),
            ]))
        slide_rels[2] = [("rId1", REL_LAYOUT, "../slideLayouts/slideLayout1.xml")]
        slide_rels[10] = [("rId1", REL_LAYOUT, "../slideLayouts/slideLayout1.xml"),
                          ("rId2", REL_DIAGRAM_DATA, "../diagrams/data1.xml")]
        for i, kind in enumerate(("bar", "line", "pie"), 1):
            rid = f"rId{i+2}"
            slide_rels[10].append((rid, REL_CHART, f"../charts/chart{i}.xml"))
            parts[f"ppt/charts/chart{i}.xml"] = xml_bytes(chart_xml(
                kind,
                [(0, "Alpha"), (2, "Gamma")],
                [(0, "10"), (2, "30")],
            ))
        parts["ppt/diagrams/data1.xml"] = xml_bytes(
            f'<dgm:dataModel xmlns:dgm="{DGM}" xmlns:a="{A}"><dgm:ptLst>'
            '<dgm:pt modelId="1" type="node"><dgm:t><a:p><a:r><a:t>SmartArt node one</a:t></a:r></a:p></dgm:t></dgm:pt>'
            '<dgm:pt modelId="2" type="node"><dgm:t><a:p><a:r><a:t>SmartArt node two</a:t></a:r></a:p></dgm:t></dgm:pt>'
            '</dgm:ptLst><dgm:cxnLst/></dgm:dataModel>'
        )
    for i, slide_name in enumerate(slides, 1):
        slide_num = int(re.search(r"slide(\d+)", slide_name).group(1))
        content = children if deep_group else children_by_slide[slide_num]
        parts[slide_name] = xml_bytes(slide_xml(content, show=(slide_num != 4)))
    if deep_group:
        slide_rels[1] = [("rId1", REL_LAYOUT, "../slideLayouts/slideLayout1.xml")]
    for slide_num in range(1, len(slides) + 1):
        entries = slide_rels.setdefault(slide_num, [])
        if not any(kind == REL_LAYOUT for _, kind, _ in entries):
            entries.insert(0, ("rId1", REL_LAYOUT, "../slideLayouts/slideLayout1.xml"))
    for slide_num, entries in slide_rels.items():
        parts[f"ppt/slides/_rels/slide{slide_num}.xml.rels"] = xml_bytes(rels(entries))
    parts["[Content_Types].xml"] = xml_bytes(content_types(parts))
    return parts


def write_pptx(path: Path, parts: dict[str, bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for name, contents in sorted(parts.items()):
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            zf.writestr(info, contents)


def validate(path: Path, *, deep_group: bool = False) -> dict[str, object]:
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
        assert "[Content_Types].xml" in names
        assert "_rels/.rels" in names
        parts = {n: zf.read(n) for n in names}
        parsed_parts = {}
        for name, data in parts.items():
            if name.endswith((".xml", ".rels")):
                parsed_parts[name] = ET.fromstring(data)
        # Validate OPC relationship targets resolve, including ../ paths.
        relationships_by_source: dict[str, dict[str, ET.Element]] = {}
        for name, data in parts.items():
            if not name.endswith(".rels"):
                continue
            if name == "_rels/.rels":
                source = PurePosixPath("/")
                source_part = None
            else:
                marker = "/_rels/"
                assert marker in name
                folder, relfile = name.split(marker, 1)
                source_file = PurePosixPath(folder) / relfile.removesuffix(".rels")
                source = source_file.parent
                source_part = source_file.as_posix()
            root = ET.fromstring(data)
            source_relationships = root.findall(f"{{{REL_NS}}}Relationship")
            if source_part is not None:
                relationships_by_source[source_part] = {r.attrib["Id"]: r for r in source_relationships}
            for relationship in source_relationships:
                target = relationship.attrib["Target"]
                if relationship.attrib.get("TargetMode") == "External":
                    continue
                if "#" in target:
                    target = target.split("#", 1)[0]
                resolved = posixpath.normpath((source / target).as_posix()).lstrip("/")
                assert resolved in names, (name, target, resolved)
        # Every relationship id used by XML content must exist on that part.
        for name, root in parsed_parts.items():
            if not name.endswith(".xml") or name == "[Content_Types].xml":
                continue
            local_relationships = relationships_by_source.get(name, {})
            for element in root.iter():
                for attr_name, rid in element.attrib.items():
                    if attr_name.startswith(f"{{{R}}}"):
                        assert rid in local_relationships, (name, attr_name, rid)
        # cNvPr ids are unique within each shape tree, including notes and nested groups.
        for name, root in parsed_parts.items():
            if not name.endswith(".xml") or name == "[Content_Types].xml":
                continue
            for tree in root.iter(f"{{{P}}}spTree"):
                shape_ids = [node.attrib["id"] for node in tree.iter(f"{{{P}}}cNvPr")]
                assert len(shape_ids) == len(set(shape_ids)), (name, shape_ids)
        pres = ET.fromstring(parts["ppt/presentation.xml"])
        sld_id_lst = pres.find(f"{{{P}}}sldIdLst")
        pres_rels = ET.fromstring(parts["ppt/_rels/presentation.xml.rels"])
        rel_map = {e.attrib["Id"]: e.attrib["Target"] for e in pres_rels}
        order = [rel_map[e.attrib[f"{{{R}}}id"]] for e in sld_id_lst]
        if deep_group:
            assert len(order) == 1
            xml = parts["ppt/slides/slide1.xml"].decode()
            assert xml.count("<p:grpSp>") == 1000
            assert "Deep leaf" in xml
            feature_report = {"group_depth": 1000, "leaf_present": True}
        else:
            assert len(order) == 12
            expected_order = ["slides/slide10.xml", "slides/slide2.xml", "slides/slide1.xml",
                              "slides/slide3.xml", "slides/slide4.xml", "slides/slide5.xml",
                              "slides/slide6.xml", "slides/slide7.xml", "slides/slide8.xml",
                              "slides/slide9.xml", "slides/slide11.xml", "slides/slide12.xml"]
            assert order == expected_order
            slide10 = parts["ppt/slides/slide10.xml"].decode()
            slide2 = parts["ppt/slides/slide2.xml"].decode()
            assert 'type="title"' in slide2 and 'type="ctrTitle"' in slide10
            # The slide body placeholder (type=body, idx=1) inherits the exact layout transform.
            slide2_root = parsed_parts["ppt/slides/slide2.xml"]
            layout_root = parsed_parts["ppt/slideLayouts/slideLayout1.xml"]
            ph_tag = f"{{{P}}}ph"
            sp_tag = f"{{{P}}}sp"
            slide_body = next(sp for sp in slide2_root.iter(sp_tag)
                              if (ph := sp.find(f".//{ph_tag}")) is not None
                              and ph.attrib.get("type") == "body" and ph.attrib.get("idx") == "1")
            layout_body = next(sp for sp in layout_root.iter(sp_tag)
                               if (ph := sp.find(f".//{ph_tag}")) is not None
                               and ph.attrib.get("type") == "body" and ph.attrib.get("idx") == "1")
            assert slide_body.find(f"{{{P}}}spPr/{{{A}}}xfrm") is None
            assert "Inherited placeholder content" in slide2
            for child_tag in ("off", "ext"):
                assert slide_body.find(f"{{{P}}}spPr/{{{A}}}xfrm/{{{A}}}{child_tag}") is None
                assert slide_body.find(f"{{{P}}}spPr") is not None
                assert layout_body.find(f"{{{P}}}spPr/{{{A}}}xfrm/{{{A}}}{child_tag}") is not None
            inherited_transform = layout_body.find(f"{{{P}}}spPr/{{{A}}}xfrm")
            assert inherited_transform is not None
            assert inherited_transform.find(f"{{{A}}}off").attrib == {"x": "600000", "y": "1000000"}
            assert inherited_transform.find(f"{{{A}}}ext").attrib == {"cx": "7500000", "cy": "3000000"}
            s10_rels = relationships_by_source["ppt/slides/slide10.xml"]
            assert s10_rels["rId2"].attrib["Target"] == "../diagrams/data1.xml"
            assert [s10_rels[f"rId{i}"].attrib["Target"] for i in (3, 4, 5)] == [
                "../charts/chart1.xml", "../charts/chart2.xml", "../charts/chart3.xml"]
            assert "Tie document order first" in slide2 and "Tie document order second" in slide2
            assert "<a:tbl>" in slide2 and "Transformed group child" in slide2
            assert "<a:chOff" in slide2 and "<a:chExt" in slide2
            # Confirm lower y wins over smaller x, then ties preserve document order.
            slide2_shapes = list(slide2_root.iter(sp_tag))
            top_right = next(s for s in slide2_shapes if "Top row right before lower row left" in "".join(s.itertext()))
            lower_left = next(s for s in slide2_shapes if "Lower row left after top row right" in "".join(s.itertext()))
            top_right_off = top_right.find(f"{{{P}}}spPr/{{{A}}}xfrm/{{{A}}}off").attrib
            lower_left_off = lower_left.find(f"{{{P}}}spPr/{{{A}}}xfrm/{{{A}}}off").attrib
            assert int(top_right_off["y"]) < int(lower_left_off["y"])
            assert int(top_right_off["x"]) > int(lower_left_off["x"])
            tied_first = next(i for i, s in enumerate(slide2_shapes) if "Tie document order first" in "".join(s.itertext()))
            tied_second = next(i for i, s in enumerate(slide2_shapes) if "Tie document order second" in "".join(s.itertext()))
            first_off = slide2_shapes[tied_first].find(f"{{{P}}}spPr/{{{A}}}xfrm/{{{A}}}off").attrib
            second_off = slide2_shapes[tied_second].find(f"{{{P}}}spPr/{{{A}}}xfrm/{{{A}}}off").attrib
            assert first_off == second_off == {"x": "100000", "y": "600000"}
            assert tied_first < tied_second
            assert "SmartArt node one" in parts["ppt/diagrams/data1.xml"].decode()
            assert 'show="0"' in parts["ppt/slides/slide4.xml"].decode()
            notes = parts["ppt/notesSlides/notesSlide3.xml"].decode()
            assert "Speaker note body" in notes and "Must skip slide image" in notes and "Must skip slide number" in notes
            notes_rels = relationships_by_source["ppt/notesSlides/notesSlide3.xml"]
            assert notes_rels["rId1"].attrib["Type"] == REL_SLIDE
            assert notes_rels["rId1"].attrib["Target"] == "../slides/slide3.xml"
            assert notes_rels["rId2"].attrib["Type"] == REL_NOTES_MASTER
            assert notes_rels["rId2"].attrib["Target"] == "../notesMasters/notesMaster1.xml"
            for i in range(1, 4):
                chart_root = parsed_parts[f"ppt/charts/chart{i}.xml"]
                chart = parts[f"ppt/charts/chart{i}.xml"].decode()
                plot_area = chart_root.find(f".//{{{C}}}plotArea")
                assert plot_area is not None
                series = plot_area.find(f".//{{{C}}}ser")
                assert series is not None
                for cache_tag, formula_tag in (("strCache", "strRef"), ("numCache", "numRef")):
                    cache = series.find(f".//{{{C}}}{cache_tag}")
                    formula_ref = series.find(f".//{{{C}}}{formula_tag}")
                    assert cache is not None and formula_ref is not None
                    formula = formula_ref.find(f"{{{C}}}f")
                    point_count = cache.find(f"{{{C}}}ptCount")
                    assert formula is not None and point_count is not None
                    match = re.search(r"!\$[A-Z]+\$(\d+):\$[A-Z]+\$(\d+)", formula.text or "")
                    assert match is not None
                    range_count = int(match.group(2)) - int(match.group(1)) + 1
                    assert int(point_count.attrib["val"]) == range_count == 3
                    point_indexes = [int(point.attrib["idx"]) for point in cache.findall(f"{{{C}}}pt")]
                    assert point_indexes == [0, 2]
                    assert len(point_indexes) == len(set(point_indexes))
                    assert all(0 <= index < range_count for index in point_indexes)
                bar_chart = plot_area.find(f"{{{C}}}barChart")
                line_chart = plot_area.find(f"{{{C}}}lineChart")
                pie_chart = plot_area.find(f"{{{C}}}pieChart")
                if i == 1:
                    assert bar_chart is not None
                    assert bar_chart.find(f"{{{C}}}barDir") is not None
                    assert bar_chart.find(f"{{{C}}}catAx") is None
                    assert plot_area.find(f"{{{C}}}catAx") is not None
                    assert plot_area.find(f"{{{C}}}valAx") is not None
                elif i == 2:
                    assert line_chart is not None
                    assert line_chart.find(f"{{{C}}}catAx") is None
                    assert plot_area.find(f"{{{C}}}catAx") is not None
                    assert plot_area.find(f"{{{C}}}valAx") is not None
                else:
                    assert pie_chart is not None
            feature_report = {"slides": 12, "relationship_order": order,
                              "chart_types": ["bar", "line", "pie"], "noncontiguous_cache_indexes": [0, 2]}
    feature_report["zip_members"] = len(names)
    feature_report["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    return feature_report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", type=Path, default=ROOT)
    parser.add_argument("--check", action="store_true", help="build to memory and compare committed fixtures")
    args = parser.parse_args()
    specs = [
        ("pptx-edge-cases.pptx", package_parts(), False),
        ("pptx-deep-group-1000.pptx", package_parts(deep_group=True), True),
    ]
    reports = {}
    for filename, parts, deep in specs:
        path = args.out_dir / filename
        if args.check:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
                for name, contents in sorted(parts.items()):
                    info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = 0o100644 << 16
                    zf.writestr(info, contents)
            expected = buf.getvalue()
            actual = path.read_bytes()
            assert actual == expected, f"{filename}: bytes differ from deterministic regeneration"
        else:
            write_pptx(path, parts)
        reports[filename] = validate(path, deep_group=deep)
    print(json.dumps(reports, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
