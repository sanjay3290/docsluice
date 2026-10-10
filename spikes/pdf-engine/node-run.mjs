import { readFileSync, readdirSync } from 'node:fs';
import { run } from './spike.mjs';
const engine = process.argv[2];
const files = readdirSync(new URL('./files/', import.meta.url)).filter((f) => f.endsWith('.pdf')).sort().map((name) => ({ name, bytes: new Uint8Array(readFileSync(new URL(`./files/${name}`, import.meta.url))) }));
const loaders = {
  unpdf: () => import('unpdf/pdfjs'),
  legacy: async () => {
    // In-thread "fake worker": provide the worker module so no Worker is started.
    globalThis.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    return import('pdfjs-dist/legacy/build/pdf.mjs');
  },
};
const report = await run(engine, files, loaders);
console.log(JSON.stringify({ runtime: typeof Bun !== 'undefined' ? `bun ${Bun.version}` : typeof Deno !== 'undefined' ? `deno ${Deno.version.deno}` : `node ${process.version}`, ...report }));
