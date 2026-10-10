"""Create the self-made image fixtures in corpus/image with Pillow (no third-party photos).

Each image is a small synthetic gradient. The JPEG, WebP, TIFF and PNG files carry EXIF written by
Pillow: capture date and offset, orientation, a fictional camera make and model, and a GPS position
in the sea off Null Island, so the GPS option has something to show.
"""

from pathlib import Path

from PIL import Image
from PIL.TiffImagePlugin import IFDRational

OUT = Path(__file__).resolve().parents[2] / "corpus" / "image"


def gradient(width: int, height: int) -> Image.Image:
    image = Image.new("RGB", (width, height))
    image.putdata([((x * 255) // width, (y * 255) // height, 128) for y in range(height) for x in range(width)])
    return image


def exif(date: str, offset: str | None, orientation: int = 1, gps: bool = True) -> Image.Exif:
    data = Image.Exif()
    data[0x010F] = "Docsluice Optics"  # Make
    data[0x0110] = "Fixture 1"  # Model
    data[0x0112] = orientation  # Orientation
    data[0x0132] = date  # DateTime
    sub = data.get_ifd(0x8769)
    sub[0x9003] = date  # DateTimeOriginal
    if offset:
        sub[0x9011] = offset  # OffsetTimeOriginal
    if gps:
        position = data.get_ifd(0x8825)
        position[1] = "S"
        position[2] = (IFDRational(0), IFDRational(30), IFDRational(1800, 100))
        position[3] = "W"
        position[4] = (IFDRational(1), IFDRational(15), IFDRational(0))
        position[5] = b"\x00"
        position[6] = IFDRational(125, 10)
    return data


def big_endian_tiff(width: int, height: int) -> bytes:
    """A minimal big-endian (MM) RGB TIFF, written by hand: Pillow writes little-endian only."""
    pixels = gradient(width, height).tobytes()
    date = b"2024:02:29 12:00:00\x00"
    entries = [
        (256, 3, 1, width),  # ImageWidth
        (257, 3, 1, height),  # ImageLength
        (258, 3, 1, 8),  # BitsPerSample (one value per sample is enough for readers of the header)
        (259, 3, 1, 1),  # Compression: none
        (262, 3, 1, 2),  # PhotometricInterpretation: RGB
        (273, 4, 1, 0),  # StripOffsets, patched below
        (274, 3, 1, 3),  # Orientation: rotated 180
        (277, 3, 1, 3),  # SamplesPerPixel
        (278, 3, 1, height),  # RowsPerStrip
        (279, 4, 1, len(pixels)),  # StripByteCounts
        (306, 2, len(date), 0),  # DateTime, patched below
    ]
    ifd_size = 2 + len(entries) * 12 + 4
    date_offset = 8 + ifd_size
    strip_offset = date_offset + len(date)
    out = bytearray(b"MM\x00\x2a" + (8).to_bytes(4, "big") + len(entries).to_bytes(2, "big"))
    for tag, kind, count, value in entries:
        if tag == 273:
            value = strip_offset
        if tag == 306:
            value = date_offset
        out += tag.to_bytes(2, "big") + kind.to_bytes(2, "big") + count.to_bytes(4, "big")
        out += value.to_bytes(2, "big") + b"\x00\x00" if kind == 3 else value.to_bytes(4, "big")
    out += (0).to_bytes(4, "big") + date + pixels
    return bytes(out)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    gradient(32, 24).save(OUT / "gradient-exif.jpg", quality=80, exif=exif("2026:05:14 08:30:00", "+02:00", 6))
    gradient(16, 9).save(OUT / "gradient.png", optimize=False)
    gradient(20, 10).save(OUT / "gradient-exif.png", exif=exif("2025:12:31 23:59:59", None))
    gradient(12, 8).convert("P").save(OUT / "gradient.gif")
    gradient(40, 30).save(OUT / "gradient-lossy.webp", quality=50, method=0)
    gradient(24, 16).save(OUT / "gradient-lossless-exif.webp", lossless=True, exif=exif("2026:01:02 03:04:05", "-05:00", 1, False))
    gradient(10, 6).save(OUT / "gradient-le.tif", compression="raw", exif=exif("2026:03:04 05:06:07", None, 1, False))
    (OUT / "gradient-be.tif").write_bytes(big_endian_tiff(7, 5))


if __name__ == "__main__":
    main()
