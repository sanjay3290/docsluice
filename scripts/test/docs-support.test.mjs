import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkSupportMatrix,
  generateSupportMatrix,
  parseLicenseTags,
  parseRequirements,
} from '../docs-support.mjs';

const PRD = [
  '| ID | Requirement | Priority |',
  '|---|---|---|',
  '| CSV-1 | Guess the delimiter. | P0 |',
  '| SEC-1 | Zip bomb \\| ratio. | P0 |',
  '| QA-9 | Nobody tests this. | P0 |',
  '| EML-4 | Drop quoted replies. | P2 |',
  '',
].join('\n');

function fixtureRepo(files) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'docsluice-support-')));
  const write = (name, content) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  };
  write('docs/prd.md', PRD);
  write('docs/formats/csv.md', '# CSV\n');
  write(
    'packages/docsluice/package.json',
    JSON.stringify({
      exports: { '.': './dist/index.js', './csv': './dist/csv.js', './node': './dist/node.js' },
    }),
  );
  write(
    'hostile/manifest.json',
    JSON.stringify([
      { file: 'zip/bomb.zip', requirement: 'SEC-1' },
      { file: 'x', requirement: 'R2' },
    ]),
  );
  for (const [name, content] of Object.entries(files)) write(name, content);
  return root;
}

const license = (tags) =>
  `SPDX-License-Identifier: CC0-1.0\nSource: made for a test\nRequirements: ${tags}\n`;

test('parses requirement rows with their priority and keeps escaped pipes', () => {
  const requirements = parseRequirements(PRD);
  assert.deepEqual([...requirements.keys()], ['CSV-1', 'SEC-1', 'QA-9', 'EML-4']);
  assert.equal(requirements.get('EML-4').priority, 'P2');
  assert.throws(() => parseRequirements('no tables here'), /No requirement rows/);
  assert.throws(() => parseRequirements(`${PRD}| CSV-1 | again | P1 |\n`), /Duplicate requirement CSV-1/);
});

test('reads Requirements tags and rejects missing, empty, unknown and repeated tags', () => {
  const requirements = parseRequirements(PRD);
  assert.deepEqual(parseLicenseTags(license('CSV-1, SEC-1'), 'a.license', requirements), ['CSV-1', 'SEC-1']);
  assert.throws(
    () => parseLicenseTags('SPDX-License-Identifier: MIT\n', 'a.license', requirements),
    /exactly one/,
  );
  assert.throws(() => parseLicenseTags(license(' '), 'a.license', requirements), /empty/);
  assert.throws(() => parseLicenseTags(license('XYZ-1'), 'a.license', requirements), /not a PRD requirement/);
  assert.throws(() => parseLicenseTags(license('CSV-1, CSV-1'), 'a.license', requirements), /repeats/);
});

test('lists formats and P0 coverage from corpus tags and hostile entries', () => {
  const root = fixtureRepo({
    'corpus/csv/a.csv': 'a,b\n',
    'corpus/csv/a.csv.license': license('CSV-1'),
    'corpus/csv/a.csv.expected.json': '{}',
    'corpus/csv/a.csv.expected.md': '',
    'corpus/csv/b.csv': 'c;d\n',
    'corpus/csv/b.csv.license': license('CSV-1'),
    'corpus/pdf/x.pdf': '%PDF',
    'corpus/pdf/x.pdf.license': license('EML-4'),
    'corpus/README.md': '# Corpus\n',
  });
  try {
    const page = generateSupportMatrix(root);
    assert.match(page, /\| csv \| `docsluice\/csv` \| 2 \| 1 \| \[csv\.md\]\(csv\.md\) \|/);
    assert.match(page, /\| pdf \| no reader \| 1 \| 0 \| — \|/);
    assert.match(
      page,
      /\| CSV-1 \| Guess the delimiter\. \| `csv\/a\.csv`<br>`csv\/b\.csv \(no golden\)` \| — \|/,
    );
    assert.match(page, /\| SEC-1 \| Zip bomb \\\| ratio\. \| Not covered \| 1 \|/);
    assert.match(page, /\| QA-9 \| Nobody tests this\. \| Not covered \| — \|/);
    assert.doesNotMatch(page, /EML-4 \|/);
    assert.match(page, /2 of 3 P0 requirements/);
    assert.equal(generateSupportMatrix(root), page);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('fails for a reader without a format page or a corpus file without a license', () => {
  const missingPage = fixtureRepo({});
  rmSync(path.join(missingPage, 'docs/formats/csv.md'));
  try {
    assert.throws(() => generateSupportMatrix(missingPage), /csv reader has no docs\/formats\/csv\.md/);
  } finally {
    rmSync(missingPage, { recursive: true });
  }
  const missingLicense = fixtureRepo({ 'corpus/csv/a.csv': 'a\n' });
  try {
    assert.throws(() => generateSupportMatrix(missingLicense), /corpus\/csv\/a\.csv has no \.license/);
  } finally {
    rmSync(missingLicense, { recursive: true });
  }
});

test('counts an expected extraction error as a golden and excludes its sidecar', () => {
  const root = fixtureRepo({
    'corpus/csv/a.csv': 'damaged',
    'corpus/csv/a.csv.license': license('CSV-1'),
    'corpus/csv/a.csv.expected.error': 'CORRUPT_FILE',
  });
  try {
    const page = generateSupportMatrix(root);
    assert.match(page, /\| csv \| `docsluice\/csv` \| 1 \| 1 \|/);
    assert.doesNotMatch(page, /no golden/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('check mode compares the committed page', () => {
  const root = fixtureRepo({ 'corpus/csv/a.csv': 'a\n', 'corpus/csv/a.csv.license': license('CSV-1') });
  try {
    assert.equal(checkSupportMatrix(root), false);
    writeFileSync(path.join(root, 'docs/formats/support-matrix.md'), generateSupportMatrix(root));
    assert.equal(checkSupportMatrix(root), true);
    writeFileSync(path.join(root, 'docs/formats/support-matrix.md'), 'stale\n');
    assert.equal(checkSupportMatrix(root), false);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('the committed support matrix is current', () => {
  assert.equal(
    checkSupportMatrix(),
    true,
    'Run npm run docs:support and commit docs/formats/support-matrix.md.',
  );
});
