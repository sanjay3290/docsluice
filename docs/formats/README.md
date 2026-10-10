# Format support

One page per format: what is read, what is not, options that apply, known gaps. The [support matrix](support-matrix.md) is generated from the corpus (PRD section 20): run `npm run docs:support` after you add a corpus file, a reader or a requirement tag. A test fails when the committed page is out of date, and the generator fails when a reader has no format page.

## Signature detection

The magic-byte sniffer recognizes BMP as `kind: 'bmp'` and ICO as `kind: 'ico'`, with MIME types `image/bmp` and `image/x-icon`. These identifiers indicate format detection only; this repository does not yet provide BMP or ICO content readers.
