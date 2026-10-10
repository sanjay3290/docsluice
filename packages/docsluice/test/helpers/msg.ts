import { Budget } from '../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { writeCfb } from '../../src/ole/write.js';
import type { CfbWriteEntry } from '../../src/ole/write.js';

/** One MSG message object for {@link buildMsg}; the corpus generator is scripts/corpus/make-msg.mjs. */
export interface MsgSpec {
  /** 8-bit strings (001E) instead of Unicode (001F). */
  ansi?: boolean;
  strings?: Array<[number, string]>;
  binaries?: Array<[number, Uint8Array]>;
  longs?: Array<[number, number]>;
  /** FILETIME values as ISO dates. */
  times?: Array<[number, string]>;
  recipients?: MsgSpec[];
  attachments?: Array<MsgSpec & { embedded?: MsgSpec }>;
}

const hex4 = (value: number) => value.toString(16).toUpperCase().padStart(4, '0');
const hex8 = (value: number) => value.toString(16).toUpperCase().padStart(8, '0');

export function utf16z(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2 + 2);
  for (let index = 0; index < text.length; index++) {
    bytes[index * 2] = text.charCodeAt(index) & 0xff;
    bytes[index * 2 + 1] = text.charCodeAt(index) >> 8;
  }
  return bytes;
}

function latin1z(text: string): Uint8Array {
  return Uint8Array.from([...text, '\0'].map((char) => char.charCodeAt(0) & 0xff));
}

interface Property {
  tag: number;
  value?: bigint | number;
  size?: number;
}

function propertyStream(headerSize: number, properties: Property[], counts: [number, number]): Uint8Array {
  const bytes = new Uint8Array(headerSize + properties.length * 16);
  const view = new DataView(bytes.buffer);
  if (headerSize >= 24) {
    view.setUint32(8, counts[0], true);
    view.setUint32(12, counts[1], true);
    view.setUint32(16, counts[0], true);
    view.setUint32(20, counts[1], true);
  }
  properties.forEach(({ tag, value, size }, index) => {
    const offset = headerSize + index * 16;
    view.setUint32(offset, tag >>> 0, true);
    view.setUint32(offset + 4, 6, true);
    if (typeof value === 'bigint') view.setBigUint64(offset + 8, value, true);
    else view.setUint32(offset + 8, value ?? size ?? 0, true);
  });
  return bytes;
}

function objectEntries(path: string, spec: MsgSpec, headerSize: number, entries: CfbWriteEntry[]): void {
  const join = (name: string) => (path ? `${path}/${name}` : name);
  if (path) entries.push({ path, type: 'storage' });
  const properties: Property[] = [];
  for (const [id, text] of spec.strings ?? []) {
    const type = spec.ansi ? 0x001e : 0x001f;
    const data = spec.ansi ? latin1z(text) : utf16z(text);
    entries.push({ path: join(`__substg1.0_${hex4(id)}${hex4(type)}`), type: 'stream', data });
    properties.push({ tag: (id << 16) | type, size: data.length });
  }
  for (const [id, data] of spec.binaries ?? []) {
    entries.push({ path: join(`__substg1.0_${hex4(id)}0102`), type: 'stream', data });
    properties.push({ tag: (id << 16) | 0x0102, size: data.length });
  }
  for (const [id, value] of spec.longs ?? []) properties.push({ tag: (id << 16) | 0x0003, value });
  for (const [id, iso] of spec.times ?? []) {
    properties.push({
      tag: (id << 16) | 0x0040,
      value: (BigInt(Date.parse(iso)) + 11_644_473_600_000n) * 10_000n,
    });
  }
  const recipients = spec.recipients ?? [];
  const attachments = spec.attachments ?? [];
  entries.push({
    path: join('__properties_version1.0'),
    type: 'stream',
    data: propertyStream(headerSize, properties, [recipients.length, attachments.length]),
  });
  recipients.forEach((recipient, index) => {
    objectEntries(join(`__recip_version1.0_#${hex8(index)}`), recipient, 8, entries);
  });
  attachments.forEach((attachment, index) => {
    const storage = join(`__attach_version1.0_#${hex8(index)}`);
    objectEntries(storage, attachment, 8, entries);
    if (attachment.embedded)
      objectEntries(`${storage}/__substg1.0_3701000D`, attachment.embedded, 24, entries);
  });
}

/** Build a .msg compound file from a spec; `extra` adds raw entries after the message. */
export function buildMsg(spec: MsgSpec, extra: CfbWriteEntry[] = []): Uint8Array {
  const entries: CfbWriteEntry[] = [];
  objectEntries('', spec, 32, entries);
  const bytes = writeCfb([...entries, ...extra], new Budget(DEFAULT_LIMITS));
  if (!bytes) throw new Error('fixture did not fit');
  return bytes;
}

/** An attachment by value. */
export function attachment(name: string, data: Uint8Array, more: MsgSpec = {}): MsgSpec {
  return {
    ...more,
    strings: [[0x3707, name], ...(more.strings ?? [])],
    binaries: [[0x3701, data]],
    longs: [[0x3705, 1], ...(more.longs ?? [])],
  };
}

/** A recipient: 1 = To, 2 = Cc, 3 = Bcc. */
export function recipient(type: number, name: string, address: string): MsgSpec {
  return {
    strings: [
      [0x3001, name],
      [0x39fe, address],
    ],
    longs: [[0x0c15, type]],
  };
}

/** A PR_RTF_COMPRESSED stream of literals only, with the end marker and a valid CRC ([MS-OXRTFCP]). */
export function compressedRtf(text: string, options: { rawSize?: number; crc?: number } = {}): Uint8Array {
  const raw = new TextEncoder().encode(text);
  const out: number[] = [];
  let write = 207;
  let position = 0;
  for (;;) {
    const control = out.length;
    out.push(0);
    let bits = 0;
    let done = false;
    for (let bit = 0; bit < 8; bit++) {
      if (position >= raw.length) {
        bits |= 1 << bit;
        out.push(write >> 4, (write & 0xf) << 4);
        done = true;
        break;
      }
      out.push(raw[position++]!);
      write = (write + 1) & 0xfff;
    }
    out[control] = bits;
    if (done) break;
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
  view.setUint32(4, options.rawSize ?? raw.length, true);
  view.setUint32(8, 0x75465a4c, true);
  view.setUint32(12, options.crc ?? crc >>> 0, true);
  result.set(payload, 16);
  return result;
}
