# vCard (VCF)

The reader unfolds RFC 6350 continuation lines and emits one paragraph for each `VCARD`. The paragraph starts with `VCARD` followed by its properties; `loc.path` is `VCARD[n]`. When `metadata: false`, personal fields `FN`, `N`, `ADR`, `EMAIL`, and `TEL` are omitted; other properties remain text. This reader does not decode transfer encodings or normalize structured property values.
