# PPTX corpus

`pptx-lo-edge-cases.pptx` is a LibreOfficeDev 26.8 re-save of the self-authored source package in `src/`. The deterministic Python standard-library recipe rebuilds the source; LibreOffice writes the committed corpus file:

```sh
mkdir -p /tmp/docsluice-pptx-source /tmp/docsluice-pptx-lo
python3 corpus/pptx/src/generate_pptx_fixtures.py --out-dir /tmp/docsluice-pptx-source
soffice --headless --convert-to pptx --outdir /tmp/docsluice-pptx-lo /tmp/docsluice-pptx-source/pptx-edge-cases.pptx
cp /tmp/docsluice-pptx-lo/pptx-edge-cases.pptx corpus/pptx/pptx-lo-edge-cases.pptx
```

The `.expected.json` sidecar is a reviewed direct-reader result, compared in `packages/docsluice/test/readers/pptx/reader.test.ts`. Its 12 sections were checked against the LibreOffice-resaved package in presentation order; the first two title placeholders, reading-order examples, inherited placeholder, transformed group, table cells, and remaining slide labels were checked individually. LibreOffice drops the source SmartArt, so SmartArt remains covered by the synthetic unit fixture instead. This is not a public extraction-pipeline golden; reader registry and QA-1/QA-2 integration are maintained by the root task.
