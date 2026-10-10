// Deterministic Outlook .msg writer for the corpus and hostile generators ([MS-OXMSG], [MS-OXPROPS],
// [MS-OXRTFCP]). Compound files come from docsluice's own CFB writer (Node 24 strips its types on import).
import { TextEncoder } from 'node:util';
import { writeCfb } from '../../packages/docsluice/src/ole/write.ts';

const budget = { tick() {}, checkUncompressed: () => true, addUncompressed: () => true };
export const utf8 = (text) => new TextEncoder().encode(text);
const hex4 = (value) => value.toString(16).toUpperCase().padStart(4, '0');
export const utf16 = (text) => {
  const bytes = new Uint8Array(text.length * 2 + 2);
  for (let index = 0; index < text.length; index++) {
    bytes[index * 2] = text.charCodeAt(index) & 0xff;
    bytes[index * 2 + 1] = text.charCodeAt(index) >> 8;
  }
  return bytes;
};
const windows1251 = (text) =>
  Uint8Array.from([...text, '\0'].map((char) => {
    const code = char.charCodeAt(0);
    return code >= 0x410 && code <= 0x44f ? code - 0x410 + 0xc0 : code;
  }));

// FILETIME for an ISO date: 100 ns ticks since 1601-01-01.
const fileTime = (iso) => (BigInt(Date.parse(iso)) + 11_644_473_600_000n) * 10_000n;

/** A property stream: header, then 16-byte entries for fixed values and variable-length sizes. */
function propertyStream(headerSize, properties) {
  const bytes = new Uint8Array(headerSize + properties.length * 16);
  const view = new DataView(bytes.buffer);
  properties.forEach(({ id, type, value, size }, index) => {
    const offset = headerSize + index * 16;
    view.setUint32(offset, ((id << 16) | type) >>> 0, true);
    view.setUint32(offset + 4, 6, true);
    if (type === 0x0040) view.setBigUint64(offset + 8, value, true);
    else if (type === 0x0003) view.setUint32(offset + 8, value, true);
    else view.setUint32(offset + 8, size, true);
  });
  return bytes;
}

/**
 * One message object below `prefix`: { strings, binaries, longs, times, recipients, attachments }.
 * Strings are Unicode (001F) unless `ansi` is set.
 */
function messageEntries(prefix, message, headerSize) {
  const entries = [];
  const join = (name) => (prefix ? `${prefix}/${name}` : name);
  const storage = (path, values) => {
    if (path) entries.push({ path, type: 'storage' });
    const properties = [];
    for (const [id, text] of values.strings ?? []) {
      const ansi = values.ansi === true;
      const data = ansi ? windows1251(text) : utf16(text);
      const type = ansi ? 0x001e : 0x001f;
      entries.push({ path: `${path ? `${path}/` : ''}__substg1.0_${hex4(id)}${hex4(type)}`, type: 'stream', data });
      properties.push({ id, type, size: data.length });
    }
    for (const [id, data] of values.binaries ?? []) {
      entries.push({ path: `${path ? `${path}/` : ''}__substg1.0_${hex4(id)}0102`, type: 'stream', data });
      properties.push({ id, type: 0x0102, size: data.length });
    }
    for (const [id, value] of values.longs ?? []) properties.push({ id, type: 0x0003, value });
    for (const [id, value] of values.times ?? []) properties.push({ id, type: 0x0040, value: fileTime(value) });
    return properties;
  };
  // Every message carries PR_MESSAGE_CLASS.
  const rootProperties = storage(prefix, { ...message, strings: [[0x001a, 'IPM.Note'], ...(message.strings ?? [])] });
  const recipients = message.recipients ?? [];
  const attachments = message.attachments ?? [];
  const header = new Uint8Array(headerSize);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(8, recipients.length, true);
  headerView.setUint32(12, attachments.length, true);
  headerView.setUint32(16, recipients.length, true);
  headerView.setUint32(20, attachments.length, true);
  // `rawProperties` replaces the property stream (hostile files).
  const stream = message.rawProperties ?? propertyStream(headerSize, rootProperties);
  if (!message.rawProperties) stream.set(header);
  entries.push({ path: join('__properties_version1.0'), type: 'stream', data: stream });
  recipients.forEach((recipient, index) => {
    const path = join(`__recip_version1.0_#${index.toString(16).toUpperCase().padStart(8, '0')}`);
    const properties = storage(path, recipient);
    entries.push({ path: `${path}/__properties_version1.0`, type: 'stream', data: propertyStream(8, properties) });
  });
  attachments.forEach((attachment, index) => {
    const path = join(`__attach_version1.0_#${index.toString(16).toUpperCase().padStart(8, '0')}`);
    const properties = storage(path, attachment);
    entries.push({ path: `${path}/__properties_version1.0`, type: 'stream', data: propertyStream(8, properties) });
    if (attachment.embedded) {
      const object = `${path}/__substg1.0_3701000D`;
      entries.push(...messageEntries(object, attachment.embedded, 24));
    }
  });
  return entries;
}

export function msg(message) {
  // An empty named-property map: GUID, entry and string streams ([MS-OXMSG] 2.2.3).
  const named = ['0002', '0003', '0004'].map((id) => ({
    path: `__nameid_version1.0/__substg1.0_${id}0102`,
    type: 'stream',
    data: new Uint8Array(0),
  }));
  return writeCfb(
    [...messageEntries('', message, 32), { path: '__nameid_version1.0', type: 'storage' }, ...named],
    budget,
  );
}

/** [MS-OXRTFCP] compression: greedy longest match in the 4096-byte dictionary, then the end marker. */
export function compressRtf(text) {
  const raw = utf8(text);
  const prefix =
    '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript ' +
    '\\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n' +
    '\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx';
  const dictionary = new Uint8Array(4096);
  for (let index = 0; index < prefix.length; index++) dictionary[index] = prefix.charCodeAt(index);
  let write = prefix.length;
  const out = [];
  let position = 0;
  let done = false;
  while (!done) {
    const controlAt = out.length;
    out.push(0);
    let control = 0;
    for (let bit = 0; bit < 8; bit++) {
      if (position >= raw.length) {
        control |= 1 << bit;
        out.push(write >> 4, (write & 0xf) << 4);
        done = true;
        break;
      }
      let best = 0;
      let bestOffset = 0;
      for (let offset = 0; offset < 4096; offset++) {
        let length = 0;
        // Only matches that do not read the bytes this copy writes.
        while (
          length < 17 &&
          position + length < raw.length &&
          ((offset + length) & 0xfff) !== write &&
          ((write - offset) & 0xfff) > length &&
          dictionary[(offset + length) & 0xfff] === raw[position + length]
        )
          length++;
        if (length > best) {
          best = length;
          bestOffset = offset;
        }
      }
      const emit = (byte) => {
        dictionary[write] = byte;
        write = (write + 1) & 0xfff;
      };
      if (best >= 2) {
        control |= 1 << bit;
        out.push(bestOffset >> 4, ((bestOffset & 0xf) << 4) | (best - 2));
        for (let index = 0; index < best; index++) emit(raw[position + index]);
        position += best;
      } else {
        out.push(raw[position]);
        emit(raw[position]);
        position++;
      }
    }
    out[controlAt] = control;
  }
  const payload = Uint8Array.from(out);
  let crc = 0;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  const result = new Uint8Array(16 + payload.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, payload.length + 12, true);
  view.setUint32(4, raw.length, true);
  view.setUint32(8, 0x75465a4c, true);
  view.setUint32(12, crc >>> 0, true);
  result.set(payload, 16);
  return result;
}

export const sender = (name, address) => [
  [0x0c1a, name],
  [0x5d01, address],
];
export const recipient = (type, name, address) => ({
  strings: [
    [0x3001, name],
    [0x39fe, address],
  ],
  longs: [[0x0c15, type]],
});

