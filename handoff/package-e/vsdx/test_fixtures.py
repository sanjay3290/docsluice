"""Standard-library structural tests for the original VSDX fixture corpus."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

import generate_fixtures as gen


ROOT = Path(__file__).resolve().parent
CORE = gen.CORE
PKG_REL = gen.PKG_REL
NS = {"v": CORE, "r": gen.REL, "p": PKG_REL}


def xml_member(archive: zipfile.ZipFile, name: str) -> ET.Element:
    return ET.fromstring(archive.read(name))


class FixtureStructureTests(unittest.TestCase):
    def test_baseline_zip_integrity_and_required_parts(self) -> None:
        with zipfile.ZipFile(ROOT / "tiny-flow.vsdx") as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(
                archive.namelist(),
                [
                    "[Content_Types].xml", "_rels/.rels", "visio/document.xml",
                    "visio/_rels/document.xml.rels", "visio/pages/pages.xml",
                    "visio/pages/_rels/pages.xml.rels", "visio/pages/page1.xml",
                    "visio/pages/page2.xml",
                ],
            )
            self.assertEqual(archive.getinfo("visio/pages/pages.xml").date_time, (1980, 1, 1, 0, 0, 0))
            self.assertEqual(xml_member(archive, "visio/document.xml").tag, f"{{{CORE}}}VisioDocument")
            self.assertEqual(xml_member(archive, "visio/pages/pages.xml").tag, f"{{{CORE}}}Pages")

    def test_pages_order_resolves_through_relationships_not_zip_order(self) -> None:
        with zipfile.ZipFile(ROOT / "tiny-flow.vsdx") as archive:
            pages = xml_member(archive, "visio/pages/pages.xml")
            rels = xml_member(archive, "visio/pages/_rels/pages.xml.rels")
            targets = {r.attrib["Id"]: r.attrib["Target"] for r in rels.findall("p:Relationship", NS)}
            resolved = []
            for page in pages.findall("v:Page", NS):
                rid = page.find("v:Rel", NS).attrib[f"{{{gen.REL}}}id"]
                resolved.append((page.attrib["Name"], targets[rid]))
            self.assertEqual(resolved, [("01 — Opening", "page2.xml"), ("02 — Review", "page1.xml")])

    def test_nested_shapes_multiline_unicode_and_connector_facts(self) -> None:
        with zipfile.ZipFile(ROOT / "tiny-flow.vsdx") as archive:
            opening = xml_member(archive, "visio/pages/page2.xml")
            texts = [node.text for node in opening.findall(".//v:Text", NS)]
            self.assertIn("Start\nCafé Δ — 終わり & continue", texts)
            self.assertIn("Nested\nline", texts)
            self.assertEqual(opening.find(".//v:Shape[@ID='5']/v:Shapes/v:Shape[@ID='6']/v:Text", NS).text, "Grouped child α")
            empty = opening.find(".//v:Shape[@ID='8']", NS)
            self.assertIsNotNone(empty)
            self.assertIsNone(empty.find("v:Text", NS))
            connects = opening.findall(".//v:Connects/v:Connect", NS)
            self.assertEqual(len(connects), 2)

    def test_missing_relationship_and_traversal_are_explicit_inputs(self) -> None:
        with zipfile.ZipFile(ROOT / "missing-relationship.vsdx") as archive:
            ids = {r.attrib["Id"] for r in xml_member(archive, "visio/pages/_rels/pages.xml.rels").findall("p:Relationship", NS)}
            self.assertNotIn("rIdOpen", ids)
        with zipfile.ZipFile(ROOT / "traversal-part.vsdx") as archive:
            rels = xml_member(archive, "visio/pages/_rels/pages.xml.rels")
            target = next(r.attrib["Target"] for r in rels.findall("p:Relationship", NS) if r.attrib["Id"] == "rIdOpen")
            self.assertEqual(target, "../../../../outside.xml")
            self.assertNotIn("outside.xml", archive.namelist())

    def test_duplicate_id_and_bounded_malformed_xml_are_present(self) -> None:
        with zipfile.ZipFile(ROOT / "duplicate-id.vsdx") as archive:
            opening = xml_member(archive, "visio/pages/page2.xml")
            ids = [shape.attrib["ID"] for shape in opening.findall(".//v:Shapes/v:Shape", NS)]
            self.assertGreater(ids.count("4"), 1)
        with zipfile.ZipFile(ROOT / "bounded-malformed.vsdx") as archive:
            with self.assertRaises(ET.ParseError):
                xml_member(archive, "visio/pages/page1.xml")

    def test_hostile_entity_candidate_is_inspected_as_bytes_only(self) -> None:
        with zipfile.ZipFile(ROOT / "xml-hostile-candidate.vsdx") as archive:
            raw = archive.read("visio/pages/page2.xml")
            self.assertIn(b"<!DOCTYPE", raw)
            self.assertIn(b"SYSTEM \"file:///etc/passwd\"", raw)
            self.assertIn(b"&leak;", raw)

    def test_hash_index_matches_zip_members_and_archives(self) -> None:
        index = json.loads((ROOT / "member-hashes.json").read_text(encoding="utf-8"))
        for filename, expected in index.items():
            path = ROOT / filename
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), expected["archiveSha256"])
            with zipfile.ZipFile(path) as archive:
                actual = {name: hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist()}
            self.assertEqual(actual, expected["members"])

    def test_regeneration_is_byte_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            out = Path(td)
            gen.make_fixtures(out)
            generated_names = set(json.loads((ROOT / "member-hashes.json").read_text(encoding="utf-8")))
            generated_names.update(f"{name}.license" for name in tuple(generated_names))
            generated_names.update({"member-hashes.json", "expected-source-facts.json"})
            for name in sorted(generated_names):
                self.assertEqual((out / name).read_bytes(), (ROOT / name).read_bytes(), name)


if __name__ == "__main__":
    unittest.main()
