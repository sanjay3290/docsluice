import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { writeCfb } from '../../packages/docsluice/src/ole/write.ts';

// Hostile PowerPoint 97-2003 decks, written from [MS-PPT] 2.1 and 2.3: drawing containers nested
// 1,000 deep, a UserEditAtom chain that points at itself, an encrypted Current User token, 5,000
// slides whose persist ids resolve nowhere, and a text atom of 100,000 paragraph marks.
const directory = new URL('../../hostile/ppt/', import.meta.url);
await mkdir(directory, { recursive: true });
const budget = { tick() {}, checkUncompressed: () => true, addUncompressed: () => true };

const concat = (parts) => {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};
function record(type, body = new Uint8Array(0), { instance = 0, version = 0 } = {}) {
  const bytes = new Uint8Array(8 + body.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, (instance << 4) | version, true);
  view.setUint16(2, type, true);
  view.setUint32(4, body.length, true);
  bytes.set(body, 8);
  return bytes;
}
const container = (type, children, instance = 0) => record(type, concat(children), { instance, version: 0x0f });
const u32 = (...values) => {
  const bytes = new Uint8Array(values.length * 4);
  values.forEach((value, index) => new DataView(bytes.buffer).setUint32(index * 4, value, true));
  return bytes;
};
const utf16 = (text) => {
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index++) new DataView(bytes.buffer).setUint16(index * 2, text.charCodeAt(index), true);
  return bytes;
};
const slidePersist = (persistId, slideId) => record(0x03f3, u32(persistId, 0, 0, slideId, 0));
const textHeader = (type) => record(0x0f9f, u32(type));
const textChars = (text) => record(0x0fa0, utf16(text));

/**
 * A deck: the document container (persist id 1) with a slide list, then the slide containers
 * (persist ids 2…), the persist directory, and the UserEditAtom the Current User stream points at.
 */
function deck({ slideList, slides = [], selfLoop = false, encrypted = false }) {
  const parts = [];
  let offset = 0;
  const add = (bytes) => {
    const at = offset;
    parts.push(bytes);
    offset += bytes.length;
    return at;
  };
  const offsets = [add(container(0x03e8, [container(0x0ff0, slideList, 0)]))];
  for (const slide of slides) offsets.push(add(slide));
  const directoryOffset = add(record(0x1772, u32((offsets.length << 20) | 1, ...offsets)));
  const editOffset = offset;
  add(record(0x0ff5, u32(0, 0x03000000, selfLoop ? editOffset : 0, directoryOffset, 1, offsets.length + 1, 1)));
  const currentUser = record(0x0ff6, concat([u32(20, encrypted ? 0xf3d1c4df : 0xe391c05f, editOffset), new Uint8Array(8)]));
  return writeCfb(
    [
      { path: 'Current User', type: 'stream', data: currentUser },
      { path: 'PowerPoint Document', type: 'stream', data: concat(parts) },
    ],
    budget,
  );
}

const titled = (title) => [slidePersist(2, 256), textHeader(0), textChars(title)];

// A slide drawing nested 1,000 containers deep with a text box at the bottom: DEPTH_LIMIT.
let nested = container(0xf004, [container(0xf00d, [textHeader(4), textChars('deep text')])]);
for (let depth = 0; depth < 1000; depth++) nested = container(0xf003, [nested]);
await writeFile(new URL('deep-drawing-1000.ppt', directory), deck({ slideList: titled('Deep'), slides: [container(0x03ee, [nested])] }));

// A UserEditAtom whose offsetLastEdit is its own offset: the chain would never end.
await writeFile(new URL('edit-chain-loop.ppt', directory), deck({ slideList: titled('Loop'), selfLoop: true }));

// The Current User token of an RC4 CryptoAPI-encrypted deck.
await writeFile(new URL('encrypted-token.ppt', directory), deck({ slideList: titled('Encrypted'), encrypted: true }));

// 5,000 slide entries whose persist ids are not in the directory: empty sections, one warning.
const orphans = [];
for (let index = 0; index < 5_000; index++) orphans.push(slidePersist(0x0f_0000 + index, 256 + index));
await writeFile(new URL('orphan-slides-5000.ppt', directory), deck({ slideList: orphans }));

// One text atom of 100,000 paragraph marks: empty paragraphs are not emitted.
await writeFile(
  new URL('paragraph-flood.ppt', directory),
  deck({
    slideList: [slidePersist(2, 256), textHeader(1), textChars('\r'.repeat(100_000))],
    slides: [container(0x03ee, [])],
  }),
);
