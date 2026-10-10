import { makeZip } from './zip.js';

const encoder = new TextEncoder();
export const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
export const u32 = (value: number) => [
  value & 0xff,
  (value >> 8) & 0xff,
  (value >> 16) & 0xff,
  (value >>> 24) & 0xff,
];
export const f64 = (value: number) => [...new Uint8Array(Float64Array.of(value).buffer)];
export function wide(value: string): number[] {
  const out = u32(value.length);
  for (let index = 0; index < value.length; index++) out.push(...u16(value.charCodeAt(index)));
  return out;
}

/** One [MS-XLSB] record: 1–2 byte type and 1–4 byte size, seven bits per byte. */
export function record(type: number, data: number[] = []): number[] {
  const out = type < 128 ? [type] : [(type & 0x7f) | 0x80, type >> 7];
  let size = data.length;
  do {
    let byte = size & 0x7f;
    size >>>= 7;
    if (size > 0) byte |= 0x80;
    out.push(byte);
  } while (size > 0);
  return [...out, ...data];
}

export const part = (...records: number[][]) => Uint8Array.from(records.flat());
/** A long cell: column, then the style index (24 bits) and flags. */
export const cell = (type: number, column: number, style: number, ...value: number[]) =>
  record(type, [...u32(column), ...u32(style), ...value]);
/** A short cell: no column, the cell after the previous one. */
export const short = (type: number, style: number, ...value: number[]) =>
  record(type, [...u32(style), ...value]);
export const rowHeader = (row: number) =>
  record(0, [...u32(row), ...u32(0), ...u16(256), 0, 0, 0, ...u32(0)]);

export interface XlsbSheetSpec {
  name: string;
  state?: number;
  /** `null` writes a module sheet without a relationship. */
  data: Uint8Array | null;
}

/** A minimal XLSB package: workbook, optional shared strings and styles, and the given sheets. */
export function xlsbPackage(
  sheets: XlsbSheetSpec[],
  options: {
    strings?: string[];
    styles?: Uint8Array;
    date1904?: boolean;
    extra?: Array<{ name: string; data: Uint8Array }>;
  } = {},
): Uint8Array {
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const book = part(
    record(131),
    record(153, [...u32(options.date1904 ? 1 : 0), ...u32(0), ...wide('')]),
    ...sheets.map((sheet, index) =>
      record(156, [
        ...u32(sheet.state ?? 0),
        ...u32(index + 1),
        ...(sheet.data === null ? u32(0xffff_ffff) : wide(`rId${index + 10}`)),
        ...wide(sheet.name),
      ]),
    ),
    record(132),
  );
  const rels = [
    `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.bin"/>`,
    `<Relationship Id="rId2" Type="${REL}/sharedStrings" Target="sharedStrings.bin"/>`,
    ...sheets.map(
      (_, index) =>
        `<Relationship Id="rId${index + 10}" Type="${REL}/worksheet" Target="worksheets/sheet${index + 1}.bin"/>`,
    ),
  ].join('');
  const entries = [
    {
      name: '[Content_Types].xml',
      data: encoder.encode(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: encoder.encode(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.bin"/></Relationships>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.bin.rels',
      data: encoder.encode(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
      ),
    },
    { name: 'xl/workbook.bin', data: book },
    ...(options.strings
      ? [
          {
            name: 'xl/sharedStrings.bin',
            data: part(
              record(159),
              ...options.strings.map((text) => record(19, [0, ...wide(text)])),
              record(160),
            ),
          },
        ]
      : []),
    ...(options.styles ? [{ name: 'xl/styles.bin', data: options.styles }] : []),
    ...sheets.flatMap((sheet, index) =>
      sheet.data ? [{ name: `xl/worksheets/sheet${index + 1}.bin`, data: sheet.data }] : [],
    ),
    ...(options.extra ?? []),
  ];
  return makeZip(entries);
}
