import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// OOXML package inputs: forged records nested in extensions, and an encrypted package (MS-OFFCRYPTO).
const directory = new URL('../../hostile/ooxml/', import.meta.url);
await mkdir(directory, { recursive: true });

const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const contentTypes = 'http://schemas.openxmlformats.org/package/2006/content-types';
const extension = 'urn:example:extension';
const files = {
  '[Content_Types].xml': `<Types xmlns="${contentTypes}"><Default Extension="xml" ContentType="application/xml"/><ext:Extension xmlns:ext="${extension}"><Default xmlns="${contentTypes}" Extension="bad" ContentType="application/forged"/></ext:Extension></Types>`,
  '_rels/.rels': `<Relationships xmlns="${relationships}"><Relationship Id="office" Type="officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/document.xml': '<document/>',
  'word/_rels/document.xml.rels': `<Relationships xmlns="${relationships}"><ext:Extension xmlns:ext="${extension}"><Relationship Id="nested-external" Type="hyperlink" Target="https://example.invalid/" TargetMode="External"/></ext:Extension></Relationships>`,
};
const entries = Object.create(null);
for (const [name, text] of Object.entries(files)) {
  entries[name] = { data: strToU8(text), mtime: new Date('2000-01-01T00:00:00.000Z') };
}
await writeFile(new URL('extension-nested-records.zip', directory), zipSync(entries, { level: 0 }));

// An encrypted OOXML file is a compound file whose root holds an EncryptedPackage stream.
// Renaming the corpus DOC's WordDocument stream gives that shape without any real ciphertext.
const utf16 = (value) => {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) bytes[index * 2] = value.charCodeAt(index);
  return bytes;
};
const cfb = new Uint8Array(await readFile(new URL('../../corpus/ole/libreoffice.doc', import.meta.url)));
const from = utf16('WordDocument');
let offset = -1;
for (let start = 0; start <= cfb.length - from.length && offset < 0; start += 1) {
  if (from.every((byte, index) => cfb[start + index] === byte)) offset = start;
}
if (offset < 0) throw new Error('WordDocument directory entry not found');
const name = utf16('EncryptedPackage');
cfb.fill(0, offset, offset + 64);
cfb.set(name, offset);
new DataView(cfb.buffer).setUint16(offset + 64, name.length + 2, true);
await writeFile(new URL('encrypted-package.cfb', directory), cfb);
