import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

const SCHEMA = 'docsluice-quality-truth-v1';
const MAX_TRUTH_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_TABLES = 1_000;
const MAX_CELLS = 100_000;
const MAX_TEXT_BLOCKS = 100_000;
const MAX_ORDER_ENTRIES = MAX_CELLS + MAX_TEXT_BLOCKS;
const FORMATS = new Set(['doc', 'docx', 'xlsx', 'pptx', 'pdf']);
const METADATA_KEYS = ['schema', 'source', 'sourceSha256', 'format', 'reviewStatus'];

function fail(message) {
  throw new TypeError(`Invalid quality truth: ${message}`);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys, description) {
  if (!isRecord(value)) fail(`${description} must be an object.`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail(`${description} has unknown or missing fields.`);
  }
}

function nonnegativeInteger(value, description) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${description} must be a nonnegative safe integer.`);
}

function parseMetadata(lines) {
  const metadata = Object.create(null);
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) fail('metadata line is malformed.');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (!METADATA_KEYS.includes(key) || Object.hasOwn(metadata, key))
      fail('metadata has unknown or duplicate keys.');
    metadata[key] = value;
  }
  if (Object.keys(metadata).length !== METADATA_KEYS.length) fail('metadata is incomplete.');
  if (metadata.schema !== SCHEMA) fail('unsupported schema version.');
  const sourceSegments = metadata.source.split('/');
  if (
    !/^[\w./-]+$/.test(metadata.source) ||
    sourceSegments[0] !== 'corpus' ||
    sourceSegments.length < 2 ||
    sourceSegments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..') ||
    metadata.source.includes('\\')
  ) {
    fail('source path must be a repository-relative corpus path without traversal.');
  }
  if (!/^[a-f0-9]{64}$/.test(metadata.sourceSha256)) fail('sourceSha256 must be a lowercase SHA-256 digest.');
  if (!FORMATS.has(metadata.format)) fail('format is unsupported.');
  if (metadata.reviewStatus !== 'pending' && metadata.reviewStatus !== 'reviewed') {
    fail('reviewStatus must be pending or reviewed.');
  }
  return metadata;
}

function parseSections(body) {
  const lines = body.split('\n');
  let cursor = 0;
  const sections = [];
  for (const heading of ['## Text blocks', '## Tables', '## Reading order']) {
    while (lines[cursor] === '') cursor++;
    if (lines[cursor++] !== heading) fail(`expected ${heading}.`);
    while (lines[cursor] === '') cursor++;
    if (lines[cursor++] !== '```json') fail(`${heading} must contain one JSON code block.`);
    const jsonLines = [];
    while (cursor < lines.length && lines[cursor] !== '```') jsonLines.push(lines[cursor++]);
    if (lines[cursor++] !== '```') fail(`${heading} JSON code block is not closed.`);
    try {
      sections.push(JSON.parse(jsonLines.join('\n')));
    } catch {
      fail(`${heading} contains invalid JSON.`);
    }
  }
  while (lines[cursor] === '') cursor++;
  if (cursor !== lines.length) fail('content appears outside the defined sections.');
  return sections;
}

function validateContent([textBlocks, tables, readingOrder]) {
  if (
    !Array.isArray(textBlocks) ||
    textBlocks.length > MAX_TEXT_BLOCKS ||
    textBlocks.some((text) => typeof text !== 'string')
  ) {
    fail('text blocks must be a bounded array of strings.');
  }
  if (!Array.isArray(tables) || tables.length > MAX_TABLES) fail('tables must be a bounded array.');
  const tableIndexes = new Set();
  const cellReferences = new Set();
  let cellCount = 0;
  for (let ordinal = 0; ordinal < tables.length; ordinal++) {
    const table = tables[ordinal];
    exactKeys(table, ['index', 'cells'], 'table');
    nonnegativeInteger(table.index, 'table index');
    if (table.index !== ordinal || tableIndexes.has(table.index)) {
      fail('table indexes must be unique, contiguous, and ordered from zero.');
    }
    tableIndexes.add(table.index);
    if (!Array.isArray(table.cells)) fail('table cells must be an array.');
    for (const cell of table.cells) {
      exactKeys(cell, ['row', 'column', 'text'], 'table cell');
      nonnegativeInteger(cell.row, 'table cell row');
      nonnegativeInteger(cell.column, 'table cell column');
      if (typeof cell.text !== 'string') fail('table cell text must be a string.');
      const reference = `${table.index}:${cell.row}:${cell.column}`;
      if (cellReferences.has(reference)) fail('table cell coordinates must be unique.');
      cellReferences.add(reference);
      if (++cellCount > MAX_CELLS) fail('table cell count exceeds the bound.');
    }
  }
  if (!Array.isArray(readingOrder) || readingOrder.length > MAX_ORDER_ENTRIES) {
    fail('reading order must be a bounded array.');
  }
  const textReferences = new Set();
  const orderedCells = new Set();
  for (const reference of readingOrder) {
    if (!isRecord(reference) || typeof reference.kind !== 'string') fail('reading-order entry is malformed.');
    if (reference.kind === 'text') {
      exactKeys(reference, ['kind', 'index'], 'text reading-order entry');
      nonnegativeInteger(reference.index, 'text reading-order index');
      if (reference.index >= textBlocks.length || textReferences.has(reference.index)) {
        fail('reading order has a missing or duplicate text reference.');
      }
      textReferences.add(reference.index);
    } else if (reference.kind === 'cell') {
      exactKeys(reference, ['kind', 'table', 'row', 'column'], 'cell reading-order entry');
      nonnegativeInteger(reference.table, 'reading-order table index');
      nonnegativeInteger(reference.row, 'reading-order cell row');
      nonnegativeInteger(reference.column, 'reading-order cell column');
      const coordinate = `${reference.table}:${reference.row}:${reference.column}`;
      if (!cellReferences.has(coordinate) || orderedCells.has(coordinate)) {
        fail('reading order has a missing or duplicate cell reference.');
      }
      orderedCells.add(coordinate);
    } else fail('reading-order kind must be text or cell.');
  }
  if (textReferences.size !== textBlocks.length || orderedCells.size !== cellReferences.size) {
    fail('reading order must reference every text block and table cell exactly once.');
  }
  return { textBlocks, tables, readingOrder };
}

export function parseTruthMarkdown(markdown) {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown, 'utf8') > MAX_TRUTH_BYTES) {
    fail('file must be a bounded UTF-8 Markdown string.');
  }
  const frontmatterEnd = markdown.indexOf('\n---\n', 4);
  if (!markdown.startsWith('---\n') || frontmatterEnd < 0) fail('YAML-style metadata fence is missing.');
  const metadata = parseMetadata(markdown.slice(4, frontmatterEnd).split('\n'));
  const body = markdown.slice(frontmatterEnd + 5);
  const content = validateContent(parseSections(body));
  return { ...metadata, ...content };
}

function assertInside(parent, candidate, description) {
  const path = relative(parent, candidate);
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    fail(`${description} is outside its allowed directory.`);
  }
}

async function assertRegularPath(root, candidate, description) {
  const segments = relative(root, candidate).split(sep);
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = resolve(current, segments[index]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) fail(`${description} cannot contain symbolic links.`);
    if (index < segments.length - 1 && !stat.isDirectory())
      fail(`${description} parent must be a directory.`);
    if (index === segments.length - 1 && !stat.isFile()) fail(`${description} must be a regular file.`);
  }
}

export async function readTruthFile(truthPath, repositoryRoot) {
  const root = resolve(repositoryRoot);
  const truthRoot = resolve(root, 'corpus/package-a-truth');
  const resolvedTruth = resolve(truthPath);
  assertInside(truthRoot, resolvedTruth, 'truth file');
  if (!resolvedTruth.endsWith('.truth.md')) fail('truth file must end in .truth.md.');
  await assertRegularPath(truthRoot, resolvedTruth, 'truth file');
  const truthStat = await lstat(resolvedTruth);
  if (truthStat.size > MAX_TRUTH_BYTES) {
    fail('truth file must be a regular file no larger than 8 MiB.');
  }
  const markdownBytes = await readFile(resolvedTruth);
  let markdown;
  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(markdownBytes);
  } catch {
    fail('file must contain valid UTF-8.');
  }
  const parsed = parseTruthMarkdown(markdown);
  const sourcePath = resolve(root, parsed.source);
  assertInside(resolve(root, 'corpus'), sourcePath, 'source file');
  await assertRegularPath(root, sourcePath, 'source file');
  const sourceStat = await lstat(sourcePath);
  if (sourceStat.size > MAX_SOURCE_BYTES) fail('source file exceeds the 100 MiB size bound.');
  const sourceBytes = await readFile(sourcePath);
  const digest = createHash('sha256').update(sourceBytes).digest('hex');
  if (digest !== parsed.sourceSha256) fail('source SHA-256 does not match the truth metadata.');
  return { truth: parsed, truthPath: resolvedTruth, sourcePath, sourceBytes };
}
