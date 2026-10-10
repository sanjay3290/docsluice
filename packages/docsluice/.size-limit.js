// Bundle budgets (RT-5). Office readers load lazily, so the core check treats them as external.
const OFFICE_READERS = ['doc', 'docx'];
const officeReader = new RegExp(`/(?:${OFFICE_READERS.join('|')})\\.js$`);

export default [
  {
    name: 'core and text formats',
    path: 'dist/index.js',
    limit: '50 KB',
    gzip: true,
    modifyRolldownConfig: (config) => ({
      ...config,
      external: (id, importer) => importer !== undefined && officeReader.test(id),
    }),
  },
  ...OFFICE_READERS.map((reader) => ({
    name: `${reader} reader`,
    path: `dist/${reader}.js`,
    limit: '40 KB',
    gzip: true,
  })),
];
