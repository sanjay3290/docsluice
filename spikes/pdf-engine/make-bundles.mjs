import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { rolldown } from 'rolldown';

const files = readdirSync('files').filter((f) => f.endsWith('.pdf')).sort();
writeFileSync(
  'files.generated.mjs',
  `export const FILES = ${JSON.stringify(files.map((name) => ({ name, base64: readFileSync(`files/${name}`).toString('base64') })))};\n`,
);
for (const engine of ['unpdf', 'legacy']) {
  const load =
    engine === 'unpdf'
      ? `() => import('unpdf/pdfjs')`
      : `async () => { globalThis.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs'); return import('pdfjs-dist/legacy/build/pdf.mjs'); }`;
  writeFileSync(
    `entry-${engine}.mjs`,
    `import { run } from './spike.mjs';\nimport { FILES } from './files.generated.mjs';\n` +
      `const decode = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));\n` +
      `export async function spike() { return run('${engine}', FILES.map((f) => ({ name: f.name, bytes: decode(f.base64) })), { '${engine}': ${load} }); }\n` +
      `export default { async fetch() { return new Response(JSON.stringify(await spike()), { headers: { 'content-type': 'application/json' } }); } };\n`,
  );
  const bundle = await rolldown({ input: `entry-${engine}.mjs`, logLevel: 'silent', platform: 'browser' });
  await bundle.write({ file: `dist/${engine}.mjs`, format: 'esm', codeSplitting: false });
  await bundle.close();
  // Engine-only size: what a PDF subpath would add (no fixtures), minified and gzipped.
  writeFileSync(`size-${engine}.mjs`, `export const load = ${load};\n`);
  const sizeBundle = await rolldown({ input: `size-${engine}.mjs`, logLevel: 'silent', platform: 'browser' });
  const { output } = await sizeBundle.generate({ format: 'esm', minify: true, codeSplitting: false });
  await sizeBundle.close();
  const code = output.filter((item) => item.type === 'chunk').map((item) => item.code).join('');
  console.log(engine, 'engine bundle', (code.length / 1024).toFixed(0), 'KB raw,', (gzipSync(code).length / 1024).toFixed(0), 'KB gzipped');
}
