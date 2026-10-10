import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';

for (const engine of ['unpdf', 'legacy']) {
  const mf = new Miniflare({
    modules: true,
    script: readFileSync(`dist/${engine}.mjs`, 'utf8'),
    compatibilityDate: '2026-08-01',
    compatibilityFlags: ['nodejs_compat'],
    outboundService: () => new Response('network blocked by the spike', { status: 599 }),
  });
  try {
    const response = await mf.dispatchFetch('http://spike.test/');
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { result = { error: text.slice(0, 300) }; }
    const summary = result.results
      ? {
          version: result.version,
          calls: result.calls,
          items: result.results.reduce((sum, r) => sum + r.items, 0),
          positioned: result.results.reduce((sum, r) => sum + r.positioned, 0),
          hundredPagesMs: result.results.find((r) => r.name === 'text-100-pages.pdf')?.ms,
          errors: result.results.filter((r) => r.error).map((r) => `${r.name}: ${r.error.slice(0, 80)}`),
        }
      : result;
    console.log(JSON.stringify({ engine, runtime: 'workerd (miniflare)', ...summary }));
  } finally {
    await mf.dispose();
  }
}
