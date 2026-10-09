"""Make PPT hostile fixtures by mutating our trusted LibreOffice source.

This test-only recipe locates bytes in this small known CFB; it is not a general
CFB parser or an implementation used by the reader. No third-party code is used.
"""

from pathlib import Path
import argparse
import struct

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[5]
SOURCE = REPO / "corpus/ppt/order-title-notes.ppt"
END = 0xFFFFFFFE
FREE = 0xFFFFFFFF


def u32(data, offset):
    return struct.unpack_from("<I", data, offset)[0]


def stream_positions(data):
    sector_size = 1 << struct.unpack_from("<H", data, 30)[0]
    assert sector_size == 512 and u32(data, 72) == 0
    fat_ids = [u32(data, 76 + i * 4) for i in range(109)]
    fat_ids = [sid for sid in fat_ids if sid != FREE]
    fat = []
    for sid in fat_ids:
        fat.extend(struct.unpack_from("<128I", data, (sid + 1) * sector_size))

    def chain(start, table):
        result, seen = [], set()
        while start != END:
            assert 0 <= start < len(table) and start not in seen
            seen.add(start)
            result.append(start)
            start = table[start]
        return result

    def regular_positions(start):
        return [
            (sid + 1) * sector_size + offset
            for sid in chain(start, fat)
            for offset in range(sector_size)
        ]

    directory = bytes(data[p] for p in regular_positions(u32(data, 48)))
    entries = {}
    for offset in range(0, len(directory), 128):
        name_size = struct.unpack_from("<H", directory, offset + 64)[0]
        if not name_size:
            continue
        name = directory[offset : offset + name_size - 2].decode("utf-16le")
        entries[name] = (u32(directory, offset + 116), u32(directory, offset + 120))
    root_positions = regular_positions(entries["Root Entry"][0])
    mini_fat_bytes = bytes(data[p] for p in regular_positions(u32(data, 60)))
    mini_fat = struct.unpack("<" + "I" * (len(mini_fat_bytes) // 4), mini_fat_bytes)
    result = {}
    for name in ["PowerPoint Document", "Current User"]:
        start, size = entries[name]
        if size >= 4096:
            positions = regular_positions(start)
        else:
            positions = [
                root_positions[sid * 64 + offset]
                for sid in chain(start, mini_fat)
                for offset in range(64)
            ]
        result[name] = positions[:size]
    return result


def build(check):
    source = SOURCE.read_bytes()
    positions = stream_positions(source)
    user = bytes(source[p] for p in positions["Current User"])
    document = bytes(source[p] for p in positions["PowerPoint Document"])
    edit = u32(user, 16)
    persist = u32(document, edit + 20)
    mutations = [
        ("invalid-edit-pointer", "Current User", 16, FREE),
        ("oversized-persist-run", "PowerPoint Document", persist + 8, (u32(document, persist + 8) & 0xFFFFF) | (0xFFF << 20)),
        ("encrypted-user-token", "Current User", 12, 0xF3D1C4DF),
    ]
    for name, stream, offset, value in mutations:
        data = bytearray(source)
        for index, byte in enumerate(struct.pack("<I", value)):
            data[positions[stream][offset + index]] = byte
        path = HERE / "hostile" / (name + ".ppt")
        if check:
            assert path.read_bytes() == data, path
        else:
            path.write_bytes(data)
    print("3 PPT hostile fixtures match deterministic mutations" if check else "Wrote 3 PPT hostile fixtures")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    build(parser.parse_args().check)
