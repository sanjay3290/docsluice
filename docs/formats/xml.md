# XML

The XML module is a non-validating, hand-written tokenizer shared by format readers. It accepts `string` or `Uint8Array` input and uses the caller's `Budget` and `WarningSink` through `XmlContext`.

```ts
import { Budget, DEFAULT_LIMITS, WarningSink, parseXml } from 'docsluice';

const warnings = new WarningSink();
const budget = new Budget(DEFAULT_LIMITS, { warnings });
const element = parseXml(bytes, { budget, warnings, path: 'word/document.xml' });
```

`scanXml` reports `onOpen(name, attrs, info)`, `onText(text)` and `onClose(name, info)` events. Attributes are a `Map`; `info` contains the original qualified name, local name and the element namespace URI. `parseXml` uses those events to build a small mixed-content tree with an explicit stack. It returns the first root element or `undefined` when no element is present. Both element trees and event output obey the shared XML depth limit and are checked against the remaining output-character allowance. Parsing checks staged XML text without charging it to the shared output counter; the reader charges characters when it emits them through the builder.

The parser skips processing instructions and comments, exposes CDATA as text, and skips each `DOCTYPE` declaration with a bracket- and quote-aware scan. DTD declarations, external entities and processing instructions are never evaluated. Only `lt`, `gt`, `amp`, `quot`, `apos` and numeric character references are decoded. Unknown entities remain literal and produce one `UNKNOWN_ENTITY` warning. Unsupported declared encodings use UTF-8 and produce `ENCODING_GUESSED`; UTF-8 and UTF-16 are supported.

Malformed parts are recovered when possible and produce `UNREADABLE_PART`. Hitting the configured XML depth or output limit is handled through the shared budget policy.

The generic XML reader reuses `parseXml`. It emits one paragraph for each element that has non-whitespace direct text; text inside child elements is emitted for those child elements separately. Attributes are skipped. Locations use local element names under a leading slash (for example `/root/child[2]/name`); a one-based index is added only when a same-named element repeats among the same parent's children. A child document prefixes the path with its child path and `#`. Namespace declarations and other attributes never become text blocks.

The scanner follows the relevant XML syntax and namespace scoping rules in the [W3C XML 1.0 Recommendation](https://www.w3.org/TR/xml/) and [Namespaces in XML 1.0](https://www.w3.org/TR/xml-names/), with entity processing intentionally restricted for safety.
