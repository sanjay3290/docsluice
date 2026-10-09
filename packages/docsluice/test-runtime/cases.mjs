import { Budget, DEFAULT_LIMITS, openZip, parseXml, WarningSink } from '../dist/index.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function xmlContext() {
  const warnings = new WarningSink();
  return { warnings, budget: new Budget(DEFAULT_LIMITS, { warnings }) };
}

/** Run runtime-neutral checks against the installed/built public package entry. */
export async function runRuntimeContract({ validZip, traversalZip, hostileXml }) {
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
}
