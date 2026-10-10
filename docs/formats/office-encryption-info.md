# Office `EncryptionInfo` descriptors

The office encryption parser reads the `EncryptionInfo` stream used by encrypted OOXML packages. It identifies the descriptor and returns the parameters and encrypted verifier/key material needed by the password decryption layer. It does not perform cryptography or decrypt a document.

## Agile encryption

Agile streams require version 4.4 and the reserved DWORD value `0x40`, followed by an XML `encryption` element in the Office encryption namespace. The parser requires one direct `keyData`, an optional direct `dataIntegrity`, and one direct `keyEncryptors`. It accepts exactly one password `keyEncryptor` with an `encryptedKey` element in the password namespace. Schema attributes must be unqualified. Namespace declarations are allowed, and the XML tree is checked by namespace URI rather than prefix spelling.

Supported key descriptors use AES-CBC with a 16-byte block and 128-, 192-, or 256-bit keys. Hashes are SHA-1, SHA-256, SHA-384, or SHA-512; returned names are normalized for Web Crypto (`SHA-1`, `SHA-256`, `SHA-384`, `SHA-512`). The Agile `keyData` and password key parameters remain separate because their salts, key sizes and spin counts describe different derivation/encryption stages. `saltSize` must be 1–65,536 and must equal the decoded salt length. `hashSize` must match the selected hash output. Password `spinCount` is 0–10,000,000.

Base64 values are checked before decoding. Encrypted password verifier input is AES-block-rounded from the password `saltSize`; its encrypted verifier hash is rounded from the password `hashSize`; and `encryptedKeyValue` is rounded from the parent `keyData.keyBits`. The encrypted HMAC key is rounded from `keyData.saltSize`, while the encrypted HMAC value is rounded from the key-data `hashSize`. XML scans that stop at an output-character or XML-depth budget fail with the corresponding `LimitExceededError`; the parser never accepts a tree or envelope that the shared scanner truncated. The XML parser and descriptor parser tick the shared budget while scanning file-derived bytes, tree entries, attributes, base64, and text. XML warnings selected by strict mode, aborts, and budget errors propagate unchanged.

## Standard encryption

Standard streams require major version 2, 3, or 4 with minor version 2. The descriptor must include a 32-byte EncryptionHeader prefix, matching top-level and header flags, the CryptoAPI and AES flags, no document-properties flag, zero `SizeExtra` and `Reserved2`, and matching AES AlgID and key size. An optional CSP name must be a terminated UTF-16LE string. Only AES-128/192/256 with SHA-1 is supported. The verifier salt is exactly 16 bytes, the encrypted verifier is 16 bytes, the declared verifier hash size is 20 bytes, and the encrypted verifier hash is 32 bytes. Trailing or truncated fields are rejected.

Structurally invalid descriptors raise `CorruptFileError`. Valid encryption choices outside the supported set raise `EncryptedError` with reason `unsupported-encryption`.

## Specification references

- [MS-OFFCRYPTO §2.3.4.10, Agile EncryptionInfo stream](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/87020a34-e73f-4139-99bc-bbdf6cf6fa55)
- [MS-OFFCRYPTO §2.3.4.13, PasswordKeyEncryptor generation](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/a57cb947-554f-4e5e-b150-3f2978225e92)
- [MS-OFFCRYPTO §2.3.4.14, DataIntegrity generation](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/63d9c262-82b9-4fa3-a06d-d087b93e3b00)
- [MS-OFFCRYPTO §2.3.4.5, Standard EncryptionInfo stream](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/2895eba1-acb1-4624-9bde-2cdad3fea015)
- [MS-OFFCRYPTO §2.3.3, EncryptionVerifier](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/e5ad39b8-9bc1-4a19-bad3-44e6246d21e6)
