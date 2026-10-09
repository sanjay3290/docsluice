"""Structural tests for the independent archive fixture generator."""

import gzip
import io
import json
import pathlib
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
import zlib


ROOT = pathlib.Path(__file__).parent
GENERATOR = ROOT / "generate_fixtures.py"


class ArchiveFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.output = pathlib.Path(cls.tmp.name) / "fixtures"
        subprocess.run(
            [sys.executable, str(GENERATOR), "--output", str(cls.output)],
            check=True,
        )

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def fixture(self, name):
        return self.output / name

    def test_all_fixtures_are_below_cap_and_have_cc0_provenance(self):
        manifest = json.loads((self.output / "fixtures.json").read_text())
        self.assertTrue(manifest["verification"]["extraction_verified"] is False)
        self.assertTrue(manifest["verification"]["reader_acceptance_verified"] is False)
        self.assertGreaterEqual(len(manifest["fixtures"]), 10)
        for item in manifest["fixtures"]:
            path = self.fixture(item["file"])
            self.assertLess(path.stat().st_size, 15 * 1024 * 1024)
            license_text = pathlib.Path(str(path) + ".license").read_text()
            self.assertIn("SPDX-License-Identifier: CC0-1.0", license_text)
            self.assertIn("Source: original synthetic fixture", license_text)

    def test_generation_is_byte_deterministic(self):
        second = pathlib.Path(self.tmp.name) / "second"
        subprocess.run([sys.executable, str(GENERATOR), "--output", str(second)], check=True, capture_output=True)
        first_manifest = json.loads((self.output / "fixtures.json").read_text())
        second_manifest = json.loads((second / "fixtures.json").read_text())
        self.assertEqual(first_manifest, second_manifest)
        for item in first_manifest["fixtures"]:
            self.assertEqual((self.output / item["file"]).read_bytes(), (second / item["file"]).read_bytes())

    def test_mixed_zip_preserves_order_and_contains_required_entries(self):
        with zipfile.ZipFile(self.fixture("zip-mixed.zip")) as archive:
            names = archive.namelist()
            self.assertEqual(
                names,
                ["data.csv", "page.html", "nested/inside.zip", "pixel.png", "folder/"],
            )
            self.assertEqual(archive.read("data.csv"), b"name,value\nalpha,1\n")
            self.assertIn(b"<title>Fixture</title>", archive.read("page.html"))
            self.assertEqual(zipfile.ZipFile(io.BytesIO(archive.read("nested/inside.zip"))).namelist(), ["nested.txt"])
            png = archive.read("pixel.png")
            self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual(struct.unpack(">II", png[16:24]), (1, 1))
            idat = png[41:-16]
            self.assertEqual(zlib.decompress(idat), b"\x00\x20\x60\xa0\xff")

    def test_zip_security_and_scale_shapes(self):
        with zipfile.ZipFile(self.fixture("zip-hostile-names.zip")) as archive:
            self.assertEqual(archive.namelist(), ["../../etc/passwd", "__MACOSX/._x", ".DS_Store", "Thumbs.db"])
        with zipfile.ZipFile(self.fixture("zip-10000-empty.zip")) as archive:
            self.assertEqual(len(archive.infolist()), 10000)
        with zipfile.ZipFile(self.fixture("zip-nested-amplification.zip")) as archive:
            child = archive.read("level-1.zip")
        for expected_name in ("level-1.zip", "level-2.zip", "level-3.zip", "payload.txt"):
            with zipfile.ZipFile(io.BytesIO(child)) as archive:
                self.assertEqual(archive.namelist(), [expected_name])
                child = archive.read(expected_name)
        self.assertEqual(len(child), 512 * 1024)

    def test_gzip_single_multi_member_and_optional_header_cases(self):
        self.assertEqual(gzip.decompress(self.fixture("gzip-csv.gz").read_bytes()), b"id,total\n1,9\n")
        self.assertEqual(gzip.decompress(self.fixture("gzip-multi-member.gz").read_bytes()), b"first\nsecond\n")
        optional = self.fixture("gzip-optional-header.gz").read_bytes()
        self.assertEqual(optional[3] & 0x1E, 0x1E)
        self.assertEqual(gzip.decompress(optional), b"optional header\n")
        bomb = self.fixture("gzip-bounded-amplification.gz").read_bytes()
        expanded = gzip.decompress(bomb)
        self.assertEqual(len(expanded), 512 * 1024)
        self.assertLess(len(bomb), 20 * 1024)

    def test_tar_variants_and_malformed_structures(self):
        with tarfile_open(self.fixture("tar-variants.tar")) as archive:
            members = archive.getmembers()
            names = [member.name for member in members]
            self.assertIn("folder/subfolder/data.csv", names)
            self.assertTrue(any(member.issym() for member in members))
            data = archive.extractfile("folder/subfolder/data.csv").read()
            self.assertEqual(data, b"k,v\na,2\n")

        with tarfile_open(self.fixture("tar-pax-long-path.tar")) as archive:
            self.assertEqual(archive.getmembers()[0].name, "pax/" + "p" * 65_536)
        with tarfile_open(self.fixture("tar-gnu-long-name.tar")) as archive:
            self.assertEqual(archive.getmembers()[0].name, "gnu/" + "g" * 180)

        bad_checksum = self.fixture("tar-bad-checksum.tar").read_bytes()
        bad_checksum_header = bytearray(bad_checksum[:512])
        stored_bad_checksum = int(bad_checksum_header[148:156].strip(b" \0"), 8)
        bad_checksum_header[148:156] = b" " * 8
        self.assertNotEqual(sum(bad_checksum_header), stored_bad_checksum)
        lied = self.fixture("tar-size-lie.tar").read_bytes()
        self.assertEqual(int(lied[124:136].strip(b" \0"), 8), 1_000_000)
        self.assertLess(len(lied), 2048)
        self.assert_valid_tar_checksum(lied)
        pax_lie = self.fixture("tar-pax-size-lie.tar").read_bytes()
        self.assertEqual(pax_lie[156:157], b"x")
        self.assertEqual(int(pax_lie[124:136].strip(b" \0"), 8), 1_000_000)
        self.assertEqual(pax_lie[512:], b"10 path=x\n")
        self.assertLess(len(pax_lie), 1024)
        self.assert_valid_tar_checksum(pax_lie)
        pax = self.fixture("tar-pax-long-path.tar").read_bytes()
        self.assertIn(b"path=", pax)
        self.assertIn(b"p" * 65536, pax)

        with tarfile_open_gzip(self.fixture("tar-gzip.tar.gz")) as archive:
            self.assertEqual(archive.extractfile("folder/subfolder/data.csv").read(), b"k,v\na,2\n")

    def assert_valid_tar_checksum(self, data):
        header = bytearray(data[:512])
        stored = int(header[148:156].strip(b" \0"), 8)
        header[148:156] = b" " * 8
        self.assertEqual(sum(header), stored)


def tarfile_open(path):
    import tarfile

    return tarfile.open(path, "r:")


def tarfile_open_gzip(path):
    import tarfile

    return tarfile.open(path, "r:gz")


if __name__ == "__main__":
    unittest.main()
