# Images

The image reader (`docsluice/image`) reads PNG, JPEG, GIF, TIFF and WebP files, detected from their signatures. It gives no text: each image is one `image` block with its `mimeType` and, when the header gives them, its pixel `width` and `height`. Images inside documents and archives become child documents with the same block, so a caller can see their size without decoding them.

## Size

| Format | Source of the size |
|--------|--------------------|
| PNG | `IHDR` |
| JPEG | the first start-of-frame (`SOFn`) segment before the scan |
| GIF | the logical screen descriptor |
| WebP | `VP8X` canvas, else the `VP8` frame header or the `VP8L` header |
| TIFF | `ImageWidth` and `ImageLength` in IFD0 |

## EXIF metadata

EXIF comes from the JPEG `APP1` `Exif` segment, the PNG `eXIf` chunk, the WebP `EXIF` chunk or the TIFF IFD0 itself, in either byte order.

- `metadata.created` is `DateTimeOriginal` (with `OffsetTimeOriginal` when present, for example `2026-05-14T08:30:00+02:00`), else `DateTime`. Without an offset the time is local, as the camera wrote it.
- `metadata.custom` holds `orientation` (the EXIF value 1–8), `cameraMake` and `cameraModel`.
- GPS position is personal data and is off by default. With the `imageGps: true` option, `metadata.custom` also holds `gpsLatitude` and `gpsLongitude` (signed decimal degrees, seven decimals) and `gpsAltitude` (metres; negative below sea level).
- `metadata: false` drops all EXIF, including the date and GPS, whatever `imageGps` says (PRD section 15).

## Safety

- Pixels are never decoded. Only headers, chunk and segment lists, and IFDs are read.
- Every chunk, segment and IFD size is checked against the bytes present; a lie stops that walk with an `UNREADABLE_PART` warning and keeps what was read.
- IFDs are visited at most once each (at most 16 per image, at most 1,024 entries each), so IFD chains and sub-IFD pointers that loop end at once. ASCII values are cut at 256 characters.

Not read: XMP and IPTC metadata, ICC profiles, animation frames, multi-page TIFF pages after the first, BMP and ICO (detected only). OCR is a plugin (EXT-5).

## Corpus and generators

`scripts/corpus/make-images.py` makes the synthetic `corpus/image` files with Pillow (EXIF with a fictional camera and a GPS position at sea) and writes the big-endian TIFF by hand. `scripts/hostile/generate-images.mjs` writes `hostile/image`: IFD loops, huge entry counts, value-offset lies, segment and chunk-size lies, and a JPEG fill-byte flood.
