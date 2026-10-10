import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Hostile HTML inputs: deep and unclosed nesting, executable content, entity floods.
const html = new URL('../../hostile/html/', import.meta.url);
await mkdir(html, { recursive: true });
await writeFile(new URL('deep-div-100000.html', html), `<!doctype html>${'<div>'.repeat(100_000)}end\n`);
await writeFile(new URL('unclosed-mixed-50000.html', html), `<!doctype html>${'<p><li><td><b><span>x'.repeat(10_000)}\n`);
await writeFile(
  new URL('script-and-handlers.html', html),
  '<!doctype html><body onload="steal()"><script>document.write("SECRET")</script><style>p{}</style>' +
    '<noscript>NOSCRIPT</noscript><template>TEMPLATE</template><!-- COMMENT --><p>visible</p>' +
    '<script>never closed SECRET\n',
);
await writeFile(new URL('entity-flood.html', html), `<!doctype html><p>${'&amp;&#x1F600;&bogus;&'.repeat(20_000)}</p>\n`);
