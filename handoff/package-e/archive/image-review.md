# Independent review: image fixture preparation

Reviewed `/workspace/package-e-preparation/images/` without changing its files or the docsluice repository.

## Findings

No fixture correctness or unsafe-extraction defect found. The authored metadata matches the generated TIFF/Exif bytes, and the image-format labels describe their completeness accurately.

Low-priority test gap: `test_hostile_tiff_shapes_are_intentional` checks that the truncated TIFF value offset is near EOF, but it does not assert that the declared ASCII count extends beyond EOF. The generator currently writes offset 26, count 10, and a 28-byte file, so the intended malformed structure is present; an assertion on `offset + count > len(data)` would make that property explicit.

Low-priority coverage gap: the PNG test verifies chunk CRCs, the zlib stream, and dimensions, but does not assert the decoded scanline has the expected four bytes. The GIF test checks the signature, image separator, and trailer without decoding LZW. Independent ImageMagick decoding succeeded for both current tiny images, so this does not indicate a bad fixture.

## Checks and evidence

- `python -m unittest -v test_fixtures.py`: all six tests pass.
- Independently hashed all 22 files under `fixtures/`, including license sidecars; every SHA-256 value matches `expected-metadata.json`.
- ImageMagick identified and decoded `tiny.png` as a 1×1 RGB PNG and `tiny.gif` as a 1×1 GIF89a.
- ImageMagick reports the TIFF samples lack required `StripOffsets`, the JPEG lacks an SOS marker, and the WebP files are corrupt for image decoding. These match the README and expected metadata: TIFF is metadata-only, JPEG is a marker/Exif snippet without a scan, and WebP contains headers/chunks without a complete image bitstream. They are not described as complete photos.
- The generator only writes the fixed fixture paths; the tests parse bytes directly and do not extract archive/image paths to disk.
- Determinism is tested by generating twice and comparing hashes; the checked-in fixture tree also matches the expected hashes exactly in this review.

The proposal delta keeps hostile outcomes pending. All findings here concern fixture structure only; no docsluice image-reader extraction or acceptance was verified.
