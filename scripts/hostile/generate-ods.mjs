import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hostile ODS packages: repeat counts that claim the whole grid (empty and with values), counts that
// are not numbers, a merge over the whole sheet, tables nested in cells, and formulas without values.
const OFFICE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const TABLE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const directory = new URL('../../hostile/ods/', import.meta.url);
await mkdir(directory, { recursive: true });

function ods(body) {
  const content = `<office:document-content xmlns:office="${OFFICE}" xmlns:text="${TEXT}" xmlns:table="${TABLE}"><office:body><office:spreadsheet>${body}</office:spreadsheet></office:body></office:document-content>`;
  const entries = Object.create(null);
  for (const [name, data] of [
    ['mimetype', 'application/vnd.oasis.opendocument.spreadsheet'],
    ['content.xml', content],
  ]) {
    entries[name] = [strToU8(data), { mtime: new Date('1980-01-01T00:00:00Z'), level: name === 'mimetype' ? 0 : 9 }];
  }
  return zipSync(entries);
}

const sheet = (rows) => `<table:table table:name="Sheet1">${rows}</table:table>`;
const value = (attrs = '') =>
  `<table:table-cell office:value-type="float" office:value="1" ${attrs}><text:p>1</text:p></table:table-cell>`;

const files = new Map([
  // Every row and column of the grid, all empty: nothing is stored (issue #55).
  [
    'repeat-empty-grid.ods',
    ods(
      sheet(
        '<table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>',
      ),
    ),
  ],
  // One value cell claimed 16,384 x 1,048,576 times: copies stop at the cap, the rest is counted.
  [
    'repeat-value-flood.ods',
    ods(
      sheet(
        `<table:table-row table:number-rows-repeated="1048576">${value('table:number-columns-repeated="16384"')}</table:table-row>`,
      ),
    ),
  ],
  // Counts that are not positive decimal numbers are read as 1; text:s claims a billion spaces.
  [
    'bad-counts.ods',
    ods(
      sheet(
        ['99999999999999999999', '0', '-5', '1e9', 'x', ''].map(
          (count) =>
            `<table:table-row table:number-rows-repeated="${count}">${value(`table:number-columns-repeated="${count}" table:number-columns-spanned="${count}"`)}</table:table-row>`,
        ).join('') +
          '<table:table-row><table:table-cell office:value-type="string"><text:p>a<text:s text:c="999999999"/>b</text:p></table:table-cell></table:table-row>',
      ),
    ),
  ],
  // A merge that spans the whole sheet from A1.
  [
    'merge-whole-sheet.ods',
    ods(sheet(`<table:table-row>${value('table:number-columns-spanned="16384" table:number-rows-spanned="1048576"')}</table:table-row>`)),
  ],
  // Tables nested 5,000 deep inside one cell.
  [
    'nested-tables.ods',
    ods(
      sheet(
        `<table:table-row><table:table-cell>${'<table:table><table:table-row><table:table-cell>'.repeat(5_000)}<text:p>deep</text:p>${'</table:table-cell></table:table-row></table:table>'.repeat(5_000)}</table:table-cell></table:table-row>`,
      ),
    ),
  ],
  // 10,000 formulas without cached values.
  [
    'formulas-without-values.ods',
    ods(sheet(`<table:table-row>${'<table:table-cell table:formula="of:=1+1"/>'.repeat(10_000)}</table:table-row>`)),
  ],
]);

for (const [name, bytes] of files) await writeFile(new URL(name, directory), bytes);
