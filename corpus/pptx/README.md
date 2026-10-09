# PPTX corpus

`pptx-lo-edge-cases.pptx` is a LibreOfficeDev 26.8 re-save of the self-authored source package in `src/`. The deterministic Python standard-library recipe rebuilds the source; LibreOffice writes the committed corpus file:

```sh
mkdir -p /tmp/docsluice-pptx-source /tmp/docsluice-pptx-lo
python3 corpus/pptx/src/generate_pptx_fixtures.py --out-dir /tmp/docsluice-pptx-source
soffice --headless --convert-to pptx --outdir /tmp/docsluice-pptx-lo /tmp/docsluice-pptx-source/pptx-edge-cases.pptx
cp /tmp/docsluice-pptx-lo/pptx-edge-cases.pptx corpus/pptx/pptx-lo-edge-cases.pptx
```

The `.expected.json` sidecar is a reviewed direct-reader result, compared in
`packages/docsluice/test/readers/pptx/reader.test.ts`. Its 12 sections were
checked against the LibreOffice-resaved package in presentation order: title
placeholders, reading-order examples, inherited placeholder, transformed
group, table cells, labels, and cached bar/line/pie tables were checked
individually. The three chart caches preserve category/value indexes 0 and 2,
producing one blank middle row. LibreOffice drops the source SmartArt, which
remains covered by a synthetic unit fixture. Notes-slide 4 and 5 body
paragraphs were checked individually; slide-number placeholder text is
excluded. The output records both notes and the hidden-slide warning. This
remains a direct-reader comparison; public registration and QA-1/QA-2
integration are maintained by the root task.
