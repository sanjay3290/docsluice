import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = resolve(HERE, 'fixtures');
const PACKAGE_JSON = resolve(HERE, '../packages/docsluice/package.json');
const packageRequire = createRequire(PACKAGE_JSON);
const { strToU8, zipSync } = packageRequire('fflate');
const docsluicePackage = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
const DOCX_TARGET_BYTES = 5 * 1024 * 1024;
const PARAGRAPHS = 10_000;
const XLSX_ROWS = 50_000;
const PDF_PAGES = 100;
const FIXED_MTIME = new Date('1980-01-01T00:00:00.000Z');
const LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function deterministicText(length, seed = 0) {
  return LETTERS.repeat(Math.ceil((length + seed) / LETTERS.length)).slice(seed, seed + length);
}

function zipFiles(files, level) {
  const entries = Object.create(null);
  for (const [name, content] of files) {
    entries[name] = [strToU8(content), { level, mtime: FIXED_MTIME }];
  }
  return zipSync(entries, { level, mtime: FIXED_MTIME });
}

function docxDocument(textLength) {
  const markerCharacters = textLength === 0 ? 0 : PARAGRAPHS * 7;
  if (textLength > 0 && textLength < markerCharacters)
    throw new Error('DOCX target cannot fit all paragraph markers.');
  const remainingText = textLength - markerCharacters;
  const quotient = Math.floor(remainingText / PARAGRAPHS);
  let extra = remainingText % PARAGRAPHS;
  let paragraphs = '';
  for (let index = 1; index <= PARAGRAPHS; index += 1) {
    const bodyLength = quotient + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    const marker = textLength === 0 ? '' : `P${String(index).padStart(5, '0')}`;
    const body = deterministicText(bodyLength, index % LETTERS.length);
    paragraphs += `<w:p><w:r><w:t>${marker ? `${marker} ` : ''}${body}</w:t></w:r></w:p>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
}

function makeDocx(textLength) {
  const documentXml = docxDocument(textLength);
  return zipFiles(
    [
      [
        '[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ],
      [
        '_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ],
      ['word/document.xml', documentXml],
    ],
    0,
  );
}

function makeXlsx() {
  let rows = '';
  for (let index = 1; index <= XLSX_ROWS; index += 1) {
    const marker = `R${String(index).padStart(5, '0')}`;
    rows += `<row r="${index}"><c r="A${index}" t="inlineStr"><is><t>${marker}</t></is></c><c r="B${index}"><v>${index}</v></c></row>`;
  }
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  return zipFiles(
    [
      [
        '[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      ],
      [
        '_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ],
      [
        'xl/workbook.xml',
        '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ],
      [
        'xl/_rels/workbook.xml.rels',
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ],
      ['xl/worksheets/sheet1.xml', sheet],
    ],
    6,
  );
}

function pdfEscape(text) {
  return text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function makePdf(pageCount = PDF_PAGES) {
  const objects = new Map();
  const pageIds = [];
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  for (let page = 1; page <= pageCount; page += 1) {
    const pageId = 4 + (page - 1) * 2;
    const contentId = pageId + 1;
    pageIds.push(`${pageId} 0 R`);
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const text = `BT /F1 12 Tf 40 750 Td (${pdfEscape(`DOCSLUICE PAGE-${String(page).padStart(3, '0')} benchmark text`)}) Tj ET`;
    objects.set(contentId, `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
  }
  objects.set(2, `<< /Type /Pages /Kids [${pageIds.join(' ')}] /Count ${pageCount} >>`);

  const size = pageCount * 2 + 4;
  const offsets = new Array(size).fill(0);
  let output = '%PDF-1.4\n% docsluice generated benchmark\n';
  for (let id = 1; id < size; id += 1) {
    const body = objects.get(id);
    if (!body) throw new Error(`Generated PDF is missing object ${id}.`);
    offsets[id] = Buffer.byteLength(output, 'ascii');
    output += `${id} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, 'ascii');
  output += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id += 1) output += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, 'ascii');
}

/** Create fixed-byte deterministic inputs and their content/provenance manifest. */
export function createFixtures() {
  const emptyDocx = makeDocx(0);
  const docxTextLength = DOCX_TARGET_BYTES - emptyDocx.byteLength;
  const docxMarkerCharacters = PARAGRAPHS * 7;
  const docxFillerCharacters = docxTextLength - docxMarkerCharacters;
  const docx = makeDocx(docxTextLength);
  if (docx.byteLength !== DOCX_TARGET_BYTES) {
    throw new Error(`Generated DOCX is ${docx.byteLength} bytes; expected ${DOCX_TARGET_BYTES}.`);
  }
  const xlsx = makeXlsx();
  const pdf = makePdf();
  const specifications = {
    docx: {
      file: 'benchmark-5mb.docx',
      format: 'docx',
      bytes: docx.byteLength,
      paragraphs: PARAGRAPHS,
      textCharacters: docxTextLength,
      markerCharacters: docxMarkerCharacters,
      fillerCharacters: docxFillerCharacters,
    },
    xlsx: { file: 'benchmark-50000-rows.xlsx', format: 'xlsx', bytes: xlsx.byteLength, rows: XLSX_ROWS },
    pdf: { file: 'benchmark-100-pages.pdf', format: 'pdf', bytes: pdf.byteLength, pages: PDF_PAGES },
  };
  const files = { docx, xlsx, pdf };
  const manifest = {
    schemaVersion: 1,
    generator: 'bench/generate.mjs',
    generatorLicense: 'MIT (repository license)',
    source: 'Generated deterministic synthetic content; no third-party documents or text.',
    zipLibrary: `fflate ${docsluicePackage.dependencies.fflate}; fixed DOS timestamp 1980-01-01T00:00:00Z`,
    fixtures: Object.fromEntries(
      Object.entries(specifications).map(([name, specification]) => [
        name,
        { ...specification, sha256: sha256(files[name]) },
      ]),
    ),
  };
  return { ...files, manifest };
}

/** Materialize the generated inputs and manifest for benchmark runs. */
export async function generateFixtures(outputDirectory = DEFAULT_OUTPUT) {
  const fixtures = createFixtures();
  await mkdir(outputDirectory, { recursive: true });
  for (const [name, specification] of Object.entries(fixtures.manifest.fixtures)) {
    await writeFile(resolve(outputDirectory, specification.file), fixtures[name]);
  }
  await writeFile(
    resolve(outputDirectory, 'manifest.json'),
    `${JSON.stringify(fixtures.manifest, null, 2)}\n`,
  );
  return fixtures.manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDirectory = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUTPUT;
  const manifest = await generateFixtures(outputDirectory);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
