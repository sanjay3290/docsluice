# Visio VSDX (private reader preparation)

The private reader reads text from the page parts of a VSDX OPC package. It follows the package relationship chain from the root document to the Visio document, pages list, and each page content part. Pages are emitted as `section` blocks in the order declared in `visio/pages/pages.xml`; each shape's direct `<Text>` content and grouped child shapes are emitted in XML source order. Multiline text and Unicode are retained and normalized by `DocBuilder`.

The reader does not render geometry or attempt visual reading order. Text in connector shapes is emitted like text in other shapes; `<Connects>` relationship records are not reconstructed. It does not extract formulas, ShapeSheet values, linked images, masters, themes, embedded objects, or other page parts. It never follows external relationships or evaluates formulas. Inline text is limited to the core `cp`, `pp`, `tp`, and `fld` children defined by the format; foreign extension elements are skipped with a static warning. Shared OOXML helpers report external relationships and parse core properties/features. `metadata: false` omits package properties.

Malformed or ambiguous parts, duplicate shape IDs, wrong namespaces, absent relationships, and unsafe relationship targets produce static `UNREADABLE_PART` warnings; warnings do not include source text or targets. XML parsing, relationship resolution, ZIP reads, shape traversal, output characters, depth, cancellation, and time use the shared budgets. DTD declarations are ignored; external entities are never fetched or expanded.

Shape IDs below 4 are skipped with a static warning. This follows the normative `ShapeSheet_Type` requirement that a shape ID be an unsigned integer greater than or equal to 4. Microsoft's Page XML sample instead uses `Shape ID="1"`; this private reader follows the normative type, so compatibility with that conflicting example is not claimed. The reader orders pages by the Pages part and does not apply the shape-ID rule to page IDs or use them as ordering keys.

This remains a private integration preparation. `vsdxReader` is not registered in the default reader registry, and automatic detection is not added. Registration and public packaging await plugin API issue #41 and the format-packaging ADR decision. Tests inject the private reader into a test-only registry and force `format: 'vsdx'`; because the public detector has no VSDX MIME mapping, this private pipeline test uses the generic MIME fallback. The synthetic fixtures are source-structure samples and have not been opened or rendered by Visio.

## Format references

- [Microsoft: Introduction to the Visio file format (.vsdx)](https://learn.microsoft.com/en-us/office/client-developer/visio/introduction-to-the-visio-file-formatvsdx)
- [MS-VSDX Document XML Part](https://learn.microsoft.com/en-us/openspecs/sharepoint_protocols/ms-vsdx/7ec3d7b0-0de2-4711-a7b6-92daa2020d71)
- [MS-VSDX Pages XML Part](https://learn.microsoft.com/en-us/openspecs/sharepoint_protocols/ms-vsdx/947b485d-676a-480b-96e6-c0e4d1bf58f3) and [Pages XML sample](https://learn.microsoft.com/en-us/openspecs/sharepoint_protocols/ms-vsdx/6b73fe7e-68a4-4f26-846a-891950e0329e)
- [MS-VSDX Page XML Part](https://learn.microsoft.com/en-us/openspecs/sharepoint_protocols/ms-vsdx/1f15c8f0-6565-465c-aefd-2be6af545e8a) and [Page XML sample](https://learn.microsoft.com/en-us/openspecs/sharepoint_protocols/ms-vsdx/dccbb4b5-ca0c-43ef-9379-00c1acb54377)
- [ShapeSheet_Type](https://learn.microsoft.com/en-us/openspecs/sharepoint_protocols/ms-vsdx/5d6be8d6-1cab-4722-ba32-d73febc4e51d) and [Page_Type](https://learn.microsoft.com/en-us/openspecs/sharepoint_protocols/ms-vsdx/27e583c3-0ef3-4d7c-8fac-e37bd18d9dc2)
- [Text_Type](https://learn.microsoft.com/en-us/openspecs/sharepoint_protocols/ms-vsdx/3031da58-e11e-460b-9df5-9cfb6bc0a836) and [fld_Type](https://learn.microsoft.com/en-us/openspecs/sharepoint_protocols/ms-vsdx/fa12e060-338c-4c99-8d41-571ed75eade8)
