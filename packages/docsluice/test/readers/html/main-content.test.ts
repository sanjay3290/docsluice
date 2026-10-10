import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extract } from '../../../src/core/extract.js';
import { toMarkdown } from '../../../src/render/markdown.js';
import { toText } from '../../../src/render/text.js';

const update =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UPDATE_GOLDEN ===
  '1';
const corpus = new URL('../../../../../corpus/html/main-content/', import.meta.url);
const hostile = new URL('../../../../../hostile/html/', import.meta.url);
const read = (base: URL, name: string) => new Uint8Array(readFileSync(new URL(name, base)));

// Ten written pages: text that must stay and page chrome that must go with mainContent (HTM-2).
const PAGES: Array<{ file: string; include: string[]; exclude: string[] }> = [
  {
    file: '01-blog-post.html',
    include: [
      'Counting anemones at low tide',
      'By the survey team',
      'We counted green anemones',
      'Each transect was walked twice',
      'Filed under ecology',
    ],
    exclude: ['Archive', 'Reader comment text', 'Popular posts', 'Copyright notice'],
  },
  {
    file: '02-news-article.html',
    include: [
      'Harbour reopens after the winter dredging works',
      'The inner harbour reopened',
      'Moorings will be reallocated',
    ],
    exclude: ['We use cookies', 'Related stories', 'invented newspaper', 'Sport'],
  },
  {
    file: '03-docs-sidebar.html',
    include: [
      'Configuring limits',
      'Every extraction runs under a budget',
      'limits: { cells: 10000 }',
      'the reader stops',
    ],
    exclude: ['Introduction', 'Guide'],
  },
  {
    file: '04-div-soup.html',
    include: [
      'Rules for plot holders',
      'Plots must be cultivated',
      'Bonfires are allowed',
      'Water butts are shared',
    ],
    exclude: ['Allotment Society', 'Seed swap', 'Registered allotment society'],
  },
  {
    file: '05-link-farm.html',
    include: ['Holiday opening hours', 'The central library closes at four', 'Returns can be posted'],
    exclude: ['Opening hours for every branch', 'Volunteer opportunities'],
  },
  {
    file: '06-recipe-ads.html',
    include: [
      'Barley and leek soup',
      '200 grams of pearl barley',
      'Soften the leeks',
      'Simmer for forty minutes',
    ],
    exclude: ['Advertisement', 'Sign up to our newsletter', 'Sponsored'],
  },
  {
    file: '07-listing-articles.html',
    include: ['Spring regatta results', 'The novice eight won', 'Thanks to the volunteers'],
    exclude: ['Boathouse open day', 'Subscriptions due', 'Rowing club'],
  },
  {
    file: '08-table-layout.html',
    include: ['Summer fete', 'The summer fete returns', 'Stalls are still available'],
    exclude: ['Hall hire', 'Services'],
  },
  {
    file: '09-hidden-and-dialog.html',
    include: ['Reading the tide tables', 'High and low water times', 'Spring tides follow'],
    exclude: ['Install our app', 'Hidden promotion', 'Decorative wave pattern', 'South'],
  },
  {
    file: '10-no-content.html',
    include: ['Service status', 'All systems normal.', 'Last checked at 09:00.'],
    exclude: [],
  },
];

describe('HTML main content (HTM-2)', () => {
  it.each(PAGES)('$file keeps its main text and drops the chrome', async ({ file, include, exclude }) => {
    const doc = await extract(read(corpus, file), { filename: file, mainContent: true });
    const text = toText(doc);
    for (const expected of include) expect(text, expected).toContain(expected);
    for (const unwanted of exclude) expect(text, unwanted).not.toContain(unwanted);
    // Without the option the whole page is read.
    const whole = toText(await extract(read(corpus, file), { filename: file }));
    for (const unwanted of exclude) expect(whole, unwanted).toContain(unwanted);
    // Reviewed sidecar golden of the main-content output.
    const golden = new URL(`${file}.main-content.expected.md`, corpus);
    const markdown = toMarkdown(doc);
    if (update) writeFileSync(golden, markdown);
    else {
      expect(existsSync(golden), `${file} has no main-content golden`).toBe(true);
      expect(markdown).toBe(readFileSync(golden, 'utf8'));
    }
  });

  it('is deterministic and leaves email HTML whole', async () => {
    const page = read(corpus, '04-div-soup.html');
    const first = toMarkdown(await extract(page, { mainContent: true }));
    expect(toMarkdown(await extract(page, { mainContent: true }))).toBe(first);
    const eml = new TextEncoder().encode(
      'From: a@example.invalid\r\nContent-Type: text/html\r\n\r\n<nav>MENU</nav><main><p>Body text of the message.</p></main>',
    );
    expect(toText(await extract(eml, { mainContent: true }))).toContain('MENU');
  });

  it('keeps an article header inside main and drops page-level headers, landmarks by role and hints', async () => {
    const html = new TextEncoder().encode(
      '<!doctype html><header>SITE</header><div role="navigation">ROLE NAV</div><main><article><header><h1>Title</h1></header><p>Body.</p><footer>Byline</footer></article><div class="share-buttons">SHARE</div><div class="unavailable-note">Kept note.</div></main>',
    );
    const text = toText(await extract(html, { mainContent: true }));
    expect(text).toContain('Title');
    expect(text).toContain('Byline');
    expect(text).toContain('Kept note.');
    for (const unwanted of ['SITE', 'ROLE NAV', 'SHARE']) expect(text).not.toContain(unwanted);
  });

  it('selects the scored container in a page without landmarks or paragraphs inside chrome', async () => {
    const long = 'A sentence long enough to count as a paragraph of content.';
    const html = new TextEncoder().encode(
      `<!doctype html><div class="sidebar"><p>${long} SIDEBAR</p><p>${long}</p><p>${long}</p></div><div class="article-text"><p>${long} MAIN</p></div>`,
    );
    const text = toText(await extract(html, { mainContent: true }));
    expect(text).toContain('MAIN');
    expect(text).not.toContain('SIDEBAR');
  });

  it.each(['deep-div-100000.html', 'unclosed-mixed-50000.html', 'entity-flood.html'])(
    'stays bounded on hostile %s',
    async (name) => {
      const started = performance.now();
      const doc = await extract(read(hostile, name), { filename: name, mainContent: true });
      expect(doc.format).toBe('html');
      expect(performance.now() - started).toBeLessThan(5_000);
    },
  );
});
