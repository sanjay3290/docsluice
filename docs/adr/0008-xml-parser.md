# 0008. Own non-validating XML tokenizer

- Status: Accepted
- Date: 2026-10-09
- Requirement IDs: SEC-4, SEC-5, SEC-7, SEC-8, XML-1, EXT-6

## Context

Every Office and ODF format is XML inside a zip. SEC-4 needs DTDs, external entities and processing instructions off with no switch to turn them on. General XML libraries have such switches, and some use regular expressions on input.

## Decision

Write one XML tokenizer in `src/xml/`:

- Hand-written character scanner. No regular expressions on input.
- Recognises only the five built-in entities and numeric character references. A `<!DOCTYPE` is skipped and reported, never processed. Processing instructions are skipped.
- Streaming (SAX-style) events plus a small helper that builds a light element tree for small parts. Element depth and text size are checked against the budget.
- Namespaces resolved by prefix lookup with `Map`.
- Exported as `parseXml` for plugins (EXT-6).

## Consequences

- No XML dependency. The XML module needs 100% line coverage and its own fuzz target.
