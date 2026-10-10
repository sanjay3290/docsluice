// Bundle budgets (RT-4, RT-5). Every reader subpath in package.json "exports" gets an entry, so a
// new reader cannot ship without a budget. Readers load lazily, so the core check treats the
// Office, RTF, email, EPUB and archive readers as external (RT-5 budgets core plus text formats); text readers count
// toward the core budget too.
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const NOT_READERS = new Set(['.', './node', './worker', './package.json']);
export const READERS = Object.keys(manifest.exports)
  .filter((subpath) => !NOT_READERS.has(subpath))
  .map((subpath) => subpath.slice(2));
const OFFICE_READERS = new Set(['doc', 'docx', 'xlsx', 'xls', 'pptx', 'odt', 'ods', 'odp']);
const EXTERNAL_READERS = [...OFFICE_READERS, 'eml', 'msg', 'rtf', 'epub', 'gzip', 'tar'];
const externalReader = new RegExp(`/(?:${EXTERNAL_READERS.join('|')})\\.js$`);

export default [
  {
    name: 'core and text formats',
    path: 'dist/index.js',
    limit: '50 KB',
    gzip: true,
    modifyRolldownConfig: (config) => ({
      ...config,
      external: (id, importer) => importer !== undefined && externalReader.test(id),
    }),
  },
  {
    // The worker pool alone; the thread entry loads the core in its own isolate.
    name: 'worker pool (Node)',
    path: 'dist/worker.js',
    limit: '10 KB',
    gzip: true,
    modifyRolldownConfig: (config) => ({ ...config, external: (id) => id.startsWith('node:') }),
  },
  ...READERS.map((reader) => ({
    name: `${reader} reader`,
    path: `dist/${reader}.js`,
    limit: OFFICE_READERS.has(reader) ? '40 KB' : '25 KB',
    gzip: true,
  })),
];
