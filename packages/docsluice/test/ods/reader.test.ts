import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Budget } from '../../src/core/budget.js';
import { DocBuilder } from '../../src/core/builder.js';
import { EncryptedError, LimitExceededError, AbortError } from '../../src/core/errors.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import type { Limits } from '../../src/core/limits.js';
import type { ResolvedOptions } from '../../src/core/options.js';
import { WarningSink } from '../../src/core/warnings.js';
import { makeZip } from '../helpers/zip.js';
import { reader } from '../../src/readers/ods/index.js';

const office = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const table = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const text = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';

function document(body: string): string {
  return `<office:document-content xmlns:office="${office}" xmlns:table="${table}" xmlns:text="${text}"><office:body><office:spreadsheet>${body}</office:spreadsheet></office:body></office:document-content>`;
}

async function readContent(
  content: string,
  overrides: Omit<Partial<ResolvedOptions>, 'limits'> & { limits?: Partial<Limits> } = {},
  extras: Array<{ name: string; data: string }> = [],
) {
  const bytes = makeZip([
    { name: 'content.xml', data: new TextEncoder().encode(content) },
    ...extras.map((entry) => ({ name: entry.name, data: new TextEncoder().encode(entry.data) })),
  ]);
  return readBytes(bytes, overrides);
}

async function readBytes(
  bytes: Uint8Array,
  overrides: Omit<Partial<ResolvedOptions>, 'limits'> & { limits?: Partial<Limits> } = {},
  path = '',
) {
  const warnings = new WarningSink();
  const { limits: limitOverrides, ...optionOverrides } = overrides;
  const limits = { ...DEFAULT_LIMITS, ...(limitOverrides ?? {}) };
  const budget = new Budget(limits, {
    warnings,
    onLimit: overrides.onLimit ?? 'truncate',
    signal: overrides.signal,
  });
  const options: ResolvedOptions = {
    limits,
    onLimit: 'truncate',
    strict: false,
    metadata: true,
    children: 'skip',
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: false,
    formulas: false,
    ...optionOverrides,
  };
  const ctx = {
    bytes,
    options,
    budget,
    warnings,
    out: new DocBuilder('ods', 'application/vnd.oasis.opendocument.spreadsheet', budget, options),
    path,
    async extractChild() {},
  };
  await reader.read(ctx);
  return { document: ctx.out.finish(), warnings: warnings.warnings, budget };
}

describe('ODS reader', () => {
  it('preserves sheet order, visibility, typed cached values, displayed text and formula opt-in', async () => {
    const result = await readContent(
      document(
        `<table:table table:name="Budget"><table:table-row><table:table-cell office:value-type="float" office:value="12.5"><text:p>$12.50</text:p></table:table-cell><table:table-cell office:value-type="boolean" office:boolean-value="true"><text:p>Yes</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="2" table:formula="of:=1+1"><text:p>2</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="1.2E+3"><text:p>1,200</text:p></table:table-cell></table:table-row></table:table><table:table table:name="Hidden" table:display="false"/></table:spreadsheet>`,
      ),
      { formulas: true },
    );

    const [first, second] = result.document.blocks;
    expect(first).toMatchObject({ kind: 'section', role: 'sheet', title: 'Budget' });
    expect(second).toMatchObject({ kind: 'section', role: 'sheet', title: 'Hidden' });
    expect(result.warnings.some((warning) => warning.code === 'HIDDEN_CONTENT')).toBe(true);
    if (first?.kind !== 'section') throw new Error('expected first sheet');
    const tableBlock = first.blocks[0];
    expect(tableBlock).toMatchObject({
      kind: 'table',
      rows: [
        [
          { text: '$12.50', raw: 12.5, address: 'Budget!A1' },
          { text: 'Yes', raw: true, address: 'Budget!B1' },
          { text: '2', raw: 2, formula: 'of:=1+1', address: 'Budget!C1' },
          { text: '1,200', raw: 1200, address: 'Budget!D1' },
        ],
      ],
    });
  });

  it('advances million-row empty repeats arithmetically and keeps sparse addresses', async () => {
    const result = await readContent(
      document(
        `<table:table table:name="Sparse"><table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="1000000"/></table:table-row><table:table-row><table:table-cell office:value-type="string"><text:p>end</text:p></table:table-cell></table:table-row></table:table>`,
      ),
    );

    const sheet = result.document.blocks[0];
    expect(sheet).toMatchObject({ kind: 'section', title: 'Sparse' });
    if (sheet?.kind !== 'section') throw new Error('expected sparse sheet');
    const block = sheet.blocks[0];
    expect(block).toMatchObject({ kind: 'table', rows: [[{ text: 'end', address: 'Sparse!A1048577' }]] });
    expect(result.budget.cells).toBe(1);
  });

  it('retains merged spans and skips covered cells without losing following addresses', async () => {
    const result = await readContent(
      document(
        `<table:table table:name="M"><table:table-row><table:table-cell office:value-type="string" table:number-columns-spanned="2" table:number-rows-spanned="2"><text:p>merged</text:p></table:table-cell><table:covered-table-cell/><table:table-cell office:value-type="string"><text:p>after</text:p></table:table-cell></table:table-row><table:table-row><table:covered-table-cell table:number-columns-repeated="2"/></table:table-row></table:table>`,
      ),
    );
    const sheet = result.document.blocks[0];
    if (sheet?.kind !== 'section') throw new Error('expected merged sheet');
    expect(sheet.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [
        [
          { text: 'merged', address: 'M!A1', colSpan: 2, rowSpan: 2 },
          { text: 'after', address: 'M!C1' },
        ],
      ],
    });
    expect(result.budget.cells).toBe(2);
  });

  it('marks hidden rows and columns on included cells and keeps formulas opt-in', async () => {
    const result = await readContent(
      `<office:document-content xmlns:office="${office}" xmlns:table="${table}" xmlns:text="${text}"><office:body><office:spreadsheet><table:table table:name="HiddenParts"><table:table-column table:visibility="collapse"/><table:table-column/><table:table-row table:visibility="collapse"><table:table-cell office:value-type="date" office:date-value="2024-04-03T00:00:00"><text:p>Apr 3, 2024</text:p></table:table-cell><table:table-cell office:value-type="currency" office:value="4.5"><text:p>$4.50</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`,
    );
    const sheet = result.document.blocks[0];
    if (sheet?.kind !== 'section') throw new Error('expected hidden sheet');
    expect(sheet.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [
        [
          { text: 'Apr 3, 2024', raw: '2024-04-03T00:00:00', address: 'HiddenParts!A1', hidden: true },
          { text: '$4.50', raw: 4.5, address: 'HiddenParts!B1', hidden: true },
        ],
      ],
    });
    expect(result.warnings.filter((warning) => warning.code === 'HIDDEN_CONTENT')).toHaveLength(1);
  });

  it('does not allocate a huge repeated populated cell after the cells budget rejects it', async () => {
    const result = await readContent(
      document(
        `<table:table table:name="Bounded"><table:table-row><table:table-cell table:number-columns-repeated="1048576" office:value-type="string"><text:p>x</text:p></table:table-cell></table:table-row></table:table>`,
      ),
      { limits: { cells: 2 } },
    );
    const sheet = result.document.blocks[0];
    if (sheet?.kind !== 'section') throw new Error('expected bounded sheet');
    expect(sheet.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [
        [
          { text: 'x', address: 'Bounded!A1' },
          { text: 'x', address: 'Bounded!B1' },
        ],
      ],
    });
    expect(result.budget.cells).toBe(3);
    expect(result.document.stats.truncated).toBe(true);
  });

  it('rejects encrypted packages and propagates caller aborts', async () => {
    const manifestNs = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0';
    const encryptedManifest = `<manifest:manifest xmlns:manifest="${manifestNs}"><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"><manifest:encryption-data/></manifest:file-entry></manifest:manifest>`;
    await expect(
      readContent(document(''), {}, [{ name: 'META-INF/manifest.xml', data: encryptedManifest }]),
    ).rejects.toBeInstanceOf(EncryptedError);

    const controller = new AbortController();
    controller.abort();
    await expect(readContent(document(''), { signal: controller.signal })).rejects.toBeInstanceOf(AbortError);
  });

  it('keeps external links as data and respects metadata privacy', async () => {
    const dc = 'http://purl.org/dc/elements/1.1/';
    const meta = 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0';
    const metadata = `<office:document-meta xmlns:office="${office}" xmlns:dc="${dc}" xmlns:meta="${meta}"><office:meta><dc:title>Quarterly</dc:title><dc:creator>Ada</dc:creator><meta:user-defined meta:name="department">Finance</meta:user-defined></office:meta></office:document-meta>`;
    const withLink = document(
      `<table:table table:name="Links"><table:table-row><table:table-cell office:value-type="string"><text:p><text:a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://example.invalid/report">Report</text:a></text:p></table:table-cell></table:table-row></table:table>`,
    );
    const visible = await readContent(withLink, {}, [{ name: 'meta.xml', data: metadata }]);
    expect(visible.document.metadata).toMatchObject({
      title: 'Quarterly',
      authors: ['Ada'],
      custom: [{ name: 'department', value: 'Finance' }],
    });
    expect(visible.document.features.hasExternalLinks).toBe(true);

    const privateResult = await readContent(withLink, { metadata: false }, [
      { name: 'meta.xml', data: metadata },
    ]);
    expect(privateResult.document.metadata).toEqual({ title: 'Quarterly' });
  });

  it('propagates limit throw policy and never evaluates formulas', async () => {
    await expect(
      readContent(
        document(
          `<table:table table:name="Limit"><table:table-row><table:table-cell office:value-type="string"><text:p>x</text:p></table:table-cell></table:table-row></table:table>`,
        ),
        { limits: { cells: 0 }, onLimit: 'throw' },
      ),
    ).rejects.toBeInstanceOf(LimitExceededError);
    const result = await readContent(
      document(
        `<table:table table:name="Formula"><table:table-row><table:table-cell office:value-type="float" office:value="3" table:formula="of:=1+2"><text:p>3</text:p></table:table-cell></table:table-row></table:table>`,
      ),
    );
    const sheet = result.document.blocks[0];
    if (sheet?.kind !== 'section') throw new Error('expected formula sheet');
    expect(sheet.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [[{ text: '3', raw: 3, address: 'Formula!A1' }]],
    });
  });

  it('rejects ambiguous archive parts and reports invalid repeat counts without echoing values', async () => {
    const warnings = new WarningSink();
    const budget = new Budget(DEFAULT_LIMITS, { warnings });
    const bytes = makeZip([
      { name: 'content.xml', data: new TextEncoder().encode(document('')) },
      { name: 'content.xml', data: new TextEncoder().encode(document('')) },
    ]);
    const options: ResolvedOptions = {
      limits: DEFAULT_LIMITS,
      onLimit: 'truncate',
      strict: false,
      metadata: true,
      children: 'skip',
      childBytes: false,
      runs: false,
      revisions: 'accept',
      includeHidden: false,
      formulas: false,
    };
    const out = new DocBuilder('ods', 'application/vnd.oasis.opendocument.spreadsheet', budget, options);
    await expect(
      reader.read({ bytes, options, budget, warnings, out, path: '', async extractChild() {} }),
    ).rejects.toThrow();
    expect(warnings.warnings.map((warning) => warning.message)).toEqual([
      'ODF archive contains an ambiguous part name.',
    ]);

    const invalid = await readContent(
      document(
        `<table:table table:name="Bad"><table:table-row table:number-rows-repeated="0"><table:table-cell office:value-type="string"><text:p>private text</text:p></table:table-cell></table:table-row></table:table>`,
      ),
    );
    expect(invalid.warnings.map((warning) => warning.message)).toContain(
      'ODS contains an invalid repeated row count.',
    );
    expect(invalid.warnings.every((warning) => !warning.message.includes('private text'))).toBe(true);
  });

  it('uses A1 column names beyond Z and treats a relative href as non-external data', async () => {
    const result = await readContent(
      document(
        `<table:table table:name="Columns"><table:table-row><table:table-cell table:number-columns-repeated="26"/><table:table-cell office:value-type="string"><text:p>AA</text:p><text:a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="internal">image</text:a></table:table-cell></table:table-row></table:table>`,
      ),
    );
    const sheet = result.document.blocks[0];
    if (sheet?.kind !== 'section') throw new Error('expected column sheet');
    expect(sheet.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [[{ text: 'AA', address: 'Columns!AA1' }]],
    });
    expect(result.document.features.hasExternalLinks).toBe(false);
  });

  it('marks only cells in collapsed columns as hidden', async () => {
    const result = await readContent(
      document(
        `<table:table table:name="ColumnVisibility"><table:table-column-group><table:table-column table:visibility="collapse"/><table:table-column/></table:table-column-group><table:table-row><table:table-cell office:value-type="string"><text:p>hidden</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>visible</text:p></table:table-cell></table:table-row></table:table>`,
      ),
    );
    const sheet = result.document.blocks[0];
    if (sheet?.kind !== 'section') throw new Error('expected sheet');
    expect(sheet.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [[{ address: 'ColumnVisibility!A1', hidden: true }, { address: 'ColumnVisibility!B1' }]],
    });
  });

  it('reads the licensed hostile sparse fixtures within the shared cell budget', async () => {
    const empty = readFileSync(
      new URL('../../../../hostile/ods/ods_repeat_empty_limit.ods', import.meta.url),
    );
    const emptyResult = await readBytes(empty);
    expect(emptyResult.budget.cells).toBe(0);
    expect(emptyResult.document.stats.truncated).toBe(false);

    const populated = readFileSync(
      new URL('../../../../hostile/ods/ods_repeat_nonempty_hostile.ods', import.meta.url),
    );
    const populatedResult = await readBytes(populated, { limits: { cells: 2 } });
    expect(populatedResult.budget.cells).toBe(3);
    expect(populatedResult.document.stats.truncated).toBe(true);
  });

  it('carries the parent document path onto sheet and table locations', async () => {
    const bytes = makeZip([
      {
        name: 'content.xml',
        data: new TextEncoder().encode(
          document(`<table:table table:name="Child"><table:table-row/></table:table>`),
        ),
      },
    ]);
    const result = await readBytes(bytes, {}, 'archive/book.ods');
    const sheet = result.document.blocks[0];
    if (sheet?.kind !== 'section') throw new Error('expected child sheet');
    expect(sheet.loc.path).toBe('archive/book.ods/content.xml');
    expect(sheet.blocks[0]?.loc.path).toBe('archive/book.ods/content.xml');
  });

  it('stops staging repeated cells when the cumulative sheet output budget is exhausted', async () => {
    const result = await readContent(
      document(
        `<table:table table:name="S"><table:table-row><table:table-cell table:number-columns-repeated="10000" office:value-type="string"><text:p>x</text:p></table:table-cell></table:table-row></table:table>`,
      ),
      { limits: { outputChars: 10 } },
    );
    const sheet = result.document.blocks[0];
    if (sheet?.kind !== 'section') throw new Error('expected partially retained sheet');
    const tableBlock = sheet.blocks[0];
    if (tableBlock?.kind !== 'table') throw new Error('expected table block');
    expect(tableBlock.rows[0]).toHaveLength(9);
    expect(result.budget.cells).toBe(9);
    expect(result.budget.outputChars).toBe(10);
    expect(result.document.stats.truncated).toBe(true);
  });
});
