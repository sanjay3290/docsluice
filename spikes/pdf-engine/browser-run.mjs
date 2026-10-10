import { readFileSync } from 'node:fs';
import { chromium } from '/home/user/docsluice/node_modules/playwright/index.mjs';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const engine of ['unpdf', 'legacy']) {
  const page = await browser.newPage();
  const violations = [];
  const consoleLines = [];
  const requests = [];
  page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text().slice(0, 120)}`));
  page.on('request', (request) => requests.push(request.url()));
  await page.route('http://spike.test/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({
        contentType: 'text/html',
        // No 'unsafe-eval': any eval or new Function throws and reports a violation.
        headers: { 'content-security-policy': "default-src 'self'; script-src 'self'" },
        body: `<!doctype html><script type="module" src="/run.mjs"></script>`,
      });
    }
    if (url.pathname === '/run.mjs') {
      return route.fulfill({
        contentType: 'text/javascript',
        body: `import { spike } from '/bundle.mjs';\ndocument.addEventListener('securitypolicyviolation', (e) => { (window.__violations ??= []).push(e.violatedDirective); });\nspike().then((r) => { r.violations = window.__violations ?? []; console.log('RESULT ' + JSON.stringify(r)); }, (e) => { console.log('RESULT ' + JSON.stringify({ error: String(e) })); });`,
      });
    }
    if (url.pathname === '/bundle.mjs') {
      return route.fulfill({ contentType: 'text/javascript', body: readFileSync(`dist/${engine}.mjs`, 'utf8') });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  const done = new Promise((resolve) => {
    page.on('console', (message) => {
      if (message.text().startsWith('RESULT ')) resolve(JSON.parse(message.text().slice(7)));
    });
  });
  await page.goto('http://spike.test/');
  const result = await done;
  const pageViolations = result.violations ?? [];
  const userAgent = browser.version();
  const summary = result.results
    ? {
        items: result.results.reduce((sum, r) => sum + r.items, 0),
        positioned: result.results.reduce((sum, r) => sum + r.positioned, 0),
        hundredPagesMs: result.results.find((r) => r.name === 'text-100-pages.pdf')?.ms,
        errors: result.results.filter((r) => r.error).map((r) => `${r.name}: ${r.error.slice(0, 60)}`),
      }
    : result;
  console.log(JSON.stringify({ engine, browser: `Chromium ${userAgent}`, version: result.version, calls: result.calls, cspViolations: pageViolations, extraRequests: requests.filter((u) => !u.startsWith('http://spike.test/')), console: consoleLines.filter((line) => !line.includes('RESULT ')).slice(0, 5), ...summary }));
  await page.close();
}
await browser.close();
