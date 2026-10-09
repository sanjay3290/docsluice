# Hostile corpus

Attack files that every reader must survive. Layout and `manifest.json` format: [docs/testing.md](../docs/testing.md#3-hostile-tests-qa-3-section-143).

`zip/nested-4gib.zip` is the real-output bomb recipe: its outer ZIP contains a compressed inner ZIP64 archive whose DEFLATE member represents exactly 4 GiB of zero bytes. Regenerate it with `node scripts/hostile/zip-nested-4gib.mjs`; the script streams 64 KiB chunks through Node zlib and writes only the 42 KiB outer fixture. The generator records the exact logical input and CRC values in its output.
