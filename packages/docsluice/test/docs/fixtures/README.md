This private recipe-test fixture is a byte-for-byte copy of the CC0 legacy DOC
input at `corpus/doc/doc-legacy.doc` in accepted dependency commit
`a3b45f12429216d72fb3cb3e21955d5947b38c0d`. Its adjacent license records the
LibreOffice source. Keeping it next to the tests makes recipe verification
independent of shared corpus integration order; it does not register a corpus
entry or change any extraction expected output.
