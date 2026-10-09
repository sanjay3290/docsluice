import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

const output = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../hostile/ooxml/extension-nested-records.zip',
);
const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const contentTypes = 'http://schemas.openxmlformats.org/package/2006/content-types';
const extension = 'urn:example:extension';
const files = {
  '[Content_Types].xml': `<Types xmlns="${contentTypes}"><Default Extension="xml" ContentType="application/xml"/><ext:Extension xmlns:ext="${extension}"><Default xmlns="${contentTypes}" Extension="bad" ContentType="application/forged"/></ext:Extension></Types>`,
  '_rels/.rels': `<Relationships xmlns="${relationships}"><Relationship Id="office" Type="officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/document.xml': '<document/>',
  'word/_rels/document.xml.rels': `<Relationships xmlns="${relationships}"><ext:Extension xmlns:ext="${extension}"><Relationship Id="nested-external" Type="hyperlink" Target="https://example.invalid/" TargetMode="External"/></ext:Extension></Relationships>`,
};
const entries = Object.fromEntries(
  Object.entries(files).map(([name, text]) => [
    name,
    { data: strToU8(text), mtime: new Date('2000-01-01T00:00:00.000Z') },
  ]),
);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, zipSync(entries, { level: 0 }));
