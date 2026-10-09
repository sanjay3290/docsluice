"""Independent structural and determinism checks for generated image samples."""

from __future__ import annotations

import hashlib
import json
import struct
import tempfile
import unittest
import zlib
from pathlib import Path

import generate_fixtures


HERE = Path(__file__).resolve().parent
DATA = HERE / "fixtures"
EXPECTED = json.loads((HERE / "expected-metadata.json").read_text())


def png_chunks(data: bytes) -> list[tuple[bytes, bytes]]:
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    chunks = []
    pos = 8
    while pos < len(data):
        length = struct.unpack_from(">I", data, pos)[0]
        tag = data[pos + 4 : pos + 8]
        payload = data[pos + 8 : pos + 8 + length]
        crc = struct.unpack_from(">I", data, pos + 8 + length)[0]
        assert crc == zlib.crc32(tag + payload) & 0xFFFFFFFF
        chunks.append((tag, payload))
        pos += 12 + length
    assert pos == len(data)
    return chunks


def riff_chunks(data: bytes) -> list[tuple[bytes, bytes]]:
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    assert struct.unpack_from("<I", data, 4)[0] == len(data) - 8
    chunks = []
    pos = 12
    while pos < len(data):
        tag = data[pos : pos + 4]
        length = struct.unpack_from("<I", data, pos + 4)[0]
        start = pos + 8
        payload = data[start : start + length]
        assert len(payload) == length
        chunks.append((tag, payload))
        pos = start + length + (length & 1)
    assert pos == len(data)
    return chunks


def tiff_ifd(data: bytes, offset: int) -> dict[int, tuple[int, int, int]]:
    endian = "<" if data[:2] == b"II" else ">"
    count = struct.unpack_from(endian + "H", data, offset)[0]
    result = {}
    for index in range(count):
        pos = offset + 2 + index * 12
        tag, typ, n = struct.unpack_from(endian + "HHI", data, pos)
        value = struct.unpack_from(endian + "I", data, pos + 8)[0]
        result[tag] = (typ, n, value)
    return result


def tiff_value(data: bytes, entry: tuple[int, int, int]) -> bytes:
    typ, count, value = entry
    unit = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8}[typ]
    size = unit * count
    if size <= 4:
        endian = "<" if data[:2] == b"II" else ">"
        return struct.pack(endian + "I", value)[:size]
    return data[value : value + size]


def tiff_rationals(data: bytes, entry: tuple[int, int, int]) -> list[tuple[int, int]]:
    typ, count, offset = entry
    assert typ == 5
    endian = "<" if data[:2] == b"II" else ">"
    return [struct.unpack_from(endian + "II", data, offset + index * 8) for index in range(count)]


class FixtureTests(unittest.TestCase):
    def test_png_and_gif_are_small_complete_images(self) -> None:
        chunks = png_chunks((DATA / "tiny.png").read_bytes())
        self.assertEqual([tag for tag, _ in chunks], [b"IHDR", b"IDAT", b"IEND"])
        self.assertEqual(struct.unpack(">II", chunks[0][1][:8]), (1, 1))
        self.assertEqual(zlib.decompress(chunks[1][1]), b"\x00\x23\x45\x67")
        gif = (DATA / "tiny.gif").read_bytes()
        self.assertTrue(gif.startswith((b"GIF87a", b"GIF89a")))
        self.assertEqual(gif[-1], 0x3B)
        self.assertIn(b"\x2c", gif)

    def test_tiff_endianness_and_metadata_fields(self) -> None:
        for name, endian in (("tiff-le-metadata.tif", "<"), ("tiff-be-metadata.tif", ">")):
            data = (DATA / name).read_bytes()
            self.assertEqual(data[:2], b"II" if endian == "<" else b"MM")
            self.assertEqual(struct.unpack_from(endian + "H", data, 2)[0], 42)
            first = struct.unpack_from(endian + "I", data, 4)[0]
            count = struct.unpack_from(endian + "H", data, first)[0]
            tags = {struct.unpack_from(endian + "H", data, first + 2 + n * 12)[0] for n in range(count)}
            self.assertTrue({256, 257, 271, 272, 274, 34665, 34853}.issubset(tags))
            primary = tiff_ifd(data, first)
            expected = EXPECTED["fixtures"][name]
            self.assertEqual(expected["kind"], "tiff-metadata-structure-snippet")
            self.assertFalse(expected["completeImage"])
            self.assertEqual(tiff_value(data, primary[256]), struct.pack(endian + "I", expected["width"]))
            self.assertEqual(tiff_value(data, primary[257]), struct.pack(endian + "I", expected["height"]))
            self.assertEqual(tiff_value(data, primary[274]), struct.pack(endian + "H", expected["orientation"]))
            self.assertEqual(tiff_value(data, primary[271]).rstrip(b"\0").decode(), expected["make"])
            self.assertEqual(tiff_value(data, primary[272]).rstrip(b"\0").decode(), expected["model"])
            exif = tiff_ifd(data, primary[34665][2])
            self.assertEqual(tiff_value(data, exif[36867]).rstrip(b"\0").decode(), expected["dateTimeOriginal"])
            gps = tiff_ifd(data, primary[34853][2])
            gps_expected = expected["gps"]
            self.assertEqual(tiff_value(data, gps[1]).rstrip(b"\0").decode(), gps_expected["latitudeReference"])
            self.assertEqual(tiff_value(data, gps[3]).rstrip(b"\0").decode(), gps_expected["longitudeReference"])
            latitude = [num // den for num, den in tiff_rationals(data, gps[2])]
            longitude = [num // den for num, den in tiff_rationals(data, gps[4])]
            self.assertEqual(latitude, gps_expected["latitudeDms"])
            self.assertEqual(longitude, gps_expected["longitudeDms"])

    def test_jpeg_is_labeled_as_metadata_structure_not_complete_photo(self) -> None:
        data = (DATA / "jpeg-exif-structure.jpg").read_bytes()
        self.assertEqual(data[:2], b"\xff\xd8")
        self.assertIn(b"Exif\x00\x00", data)
        self.assertNotIn(b"\xff\xda", data)
        expected = EXPECTED["fixtures"]["jpeg-exif-structure.jpg"]
        self.assertEqual(expected["kind"], "jpeg-marker-structure-snippet")
        sof_offset = data.index(b"\xff\xc0")
        height, width = struct.unpack_from(">HH", data, sof_offset + 5)
        self.assertEqual((width, height), (expected["width"], expected["height"]))
        exif_data = data[data.index(b"Exif\x00\x00") + 6 :]
        primary = tiff_ifd(exif_data, struct.unpack_from("<I", exif_data, 4)[0])
        nested = tiff_ifd(exif_data, primary[34665][2])
        self.assertEqual(tiff_value(exif_data, nested[36867]).rstrip(b"\0").decode(), expected["dateTimeOriginal"])

    def test_webp_chunk_headers_and_exif_flag(self) -> None:
        vp8 = riff_chunks((DATA / "webp-vp8-snippet.webp").read_bytes())
        vp8l = riff_chunks((DATA / "webp-vp8l-snippet.webp").read_bytes())
        exif = riff_chunks((DATA / "webp-vp8x-exif-snippet.webp").read_bytes())
        self.assertEqual(vp8[0][0], b"VP8 ")
        self.assertEqual(vp8l[0][0], b"VP8L")
        self.assertEqual(exif[0][0], b"VP8X")
        self.assertTrue(exif[0][1][0] & 0x08)
        self.assertEqual([tag for tag, _ in exif], [b"VP8X", b"VP8L", b"EXIF"])
        exif_ifd_data = exif[2][1]
        primary = tiff_ifd(exif_ifd_data, struct.unpack_from("<I", exif_ifd_data, 4)[0])
        nested = tiff_ifd(exif_ifd_data, primary[34665][2])
        self.assertEqual(tiff_value(exif_ifd_data, nested[36867]).rstrip(b"\0").decode(), EXPECTED["fixtures"]["webp-vp8x-exif-snippet.webp"]["dateTimeOriginal"])

    def test_hostile_tiff_shapes_are_intentional(self) -> None:
        cycle = (DATA / "hostile" / "tiff-cyclic-ifd.tif").read_bytes()
        count = struct.unpack_from("<H", cycle, 8)[0]
        next_offset = struct.unpack_from("<I", cycle, 10 + count * 12)[0]
        self.assertEqual(next_offset, 8)
        huge = (DATA / "hostile" / "tiff-huge-count.tif").read_bytes()
        self.assertEqual(struct.unpack_from("<H", huge, 8)[0], 0xFFFF)
        trunc = (DATA / "hostile" / "tiff-truncated-value-offset.tif").read_bytes()
        declared_count = struct.unpack_from("<I", trunc, 10 + 4)[0]
        value_offset = struct.unpack_from("<I", trunc, 10 + 8)[0]
        self.assertGreater(value_offset + declared_count, len(trunc))
        self.assertLess(struct.unpack_from("<I", trunc, 10 + 8)[0], len(trunc))
        self.assertGreater(struct.unpack_from("<I", trunc, 10 + 8)[0], len(trunc) - 4)

    def test_generator_is_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "fixtures"
            generate_fixtures.write_fixtures(target)
            first = {p.relative_to(target).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in target.rglob("*") if p.is_file()}
            generate_fixtures.write_fixtures(target)
            second = {p.relative_to(target).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in target.rglob("*") if p.is_file()}
            self.assertEqual(first, second)
            self.assertEqual(first, EXPECTED["sha256"])


if __name__ == "__main__":
    unittest.main()
