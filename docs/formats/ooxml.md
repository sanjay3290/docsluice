# OOXML helper support

The internal OOXML helpers provide a bounded, name-only view of ZIP parts, parse package relationships and content types, read core/app/custom document properties, and identify macros, external relationships, and embedded files. They use the shared XML parser and archive budget. OOXML relationship targets are resolved only inside the package; external targets remain data and are never fetched.

ZIP part lookup uses exact names first. A unique ASCII case-folded match supports producer variations. Duplicate exact entries or ambiguous case-folded matches are reported as unreadable instead of choosing by archive order. Missing optional parts remain absent.

Metadata is returned using the existing model. Recognized core/app fields and custom `property` records must be direct children of their exact-namespaced roots. Scalar fields reject nested markup. `Pages` takes precedence over `Slides` for `pageCount`; no slide-specific metadata field is added. When personal metadata is disabled, authors and custom properties are omitted.

Custom properties are represented as name/value pairs. The helper stringifies the supported `vt:*` scalar values and vectors of scalar or variant values; vector items are joined with `, `. Unsupported compound VT values such as arrays are skipped with a static structural warning.

An encrypted OOXML file is a compound file with a root `EncryptedPackage` stream. Without `password`, detection rejects it with `EncryptedError` (`password-required`) before any reader runs (`hostile/ooxml/encrypted-package.cfb`). The CFB helper does the same for readers that receive a compound file directly. With `password`, it is decrypted and read as its inner format ([office-encryption.md](office-encryption.md)). Properties written by LibreOffice (an empty creator and title, `language`) are covered by tests on the corpus DOCX, XLSX and PPTX files. The DOCX, XLSX and PPTX readers (#29, #34, #37) consume these helpers.
