# Password-protected OOXML packages

`src/office/encryption/index.ts` exports the internal helper
`decryptOffice(cfb, password, context)`. It returns decrypted ZIP bytes, or
`undefined` when no root encrypted-package stream exists or the shared byte budget
truncates a read/allocation. It accepts an existing CFB index and the same Budget
and WarningSink used for the extraction. Reader registration and pre-detection
routing belong to the integration lead.

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

The original licensed test fixtures are generated independently with Python
`hashlib`, `hmac` and the cryptography AES backend. They cover DOCX/XLSX/PPTX ZIP
part paths, Unicode passwords, key/salt-size differences, segment boundaries and
tampering. They do not establish LibreOffice interoperability. LibreOffice-made
files and production extraction routing remain acceptance dependencies.

See [EncryptionInfo validation](office-encryption-info.md) and Microsoft
[MS-OFFCRYPTO Standard key generation](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/84f1cce1-1e82-4e05-bc8e-91456ad44823),
[Agile key generation](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/74d60145-a0f0-44be-99ce-c65d211b4eb7),
[Agile payload encryption](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/9e61da63-8ddb-4c0a-b25d-f85d990f44c8)
and [Agile integrity](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/63d9c262-82b9-4fa3-a06d-d087b93e3b00).
