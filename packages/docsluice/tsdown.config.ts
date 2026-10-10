import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'node/index': 'src/node/index.ts',
    doc: 'src/readers/doc/index.ts',
    txt: 'src/readers/txt/index.ts',
    markdown: 'src/readers/markdown/index.ts',
    csv: 'src/readers/csv/index.ts',
    tsv: 'src/readers/tsv/index.ts',
    json: 'src/readers/json/index.ts',
    xml: 'src/readers/xml/index.ts',
    html: 'src/readers/html/index.ts',
  },
  format: ['esm', 'cjs'],
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
});
