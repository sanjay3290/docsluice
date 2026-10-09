# ADR proposal: 7z and RAR stay outside the core

**Status: Proposed only — not accepted.** No repository ADR was changed. Applies to PRD §8.1 Archives (P2/plugin), ADR 0003 clean-room rules, ADR 0004 packaging, ADR 0011 dependency allow-list, and issue #86. The proposal assumes #41 has supplied the versioned plugin contract; it does not bypass that blocker.

## Context and evidence

Core currently prioritizes ZIP/GZIP/TAR. ADR 0004 keeps built-in readers in the lazy `docsluice` package; ADR 0011 requires a separately accepted ADR for every new core runtime dependency. Therefore “plugin-only” here means optional registered code outside the core package; whether docsluice publishes first-party plugin packages requires a packaging decision/amendment to ADR 0004.

7-Zip documents that 7z supports compressed archive headers and that LZMA is its default compression method ([7z format](https://www.7-zip.org/7z.html)). An encoded header must be decoded before an entry listing is available. The LZMA SDK page states public-domain licensing, but that does not establish implementation size, safe dictionary bounds, or maintenance cost ([LZMA SDK](https://www.7-zip.org/sdk.html)).

RARLAB publishes a RAR 5 structural note, but says detailed algorithms and data structures require the UnRAR source ([RAR 5.0 format note](https://www.rarlab.com/technote.htm)). The Library of Congress describes the full RAR specification as not publicly available ([RAR 5 format record](https://www.loc.gov/preservation/digital/formats/fdd/fdd000460.shtml)). RARLAB's license bars using or reverse-engineering UnRAR code to recreate RAR compression ([license](https://www.rarlab.com/license.htm)). These sources support a narrow, clean-room structural investigation, not a legal conclusion that an implementation is cleared.

## Decision proposed

1. **Keep both 7z and RAR out of `docsluice` core.** No dependency, codec, or reader code enters the core package under this proposal. This protects ADR 0004's lazy/bundle goals and ADR 0011's dependency boundary.
2. **7z: optional plugin, listing-only after a decoder feasibility gate.** Listing must handle encoded headers. Before committing to support, implement a throwaway, independently authored LZMA header-decoder probe from public format material, with an explicit maximum dictionary and bounded output. Measure minified/gzipped plugin size, peak working memory, and time on a small corpus. If limits cannot be enforced before allocation, or the decoder is too large/fragile, defer 7z rather than return an empty listing for encoded headers. Do not copy LZMA SDK source into docsluice under this proposal.
3. **RAR: defer a shipping reader; permit a scoped header-listing spike only.** Use published structural descriptions and original test vectors. Do not use UnRAR source, binaries, or derived parser code. Ship only after a source-completeness and legal review approves the exact supported RAR generations and metadata subset. Never decompress payloads or recreate RAR compression. If the published material cannot describe a supported header safely, return unsupported and stop.
4. Any future plugin must use #41 registration and shared `Budget`, path normalization, and warning/error rules. It reads metadata only; it does not unpack to disk, follow links, decrypt, or fetch. No new runtime dependency is approved here. A dependency or first-party package needs its own size, licence, maintenance, install-script, and packaging review.

## Minimal acceptance tests if authorized

- **RAR structural spike:** generated, licensed RAR5 vectors for a stored member, a compressed member (listing must not decode its payload), Unicode name, directory/link, encrypted headers, split volume, malformed/overflowing variable-length integers, and truncated/checksum-invalid headers. Assert stable names/sizes/order, safe relative paths, explicit encrypted/unsupported statuses, and that member bytes are never returned. Also test every length/count/loop against the shared budget. Do not call an UnRAR-based oracle in the implementation path.
- **7z plugin gate:** unencoded and encoded-header fixtures, encrypted headers, unknown coder, extreme dictionary declaration, solid archive, multi-volume marker, malformed next-header offset/CRC, and header bomb. Assert encoded-header cases are either safely listed by the gated decoder or explicitly unsupported—never silently empty.

## Consequences and open items

No core size increase or dependency change is proposed. Listing-only leaves file contents inaccessible by design. The 7z probe has no measured size or memory data yet; the RAR note is incomplete for full format coverage and warrants legal review. #41 is a hard prerequisite; first-party plugin packaging may require an ADR update to 0004. No formats are implemented or accepted by this draft.
