# OOXML hostile fixture recipe

`hostile/ooxml/extension-nested-records.zip` is original synthetic input authored for docsluice. It is generated without third-party document content by running:

```sh
node packages/docsluice/test/ooxml/fixtures/generate-extension-nested.mjs
```

The fixture has a nested relationship record with an external target and a nested content-type default. Only direct-child package records should affect relationship and content-type results. The ZIP is created with the repository's existing `fflate` dependency. The generated input is released under the repository MIT license; it contains no copied or personal content.
