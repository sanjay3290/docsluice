# OOXML helper support

The internal OOXML helpers provide a bounded, name-only view of ZIP parts, parse package relationships and content types, read core/app/custom document properties, and identify macros, external relationships, and embedded files. They use the shared XML parser and archive budget. OOXML relationship targets are resolved only inside the package; external targets remain data and are never fetched.

ZIP part lookup uses exact names first. A unique ASCII case-folded match supports producer variations. Duplicate exact entries or ambiguous case-folded matches are reported as unreadable instead of choosing by archive order. Missing optional parts remain absent.

Metadata is returned using the existing model. Recognized core/app fields and custom `property` records must be direct children of their exact-namespaced roots. Scalar fields reject nested markup. `Pages` takes precedence over `Slides` for `pageCount`; no slide-specific metadata field is added. When personal metadata is disabled, authors and custom properties are omitted.

Custom properties are represented as name/value pairs. The helper stringifies the supported `vt:*` scalar values and vectors of scalar or variant values; vector items are joined with `, `. Unsupported compound VT values such as arrays are skipped with a static structural warning.

The CFB helper recognizes a root `EncryptedPackage` stream and throws `EncryptedError('password-required')`; it does not decrypt. This helper groundwork is not yet connected to a complete OOXML reader or format-detection pipeline. LibreOffice producer acceptance and full extraction remain pending integration with the detection and reader-registry work.
