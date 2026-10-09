#!/usr/bin/env python3
"""Generate original, deterministic ZIP/GZIP/TAR fixtures with Python stdlib only."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import pathlib
import struct
import tarfile
import zlib
import zipfile


CAP_BYTES = 15 * 1024 * 1024
FIXED_TIME = (2020, 1, 2, 3, 4, 6)
CSV = b"name,value\nalpha,1\n"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png_1x1() -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))

    raw = b"\x00\x20\x60\xa0\xff"  # filter byte, then one RGBA pixel
    return PNG_SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def zip_bytes(entries: list[tuple[str, bytes]], *, compression=zipfile.ZIP_DEFLATED) -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=compression, compresslevel=9) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = compression
            info.create_system = 3
            info.external_attr = (0o40755 << 16) if name.endswith("/") else (0o100644 << 16)
            archive.writestr(info, data)
    return stream.getvalue()


def gzip_optional_header(data: bytes) -> bytes:
    header = bytearray(b"\x1f\x8b\x08\x1e" + b"\0\0\0\0" + b"\0\xff")
    header += struct.pack("<H", 4) + b"XTRA"
    header += b"optional.csv\0comment for fixture\0"
    header += struct.pack("<H", zlib.crc32(header) & 0xFFFF)
    compressor = zlib.compressobj(level=9, wbits=-15)
    body = compressor.compress(data) + compressor.flush()
    trailer = struct.pack("<II", zlib.crc32(data), len(data) & 0xFFFFFFFF)
    return bytes(header) + body + trailer


def gzip_bytes(data: bytes) -> bytes:
    """Normalize the gzip OS marker for stable bytes across Python hosts."""
    encoded = bytearray(gzip.compress(data, mtime=0))
    encoded[9] = 255
    return bytes(encoded)


def tar_bytes(format_: int, members: list[tuple[str, bytes | None, str | None]]) -> bytes:
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w", format=format_) as archive:
        for name, data, link in members:
            info = tarfile.TarInfo(name)
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mode = 0o755 if data is None and link is None else 0o644
            if link is not None:
                info.type = tarfile.SYMTYPE
                info.linkname = link
                archive.addfile(info)
            elif data is None:
                info.type = tarfile.DIRTYPE
                archive.addfile(info)
            else:
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
    return stream.getvalue()


def tar_size_lie(*, name: bytes = b"short", size: int = 1_000_000, typeflag: bytes = b"0", body: bytes = b"short") -> bytes:
    header = bytearray(512)
    header[0:len(name)] = name
    header[100:108] = b"0000644\0"
    header[108:116] = b"0000000\0"
    header[116:124] = b"0000000\0"
    header[124:136] = f"{size:011o}\0".encode("ascii")
    header[136:148] = b"00000000000\0"
    header[148:156] = b"        "
    header[156:157] = typeflag
    header[257:263] = b"ustar\0"
    header[263:265] = b"00"
    checksum = sum(header)
    header[148:156] = f"{checksum:06o}\0 ".encode("ascii")
    return bytes(header) + body


def fixture_bytes() -> dict[str, tuple[bytes, str]]:
    nested = zip_bytes([("nested.txt", b"nested original content\n")])

    # Three compressed container layers around a 512 KiB repeated payload.
    amp_unit = b"NESTED-AMPLIFICATION\n"
    amp_payload = amp_unit * (512 * 1024 // len(amp_unit))
    amp_payload += amp_unit[: 512 * 1024 - len(amp_payload)]
    level = zip_bytes([("payload.txt", amp_payload)])
    level = zip_bytes([("level-3.zip", level)])
    level = zip_bytes([("level-2.zip", level)])
    level = zip_bytes([("level-1.zip", level)])

    hostile_names = zip_bytes([
        ("../../etc/passwd", b"path traversal name only\n"),
        ("__MACOSX/._x", b"OS metadata only\n"),
        (".DS_Store", b"OS metadata only\n"),
        ("Thumbs.db", b"OS metadata only\n"),
    ])
    many = zip_bytes([(f"empty/{index:05d}.txt", b"") for index in range(10_000)], compression=zipfile.ZIP_STORED)

    gzip_members = gzip_bytes(b"first\n") + gzip_bytes(b"second\n")
    gzip_bomb_payload = b"Z" * (512 * 1024)

    variants = tar_bytes(tarfile.USTAR_FORMAT, [
        ("folder/", None, None),
        ("folder/subfolder/", None, None),
        ("folder/subfolder/data.csv", b"k,v\na,2\n", None),
        ("folder/link.csv", None, "subfolder/data.csv"),
    ])
    pax_long = tar_bytes(tarfile.PAX_FORMAT, [("pax/" + "p" * 65_536, b"pax path payload\n", None)])
    gnu_long = tar_bytes(tarfile.GNU_FORMAT, [("gnu/" + "g" * 180, b"gnu long-name payload\n", None)])
    bad_checksum = bytearray(variants)
    bad_checksum[0] ^= 1
    pax_size_lie = tar_size_lie(
        name=b"PaxHeaders/payload",
        typeflag=b"x",
        body=b"10 path=x\n",
    )

    tar_gz = gzip_bytes(variants)
    return {
        "zip-mixed.zip": (zip_bytes([
            ("data.csv", CSV),
            ("page.html", b"<!doctype html><title>Fixture</title><p>Original fixture.</p>\n"),
            ("nested/inside.zip", nested),
            ("pixel.png", png_1x1()),
            ("folder/", b""),
        ]), "#39 valid mixed archive: ordered CSV, HTML, nested ZIP, original 1x1 RGBA PNG, directory."),
        "zip-hostile-names.zip": (hostile_names, "#39 names test path traversal and common macOS/Windows OS junk; no extraction is performed."),
        "zip-10000-empty.zip": (many, "#39 exactly 10,000 empty ZIP entries, stored without compression."),
        "zip-nested-amplification.zip": (zip_bytes([("level-1.zip", level)]), "#39 bounded four-container nesting around about 512 KiB of repeated leaf data; not a dangerous-scale bomb."),
        "gzip-csv.gz": (gzip_bytes(b"id,total\n1,9\n"), "#61 single-member gzip containing a small CSV."),
        "gzip-multi-member.gz": (gzip_members, "#61 two concatenated gzip members; standard-library decompression yields both in order."),
        "gzip-optional-header.gz": (gzip_optional_header(b"optional header\n"), "#61 gzip FEXTRA, FNAME, FCOMMENT, and FHCRC fields."),
        "gzip-bounded-amplification.gz": (gzip_bytes(gzip_bomb_payload), "#61 bounded 512 KiB repeated data for decompression-ratio testing."),
        "tar-variants.tar": (variants, "#61 ustar nested folders, regular CSV, and a symlink listed as metadata; no link traversal."),
        "tar-pax-long-path.tar": (pax_long, "#61 valid PAX extended path record with a 65,536-character component, bounded metadata stress."),
        "tar-gnu-long-name.tar": (gnu_long, "#61 GNU long-name extension for a 180-character path."),
        "tar-bad-checksum.tar": (bytes(bad_checksum), "#61 malformed ustar header with first name byte flipped after checksum creation."),
        "tar-size-lie.tar": (tar_size_lie(), "#61 malformed ustar header claims a 1,000,000-byte regular file but provides five body bytes."),
        "tar-pax-size-lie.tar": (pax_size_lie, "#61 malformed PAX extended header claims a 1,000,000-byte metadata body but provides one 10-byte path record."),
        "tar-gzip.tar.gz": (tar_gz, "#61 gzip-compressed ustar archive containing nested folders, CSV, and symlink metadata."),
    }


def write_fixtures(output: pathlib.Path) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    records = []
    for name, (data, notes) in fixture_bytes().items():
        if len(data) >= CAP_BYTES:
            raise ValueError(f"{name} exceeds the {CAP_BYTES}-byte fixture cap")
        path = output / name
        path.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        path.with_name(path.name + ".license").write_text(
            "SPDX-License-Identifier: CC0-1.0\n"
            "Source: original synthetic fixture generated by generate_fixtures.py using Python standard library only\n"
            f"Notes: {notes}\n",
            encoding="utf-8",
        )
        records.append({"file": name, "bytes": len(data), "sha256": digest, "notes": notes})

    manifest = {
        "description": "Original synthetic archive fixtures for independent #39/#61 preparation.",
        "generator": "generate_fixtures.py",
        "dependencies": [],
        "max_fixture_bytes": CAP_BYTES,
        "verification": {
            "stdlib_structure_checks": "run by test_fixtures.py",
            "extraction_verified": False,
            "reader_acceptance_verified": False,
            "golden_outputs_present": False,
            "quine_verified": False,
            "notes": "Python stdlib validates container decoding and intended malformed byte structures only; no docsluice extraction was run.",
        },
        "known_gaps": [
            "No true ZIP quine fixture is included. A recursive ZIP containing itself was not constructed or verified.",
            "The nested amplification inputs are deliberately bounded and do not represent gigabyte-scale expansion.",
            "Malformed TAR cases assert header/body contradictions; expected docsluice reader outcomes remain unverified.",
        ],
        "fixtures": records,
    }
    (output / "fixtures.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    delta = {
        "proposal_only": True,
        "shared_manifest_edited": False,
        "verification_status": "NOT extraction-verified",
        "entries": [
            {"file": name, "expectation_to_assign_after_reader_validation": expect, "requirement": requirement, "maxMs": 5000, "maxHeapMB": 256,
             "verification_status": "NOT extraction-verified"}
            for name, expect, requirement in [
                ("zip-10000-empty.zip", {"limit_or_warning": "entry-count limit outcome to be set by reader owners"}, "SEC-2"),
                ("zip-hostile-names.zip", {"warnings_or_listing": "path and skipped-junk behavior to be set by reader owners"}, "SEC-3"),
                ("zip-nested-amplification.zip", {"limit_or_warning": "nested shared-budget outcome to be set by reader owners"}, "NST-1"),
                ("gzip-bounded-amplification.gz", {"limit_or_warning": "ratio/byte-limit outcome to be set by reader owners"}, "SEC-1"),
                ("tar-bad-checksum.tar", {"malformed": "reader outcome to be set by reader owners"}, "SEC-1"),
                ("tar-size-lie.tar", {"malformed": "reader outcome to be set by reader owners"}, "SEC-1"),
                ("tar-pax-long-path.tar", {"limit_or_warning": "metadata limit outcome to be set by reader owners"}, "SEC-2"),
                ("tar-pax-size-lie.tar", {"malformed": "PAX size claim exceeds available metadata bytes; reader outcome to be set by reader owners"}, "SEC-1"),
            ]
        ],
    }
    (output / "manifest.delta.json").write_text(json.dumps(delta, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=pathlib.Path, required=True, help="directory to receive generated fixtures")
    args = parser.parse_args()
    manifest = write_fixtures(args.output)
    print(f"wrote {len(manifest['fixtures'])} fixtures to {args.output}")


if __name__ == "__main__":
    main()
