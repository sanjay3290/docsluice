# Original Office encryption fixtures

Run `python generate.py` with Python 3 and `cryptography` installed as an optional
fixture-generation tool. It is not a runtime or npm dependency. The committed
fixtures are deterministic public test data using password `Public test é😀`.

The generator independently implements the specified encryption using Python
`hashlib`, `hmac` and the cryptography AES backend. The TypeScript implementation
only uses Web Crypto and decrypts these files through the real CFB opener.
Fixtures cover Standard AES 128/192/256, Agile SHA-1/256/384/512, differing wrapping
and package key lengths, differing salt and hash sizes, Unicode passwords, and
payload boundaries at zero, 16, 4096, 4097 and 8193 bytes. ZIP payloads identify
DOCX, XLSX and PPTX package part paths and include a public deterministic tail to
exercise exact size trimming. They are synthetic, not LibreOffice output and do
not establish interoperability or full extraction acceptance.

`cases.json` records the streams, expected plaintext and SHA-256 of each licensed
CFB fixture. The generator creates original content and copies no third-party
document or implementation. See Microsoft MS-OFFCRYPTO sections 2.3.4.7 and
2.3.4.11–15 and MS-CFB for the normative algorithms and container structure.
