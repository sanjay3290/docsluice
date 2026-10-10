import {
  Budget,
  DEFAULT_LIMITS,
  extract,
  openZip,
  parseXml,
  toMarkdown,
  toText,
  WarningSink,
} from '../dist/index.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function xmlContext() {
  const warnings = new WarningSink();
  return { warnings, budget: new Budget(DEFAULT_LIMITS, { warnings }) };
}

/** Run runtime-neutral checks against the installed/built public package entry. */
export async function runRuntimeContract({ validZip, traversalZip, hostileXml, csv, html, hostileHtml }) {
  const validArchive = openZip(validZip, new Budget(DEFAULT_LIMITS));
  assert(validArchive.entries.length > 0, 'valid ZIP should expose entries');
  const contentXml = validArchive.entries.find((entry) => entry.name === 'content.xml');
  assert(contentXml, 'real ODT ZIP should contain content.xml');
  const xmlBytes = await validArchive.read(contentXml);
  assert(xmlBytes instanceof Uint8Array, 'real ODT XML entry should read as Uint8Array');

  const traversal = openZip(traversalZip, new Budget(DEFAULT_LIMITS));
  assert(traversal.entries[0]?.name === 'etc/passwd', 'ZIP traversal names should be cleaned');

  const validXml = parseXml(xmlBytes, xmlContext());
  assert(validXml?.name === 'office:document-content', 'real ODT XML should parse');

  const hostileContext = xmlContext();
  const hostile = parseXml(hostileXml, hostileContext);
  assert(hostile?.name, 'hostile XML should remain parseable');
  const codes = hostileContext.warnings.warnings.map(({ code }) => code);
  assert(codes.includes('DTD_IGNORED'), 'external declarations should be ignored');
  assert(codes.includes('UNKNOWN_ENTITY'), 'external entity references should remain unresolved');
  const pending = [hostile];
  let text = '';
  while (pending.length > 0) {
    const current = pending.pop();
    for (const child of current.children) {
      if (typeof child === 'string') text += child;
      else pending.push(child);
    }
  }
  assert(text === '&e;', 'external entity content must not be expanded');

  // Full extraction loads each reader with a lazy import() in this runtime.
  const table = await extract(csv, { filename: 'data.csv' });
  assert(table.format === 'csv', 'CSV should be detected');
  const rows = table.blocks[0]?.kind === 'table' ? table.blocks[0].rows : [];
  assert(rows.length === 4 && rows[2]?.[1]?.text === 'two lines\nsecond line', 'CSV quoting should survive');

  const page = await extract(html, { filename: 'post.html' });
  assert(page.format === 'html', 'HTML should be detected');
  assert(
    toMarkdown(page).includes('\n# Notes from the north garden\n'),
    'HTML headings should render as Markdown headings',
  );

  const hostilePage = await extract(hostileHtml, { filename: 'hostile.html' });
  assert(hostilePage.features.hasJavaScript, 'scripts should be reported');
  assert(
    toText(hostilePage) === 'visible',
    'script, style, noscript, template and comment text must be dropped',
  );
}
