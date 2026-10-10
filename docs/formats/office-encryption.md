# Password-protected OOXML packages

Pass `password` to open a password-protected DOCX, XLSX or PPTX (and their macro-enabled forms):

```js
const doc = await extract(bytes, { password: 'secret' });
doc.features.isEncrypted; // true
```

Such a file is an OLE compound file with root `EncryptionInfo` and `EncryptedPackage` streams ([MS-OFFCRYPTO]).

- Detection decrypts the package with Web Crypto (`crypto.subtle`) and detects the decrypted ZIP as usual. The document is the inner format (`docx`, `xlsx`, `pptx` …) with `features.isEncrypted: true`.
- The decryption module (`src/office/encryption`) loads only for encrypted packages that come with a password. It is outside the core bundle budget.
- Without a password, the file fails with `EncryptedError` (`password-required`), from `detect()` as well as `extract()`. `detect(bytes, { password })` reports the inner format.
- When the decrypted package does not fit `totalUncompressedBytes`, the file fails with `LIMIT_EXCEEDED`.
- Legacy binary files with RC4 encryption (DOC, XLS, PPT) are not decrypted.

Key derivation repeats the hash up to `spinCount` times. LibreOffice and Office write 100,000 spins, which take about two seconds through Web Crypto, whose calls are asynchronous. A file may ask for up to 10,000,000 spins; the time budget (`timeMs`) and `signal` stop such work.

Supported formats are Standard AES-128/192/256 with SHA-1 and Agile AES-CBC with
SHA-1/256/384/512. Passwords retain their UTF-16LE code units. Missing passwords
produce `EncryptedError('password-required')`; verifier mismatch produces
`EncryptedError('wrong-password')`; unsupported descriptors or missing Web Crypto
produce `EncryptedError('unsupported-encryption')`. Invalid lengths, duplicate
root streams and Agile integrity mismatch produce static `CorruptFileError`
messages. Nested marker streams are ignored. No password or document text is
placed in an error or warning.

Standard password hashing uses the fixed 50,000 iterations and the specified
SHA-1 expansion to an AES ECB key. Web Crypto CBC operations recover ECB blocks
without implementing AES or introducing a runtime dependency. The raw CBC adapter
adds one synthetic PKCS#7 block so Web Crypto removes that block while preserving
Office's arbitrary padding. The adapter has independent NIST CBC/ECB vector tests.

Agile derives independent verifier, verifier-hash and package-wrapping keys.
Package and password key sizes remain distinct. It decrypts payloads in 4096-byte
segments with the prescribed counter IV and trims the final segment to the
validated 64-bit plaintext length. When a `dataIntegrity` descriptor exists, its
HMAC is verified over the complete encrypted stream including its size field.
Descriptors without that optional element have password verification but no
package-integrity verification. Standard has no comparable package HMAC.

All KDF loops, scanning and copying tick the shared time/cancellation budget.
Plaintext size is validated and preflighted before allocation and charged before
decryption. Web Crypto operations already in flight cannot be interrupted; the
next budget check observes cancellation or elapsed time. Stream-size copies for
Web Crypto can increase peak memory above the decrypted payload alone.

Test fixtures:

- `packages/docsluice/test/office/fixtures/libreoffice/encrypted.{docx,xlsx,pptx}` were saved by LibreOffice (Agile, AES-256, SHA-512) with `scripts/corpus/make-encrypted-ooxml.py`.
- The other fixtures in `test/office/fixtures` are generated independently by `generate.py`, using Python `hashlib`, `hmac` and the `cryptography` AES backend. They cover Standard and every Agile hash, Unicode passwords, key and salt sizes, segment boundaries, and tampering.
- `hostile/office` holds an HMAC-tampered package and a spin count over the limit. Both fail with `CORRUPT_FILE`.

See [EncryptionInfo validation](office-encryption-info.md) and Microsoft
[MS-OFFCRYPTO Standard key generation](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/84f1cce1-1e82-4e05-bc8e-91456ad44823),
[Agile key generation](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/74d60145-a0f0-44be-99ce-c65d211b4eb7),
[Agile payload encryption](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/9e61da63-8ddb-4c0a-b25d-f85d990f44c8)
and [Agile integrity](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/63d9c262-82b9-4fa3-a06d-d087b93e3b00).
