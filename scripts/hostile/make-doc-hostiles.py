"""Derive a password-protected-bit DOC from the self-authored CC0 fixture."""

from pathlib import Path
import argparse
import struct


FREE = 0xFFFFFFFF
END = 0xFFFFFFFE


def make_encrypted(source: Path) -> bytes:
    data = bytearray(source.read_bytes())
    if data[:8] != bytes.fromhex("d0cf11e0a1b11ae1"):
        raise ValueError("source is not a CFB file")
    major = struct.unpack_from("<H", data, 26)[0]
    sector_size = 1 << struct.unpack_from("<H", data, 30)[0]
    if major not in (3, 4) or sector_size not in (512, 4096):
        raise ValueError("unsupported CFB sector profile")
    sector_count = len(data) // sector_size - 1

    def sector(index: int) -> memoryview:
        if index < 0 or index >= sector_count:
            raise ValueError("sector is out of bounds")
        start = (index + 1) * sector_size
        return memoryview(data)[start : start + sector_size]

    fat_sector_ids = [
        value
        for value in struct.unpack_from("<109I", data, 76)
        if value not in (FREE, END)
    ]
    difat_id = struct.unpack_from("<I", data, 68)[0]
    difat_count = struct.unpack_from("<I", data, 72)[0]
    seen_difat = set()
    for _ in range(difat_count):
        if difat_id >= sector_count or difat_id in seen_difat:
            raise ValueError("invalid DIFAT chain")
        seen_difat.add(difat_id)
        values = struct.unpack("<" + "I" * (sector_size // 4), sector(difat_id))
        fat_sector_ids.extend(value for value in values[:-1] if value not in (FREE, END))
        difat_id = values[-1]
    fat = []
    for fat_sector_id in fat_sector_ids:
        fat.extend(struct.unpack("<" + "I" * (sector_size // 4), sector(fat_sector_id)))

    def chain(start: int) -> list[int]:
        result = []
        seen = set()
        current = start
        while current != END:
            if current >= sector_count or current >= len(fat) or current in seen:
                raise ValueError("invalid FAT chain")
            seen.add(current)
            result.append(current)
            current = fat[current]
        return result

    directory_ids = chain(struct.unpack_from("<I", data, 48)[0])
    directory = b"".join(bytes(sector(index)) for index in directory_ids)
    stream = None
    for offset in range(0, len(directory), 128):
        name_size = struct.unpack_from("<H", directory, offset + 64)[0]
        entry_type = directory[offset + 66]
        if entry_type != 2 or name_size < 2 or name_size > 64 or name_size % 2:
            continue
        name = directory[offset : offset + name_size - 2].decode("utf-16le")
        if name == "WordDocument":
            stream = (
                struct.unpack_from("<I", directory, offset + 116)[0],
                struct.unpack_from("<I", directory, offset + 120)[0],
            )
            break
    if stream is None:
        raise ValueError("WordDocument stream not found")
    start_sector, size = stream
    if size < 12 or size < 4096:
        raise ValueError("WordDocument stream is too small for this fixture")
    stream_sectors = chain(start_sector)
    if len(stream_sectors) * sector_size < size:
        raise ValueError("WordDocument allocation is too short")
    absolute = (stream_sectors[0] + 1) * sector_size
    flags = struct.unpack_from("<H", data, absolute + 10)[0]
    struct.pack_into("<H", data, absolute + 10, flags | 0x0100)
    return bytes(data)


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=root / "corpus/doc/doc-legacy.doc")
    parser.add_argument("--output", type=Path, default=root / "hostile/doc/encrypted.doc")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(make_encrypted(args.source))


if __name__ == "__main__":
    main()
