# Independent archive fixture preparation (#39 / #61)

This directory contains a deterministic Python-standard-library-only generator, a structural test suite, and generated fixture outputs in `fixtures/`. It does not modify docsluice readers, shared manifests, corpus goldens, or production scripts.

Regenerate into the checked-in fixture directory:

```sh
python generate_fixtures.py --output fixtures
```

Run the generator validators:

```sh
python -m unittest -v test_fixtures.py
```

The validators independently decode valid ZIP/GZIP/TAR contents with Python's standard library, check the original PNG's signature, dimensions and zlib scanline, assert ZIP central-directory order and entry counts, and inspect intended malformed TAR header/body contradictions. They compare a second generator run byte-for-byte in this executor (Python 3.12.14, zlib 1.3.2); cross-version byte identity is unverified. The tests do not write archive member paths to disk.

Every binary fixture has a neighboring `.license` file with `SPDX-License-Identifier: CC0-1.0` provenance. Each artifact is original and synthetic. Individual files are capped below 15 MiB; the decompression test payloads are limited to 512 KiB.

`fixtures/manifest.delta.json` is a proposal only, not directly mergeable into the hostile runner manifest: it names candidate fixtures and requirements but leaves the expected error or warning to reader owners after validation. Every entry is labeled **NOT extraction-verified**. `fixtures/fixtures.json` records the file hashes and explicitly reports that extraction, reader acceptance, and golden output are absent.

Known fixture limits:

- A true recursive ZIP quine is not included. A ZIP containing itself was neither constructed nor verified; `quine_verified` remains false.
- The nested ZIP and GZIP amplification cases are bounded demonstrations, not giant bombs.
- Malformed TAR cases contain an invalid checksum, a regular-file size claim that exceeds the available body, or a PAX metadata size claim that exceeds its 10-byte body. Their expected docsluice outcomes remain unverified.
- PAX metadata uses a valid 65,536-character path to exercise bounded metadata handling; it does not allocate or unpack that path on disk.
- These fixtures test container structure and deterministic generation only. No docsluice extraction results or expected output goldens were generated.
