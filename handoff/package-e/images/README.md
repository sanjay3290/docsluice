# Synthetic image parser fixtures

Run `python generate_fixtures.py` to regenerate `fixtures/`, then run
`python -m unittest -v test_fixtures.py`. The generator and the checks use only
the Python standard library. Every fixture has an adjacent CC0-1.0 `.license`
file; no third-party photos or code are included.

`expected-metadata.json` records hand-authored source facts and SHA-256 values.
It is not derived from docsluice output and is not a parser golden. PNG and GIF
are complete tiny images. The TIFF samples contain IFD0, Exif and GPS metadata,
but omit pixel strips. The JPEG sample contains SOI, APP1/Exif and SOF0, but no
SOS or entropy-coded scan. The WebP samples contain the relevant RIFF chunks
and dimension headers, but omit a complete VP8/VP8L image bitstream. Treat the
TIFF, JPEG and WebP files strictly as structural snippets, not decodable photos.

The proposed hostile integration delta intentionally leaves expected outcomes
pending until the image reader is implemented. It is not copied into the live
hostile manifest by this preparation task.

Primary format references used for structure:

- [PNG Third Edition](https://www.w3.org/TR/png-3/)
- [GIF89a specification](https://www.w3.org/Graphics/GIF/spec-gif89a.txt)
- [TIFF 6.0 specification](https://www.itu.int/itudoc/itu-t/com16/tiff-fx/docs/tiff6.pdf)
- [CIPA Exif 2.32](https://www.cipa.jp/std/documents/e/DC-X008-Translation-2019-E.pdf)
- [RFC 9649: WebP Image Format](https://www.rfc-editor.org/rfc/rfc9649.html)
