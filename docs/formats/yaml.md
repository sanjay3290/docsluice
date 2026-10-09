# YAML

The dependency-free YAML reader recognizes simple block mappings and sequence-like scalar lines. It emits scalar values as paragraphs with dotted key paths in `loc.path`; values stay text. It never constructs objects keyed by source keys, resolves aliases, expands anchors, or executes tags. Mapping depth is charged to the shared block-depth budget; when a mapping exceeds the limit, its whole indented subtree is skipped until a sibling or ancestor resumes. Emitted text obeys `outputChars`.

This is not a YAML 1.2 parser. Flow collections, multiline scalars, complex keys, and full quoting/escape rules are not interpreted. Anchor and alias syntax is preserved inertly as scalar text.
