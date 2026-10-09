# Format support

One page per format: what is read, what is not, options that apply, known gaps. The support matrix is generated from the corpus (section 20) once the generator exists.

## Signature detection

The magic-byte sniffer recognizes BMP as `kind: 'bmp'` and ICO as `kind: 'ico'`, with MIME types `image/bmp` and `image/x-icon`. These identifiers indicate format detection only; this repository does not yet provide BMP or ICO content readers.
