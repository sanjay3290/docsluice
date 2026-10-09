"""Generate original, deterministic image parser fixtures using only Python's stdlib."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path


DATE = b"2019:04:05 12:34:56\0"
MAKE = b"SyntheticCo\0"
MODEL = b"Unit Camera\0"


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def tiny_png() -> bytes:
    # One opaque RGB pixel: filter byte followed by RGB samples.
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", zlib.compress(b"\0\x23\x45\x67", 9)) + png_chunk(b"IEND", b"")


def tiny_gif() -> bytes:
    # GIF89a, 1x1, a two-entry global table and a 1x1 image block.
    # LZW codes are clear(4), palette-index(0), end(5), packed least-significant bit first.
    return (b"GIF89a" + struct.pack("<HHBBB", 1, 1, 0x80, 0, 0) +
            b"\x00\x00\x00\xff\xff\xff" + b"\x2c" + struct.pack("<HHHHB", 0, 0, 1, 1, 0) +
            b"\x02\x02\x44\x01\x00\x3b")


def tiff(endian: str) -> bytes:
    """Build a small classic TIFF with sorted IFDs and out-of-line ASCII/rationals."""
    order = "<" if endian == "II" else ">"
    pack_h = lambda n: struct.pack(order + "H", n)
    pack_i = lambda n: struct.pack(order + "I", n)
    # Fixed layout: header; IFD0 (7 entries); ExifIFD (1); GPS IFD (5); values.
    ifd0 = 8
    exif = ifd0 + 2 + 7 * 12 + 4
    gps_ifd = exif + 2 + 1 * 12 + 4
    data_start = gps_ifd + 2 + 5 * 12 + 4
    make_offset = data_start
    model_offset = make_offset + len(MAKE)
    date_offset = model_offset + len(MODEL)
    gps_values_offset = date_offset + len(DATE)
    entries: list[bytes] = []

    def entry(tag: int, typ: int, count: int, value: int | bytes) -> bytes:
        body = value if isinstance(value, bytes) else pack_i(value)
        return pack_h(tag) + pack_h(typ) + pack_i(count) + body.ljust(4, b"\0")[:4]

    entries.extend([
        entry(256, 4, 1, 3), entry(257, 4, 1, 2), entry(271, 2, len(MAKE), make_offset),
        entry(272, 2, len(MODEL), model_offset), entry(274, 3, 1, pack_h(6)),
        entry(34665, 4, 1, exif), entry(34853, 4, 1, gps_ifd),
    ])
    out = bytearray((b"II" if endian == "II" else b"MM") + pack_h(42) + pack_i(ifd0))
    out += pack_h(len(entries)) + b"".join(entries) + pack_i(0)
    out += pack_h(1) + entry(36867, 2, len(DATE), date_offset) + pack_i(0)
    # GPSVersionID, latitude reference + three rationals, longitude ref + three rationals.
    gps_entries = [entry(0, 1, 4, bytes((2, 3, 0, 0))),
                   entry(1, 2, 2, b"N\0\0\0"), entry(2, 5, 3, gps_values_offset),
                   entry(3, 2, 2, b"W\0\0\0"), entry(4, 5, 3, gps_values_offset + 24)]
    out += pack_h(len(gps_entries)) + b"".join(gps_entries) + pack_i(0)
    out += MAKE + MODEL + DATE
    for value in (1, 1, 2, 1, 3, 1, 4, 1, 5, 1, 6, 1):
        out += pack_i(value)
    assert len(out) == gps_values_offset + 48
    return bytes(out)


def jpeg_structure() -> bytes:
    exif = b"Exif\0\0" + tiff("II")
    app1 = b"\xff\xe1" + struct.pack(">H", len(exif) + 2) + exif
    # SOF0 header describes 5x3 RGB; deliberately no SOS or entropy-coded scan.
    sof_payload = bytes((8,)) + struct.pack(">HH", 3, 5) + bytes((3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0))
    sof = b"\xff\xc0" + struct.pack(">H", len(sof_payload) + 2) + sof_payload
    return b"\xff\xd8" + app1 + sof


def riff_chunk(kind: bytes, payload: bytes) -> bytes:
    data = kind + struct.pack("<I", len(payload)) + payload
    return data + (b"\0" if len(payload) & 1 else b"")


def webp(chunks: list[tuple[bytes, bytes]]) -> bytes:
    body = b"WEBP" + b"".join(riff_chunk(kind, payload) for kind, payload in chunks)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def webp_vp8() -> bytes:
    # Frame header fields only: enough for structural dimension extraction, not full VP8 coding.
    payload = b"\x00\x00\x00\x9d\x01\x2a" + struct.pack("<HH", 5, 3)
    return webp([(b"VP8 ", payload)])


def webp_vp8l() -> bytes:
    # VP8L signature and packed 14-bit dimensions (5x3); entropy data is omitted.
    bits = (5 - 1) | ((3 - 1) << 14)
    payload = b"\x2f" + struct.pack("<I", bits)
    return webp([(b"VP8L", payload)])


def webp_vp8x_exif() -> bytes:
    # VP8X sets the Exif flag and a 5x3 canvas; VP8L header and Exif TIFF follow.
    vp8x = bytes((0x08, 0, 0, 0)) + (4).to_bytes(3, "little") + (2).to_bytes(3, "little")
    bits = (5 - 1) | ((3 - 1) << 14)
    return webp([(b"VP8X", vp8x), (b"VP8L", b"\x2f" + struct.pack("<I", bits)), (b"EXIF", tiff("II"))])


def hostile_tiff_cycle() -> bytes:
    # Header points to IFD at 8; the zero-entry IFD's next-IFD pointer points back to 8.
    return b"II" + struct.pack("<HIH", 42, 8, 0) + struct.pack("<I", 8)


def hostile_tiff_huge_count() -> bytes:
    # A count of 65535 with no corresponding 12-byte entries.
    return b"II" + struct.pack("<HIH", 42, 8, 0xFFFF)


def hostile_tiff_truncated_value() -> bytes:
    # Make is ASCII[10], but its external value begins two bytes before EOF.
    head = b"II" + struct.pack("<HI", 42, 8)
    entry = struct.pack("<HHI", 271, 2, 10) + struct.pack("<I", 26)
    return head + struct.pack("<H", 1) + entry + struct.pack("<I", 0) + b"xx"


FILES: dict[str, tuple[bytes, str, dict[str, object]]] = {
    "tiny.png": (tiny_png(), "complete 1x1 RGB PNG with valid zlib stream and chunk CRCs", {"width": 1, "height": 1}),
    "tiny.gif": (tiny_gif(), "complete 1x1 GIF89a with a two-color global table", {"width": 1, "height": 1}),
    "tiff-le-metadata.tif": (tiff("II"), "classic TIFF metadata structure snippet, little-endian, with synthetic EXIF and GPS IFDs; no pixel strip", {"kind": "tiff-metadata-structure-snippet", "completeImage": False, "width": 3, "height": 2, "dateTimeOriginal": "2019:04:05 12:34:56", "orientation": 6, "make": "SyntheticCo", "model": "Unit Camera", "gps": {"latitudeDms": [1, 2, 3], "latitudeReference": "N", "longitudeDms": [4, 5, 6], "longitudeReference": "W"}}),
    "tiff-be-metadata.tif": (tiff("MM"), "classic TIFF metadata structure snippet, big-endian, with synthetic EXIF and GPS IFDs; no pixel strip", {"kind": "tiff-metadata-structure-snippet", "completeImage": False, "width": 3, "height": 2, "dateTimeOriginal": "2019:04:05 12:34:56", "orientation": 6, "make": "SyntheticCo", "model": "Unit Camera", "gps": {"latitudeDms": [1, 2, 3], "latitudeReference": "N", "longitudeDms": [4, 5, 6], "longitudeReference": "W"}}),
    "jpeg-exif-structure.jpg": (jpeg_structure(), "JPEG SOI + APP1 Exif + SOF0 structure only; no SOS or image scan", {"kind": "jpeg-marker-structure-snippet", "width": 5, "height": 3, "dateTimeOriginal": "2019:04:05 12:34:56"}),
    "webp-vp8-snippet.webp": (webp_vp8(), "RIFF/WEBP with VP8 frame header only; not a decodable image", {"kind": "webp-vp8-structure-snippet", "width": 5, "height": 3}),
    "webp-vp8l-snippet.webp": (webp_vp8l(), "RIFF/WEBP with VP8L image header only; entropy stream omitted", {"kind": "webp-vp8l-structure-snippet", "width": 5, "height": 3}),
    "webp-vp8x-exif-snippet.webp": (webp_vp8x_exif(), "RIFF/WEBP VP8X + VP8L header + EXIF chunk; image entropy stream omitted", {"kind": "webp-vp8x-exif-structure-snippet", "width": 5, "height": 3, "dateTimeOriginal": "2019:04:05 12:34:56"}),
    "hostile/tiff-cyclic-ifd.tif": (hostile_tiff_cycle(), "malformed TIFF whose next-IFD pointer cycles to IFD0", {"kind": "hostile", "scenario": "cyclic-ifd"}),
    "hostile/tiff-huge-count.tif": (hostile_tiff_huge_count(), "malformed TIFF with 65535 claimed entries and no entry bytes", {"kind": "hostile", "scenario": "huge-ifd-count"}),
    "hostile/tiff-truncated-value-offset.tif": (hostile_tiff_truncated_value(), "malformed TIFF ASCII value extending beyond EOF", {"kind": "hostile", "scenario": "truncated-value-offset"}),
}


def write_fixtures(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for relative, (content, description, _metadata) in FILES.items():
        path = destination / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        path.with_name(path.name + ".license").write_text(
            "SPDX-License-Identifier: CC0-1.0\n"
            "Source: original synthetic bytes generated by generate_fixtures.py in this directory.\n"
            f"Notes: {description}. No third-party image or code was copied.\n",
            encoding="utf-8",
        )


if __name__ == "__main__":
    write_fixtures(Path(__file__).resolve().parent / "fixtures")
