# Independent review: PDF engine ADR local results

Reviewed `docs/adr/0009-pdf-engine.md` from package E #44 commit
`6a0c00b46804aea4dac46ae82364642349783050`. The evidence is presented with
appropriate limits and does not overstate readiness. No blocking issue found
in the ADR-only change.

The runtime table distinguishes local results from the complete CI matrix and
hosted Workers deployment. The text-position result correctly calls out the
need for raw `getTextContent()` items because the convenience wrapper omits
transforms. Security observations are described as instrumented API-path
checks, with explicit limits for untested malformed/font/action cases and
workerd static initialization. The bundle sizes are identified as throwaway
engine-entry measurements rather than the production subpath/core bundle.
The synthetic timing comparison avoids claiming PERF-1 acceptance. The license
paragraph does not imply the whole bundle is MIT-only and leaves PDF.js
NOTICE handling open.

The ADR remains **Proposed**, and explicitly leaves the following gates open:
the full #23 CI matrix; production subpath and lazy-import checks; bundled
license/NOTICE review; missing asset/action/security cases; and separate
integration in #45. The package E layout probe further confirms that engine
compatibility is not reading-order acceptance: its post-delta authored phrase
spot check reaches 8/10 fully ordered pages, with two table pages still in
column order instead of the authored row order. This is consistent with the
ADR's statement that the private reading-order layer remains necessary.

No ADR edits or runtime tests were made during this review. The recorded
evidence is suitable as local spike input, not as grounds to accept the ADR or
add the candidate dependency before its stated gates are resolved.
