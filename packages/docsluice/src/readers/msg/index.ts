import type { Budget } from '../../core/budget.js';
import type { Cell } from '../../core/model.js';
import type { ReadContext, Reader } from '../../core/reader.js';
import { emitHtml } from '../../html/index.js';
import { openCfb } from '../../ole/index.js';
import type { CfbArchive } from '../../ole/index.js';
import { writeCfb } from '../../ole/write.js';
import type { CfbWriteEntry } from '../../ole/write.js';
import { dropQuotedText, quotedHtml } from '../eml/replies.js';
import { emitPlain, safeAttachmentName } from '../eml/shared.js';
import { codePageName } from '../rtf/common.js';
import { deencapsulateRtfHtml, rtfReader } from '../rtf/index.js';
import { decompressRtf } from './lzfu.js';

const MSG_MIME = 'application/vnd.ms-outlook';
const PROPERTIES = '__properties_version1.0';
const RECIPIENT_PREFIX = '__recip_version1.0_#';
const ATTACHMENT_PREFIX = '__attach_version1.0_#';
const EMBEDDED_OBJECT = '__substg1.0_3701000D';
/** [MS-OXMSG] 2.4: property stream header sizes. */
const ROOT_HEADER = 32;
const EMBEDDED_HEADER = 24;
const SUB_OBJECT_HEADER = 8;

const TYPE_INTEGER32 = 0x0003;
const TYPE_TIME = 0x0040;
const TYPE_STRING8 = 0x001e;
const TYPE_UNICODE = 0x001f;
const TYPE_BINARY = 0x0102;

const PR_SUBJECT = 0x0037;
const PR_CLIENT_SUBMIT_TIME = 0x0039;
const PR_SENT_REPRESENTING_NAME = 0x0042;
const PR_SENT_REPRESENTING_EMAIL = 0x0065;
const PR_RECIPIENT_TYPE = 0x0c15;
const PR_SENDER_NAME = 0x0c1a;
const PR_SENDER_EMAIL = 0x0c1f;
const PR_DISPLAY_CC = 0x0e03;
const PR_DISPLAY_TO = 0x0e04;
const PR_MESSAGE_DELIVERY_TIME = 0x0e06;
const PR_BODY = 0x1000;
const PR_RTF_COMPRESSED = 0x1009;
const PR_HTML = 0x1013;
const PR_DISPLAY_NAME = 0x3001;
const PR_EMAIL_ADDRESS = 0x3003;
const PR_ATTACH_DATA = 0x3701;
const PR_ATTACH_FILENAME = 0x3704;
const PR_ATTACH_METHOD = 0x3705;
const PR_ATTACH_LONG_FILENAME = 0x3707;
const PR_ATTACH_MIME_TAG = 0x370e;
const PR_ATTACH_CONTENT_ID = 0x3712;
const PR_SMTP_ADDRESS = 0x39fe;
const PR_INTERNET_CPID = 0x3fde;
const PR_MESSAGE_CODEPAGE = 0x3ffd;
const PR_SENDER_SMTP_ADDRESS = 0x5d01;

const ATTACH_EMBEDDED_MESSAGE = 5;
const ATTACH_OLE = 6;

/** Code pages MSG files use beyond the RTF table, as WHATWG encoding labels. */
const EXTRA_CODE_PAGES = new Map<number, string>([
  [866, 'ibm866'],
  [1200, 'utf-16le'],
  [10000, 'macintosh'],
  [20127, 'us-ascii'],
  [20866, 'koi8-r'],
  [21866, 'koi8-u'],
  [28591, 'iso-8859-1'],
  [28592, 'iso-8859-2'],
  [28595, 'iso-8859-5'],
  [28597, 'iso-8859-7'],
  [28605, 'iso-8859-15'],
  [50220, 'iso-2022-jp'],
  [51932, 'euc-jp'],
  [54936, 'gb18030'],
]);

function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

function streamPath(storage: string, id: number, type: number): string {
  const name = `__substg1.0_${hex4(id)}${hex4(type)}`;
  return storage ? `${storage}/${name}` : name;
}

function cleanHeader(value: string | undefined): string | undefined {
  return value?.replace(/[\r\n\t ]+/g, ' ').trim() || undefined;
}

/** FILETIME (100 ns ticks since 1601) to ISO 8601 UTC; zero and out-of-range values are dropped. */
function fileTime(value: Uint8Array | undefined): string | undefined {
  if (!value) return undefined;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const ticks = (BigInt(view.getUint32(4, true)) << 32n) | BigInt(view.getUint32(0, true));
  if (ticks === 0n) return undefined;
  const milliseconds = Number(ticks / 10_000n) - 11_644_473_600_000;
  if (Math.abs(milliseconds) > 8_640_000_000_000_000) return undefined;
  return new Date(milliseconds).toISOString();
}

/** Read access to one MSG compound file: streams, property streams and typed property values. */
class MessageStore {
  readonly #archive: CfbArchive;
  readonly #ctx: ReadContext;
  readonly #streams = new Set<string>();
  readonly #storages = new Set<string>();
  readonly #properties = new Map<string, Map<number, Uint8Array>>();
  #guessedEncoding = false;
  readonly codePage: number;

  constructor(ctx: ReadContext, archive: CfbArchive) {
    this.#ctx = ctx;
    this.#archive = archive;
    for (const entry of archive.entries) {
      ctx.budget.tick();
      if (entry.type === 'stream') this.#streams.add(entry.path);
      else this.#storages.add(entry.path);
    }
    this.codePage =
      this.long('', PR_MESSAGE_CODEPAGE, ROOT_HEADER) ?? this.long('', PR_INTERNET_CPID, ROOT_HEADER) ?? 1252;
  }

  get entries(): CfbArchive['entries'] {
    return this.#archive.entries;
  }

  hasStream(path: string): boolean {
    return this.#streams.has(path);
  }

  hasStorage(path: string): boolean {
    return this.#storages.has(path);
  }

  stream(path: string): Uint8Array | undefined {
    return this.#streams.has(path) ? this.#archive.read(path) : undefined;
  }

  /** The fixed-size property values of one storage, keyed by property tag (id << 16 | type). */
  properties(storage: string, headerSize: number): Map<number, Uint8Array> {
    let values = this.#properties.get(storage);
    if (values) return values;
    values = new Map();
    this.#properties.set(storage, values);
    const bytes = this.stream(storage ? `${storage}/${PROPERTIES}` : PROPERTIES);
    if (!bytes) return values;
    for (let offset = headerSize; offset + 16 <= bytes.length; offset += 16) {
      this.#ctx.budget.tick();
      const tag =
        (bytes[offset]! |
          (bytes[offset + 1]! << 8) |
          (bytes[offset + 2]! << 16) |
          (bytes[offset + 3]! << 24)) >>>
        0;
      if (!values.has(tag)) values.set(tag, bytes.subarray(offset + 8, offset + 16));
    }
    return values;
  }

  long(storage: string, id: number, headerSize: number): number | undefined {
    const value = this.properties(storage, headerSize).get(((id << 16) | TYPE_INTEGER32) >>> 0);
    return value ? new DataView(value.buffer, value.byteOffset, 4).getUint32(0, true) : undefined;
  }

  time(storage: string, id: number, headerSize: number): string | undefined {
    return fileTime(this.properties(storage, headerSize).get(((id << 16) | TYPE_TIME) >>> 0));
  }

  /** A string property: the Unicode stream if present, else the 8-bit stream in the message code page. */
  string(storage: string, id: number): string | undefined {
    const unicode = this.stream(streamPath(storage, id, TYPE_UNICODE));
    if (unicode)
      return this.#trimNul(new TextDecoder('utf-16le').decode(unicode.subarray(0, unicode.length & ~1)));
    const ansi = this.stream(streamPath(storage, id, TYPE_STRING8));
    return ansi ? this.#trimNul(this.decode(ansi, this.codePage)) : undefined;
  }

  decode(bytes: Uint8Array, codePage: number): string {
    const label = codePageName(codePage) ?? EXTRA_CODE_PAGES.get(codePage);
    if (label) {
      try {
        return new TextDecoder(label).decode(bytes);
      } catch {
        // An encoding this runtime lacks falls through to the guess below.
      }
    }
    if (!this.#guessedEncoding) {
      this.#guessedEncoding = true;
      this.#ctx.warnings.add({
        code: 'ENCODING_GUESSED',
        message: `Code page ${codePage} is not supported; Windows-1252 was used.`,
      });
    }
    return new TextDecoder('windows-1252').decode(bytes);
  }

  #trimNul(text: string): string {
    let end = text.length;
    while (end > 0 && text.charCodeAt(end - 1) === 0) {
      if ((end & 0xfff) === 0) this.#ctx.budget.tick();
      end--;
    }
    return text.slice(0, end);
  }

  /** Top-level storages whose names start with `prefix`, in name order. */
  storages(prefix: string): string[] {
    const names: string[] = [];
    for (const entry of this.#archive.entries) {
      this.#ctx.budget.tick();
      if (entry.type === 'storage' && !entry.path.includes('/') && entry.path.startsWith(prefix))
        names.push(entry.path);
    }
    return names.sort();
  }
}

function mailbox(name: string | undefined, address: string | undefined): string | undefined {
  const cleanName = cleanHeader(name);
  const cleanAddress = address?.includes('@') ? cleanHeader(address) : undefined;
  if (cleanName && cleanAddress && cleanName !== cleanAddress) return `${cleanName} <${cleanAddress}>`;
  return cleanAddress ?? cleanName;
}

function recipients(store: MessageStore, budget: Budget): { to?: string; cc?: string } {
  const to: string[] = [];
  const cc: string[] = [];
  for (const storage of store.storages(RECIPIENT_PREFIX)) {
    budget.tick();
    const type = store.long(storage, PR_RECIPIENT_TYPE, SUB_OBJECT_HEADER);
    if (type !== 1 && type !== 2) continue;
    const address = store.string(storage, PR_SMTP_ADDRESS) ?? store.string(storage, PR_EMAIL_ADDRESS);
    const value = mailbox(store.string(storage, PR_DISPLAY_NAME), address);
    if (value) (type === 1 ? to : cc).push(value);
  }
  return {
    ...(to.length > 0 ? { to: to.join(', ') } : {}),
    ...(cc.length > 0 ? { cc: cc.join(', ') } : {}),
  };
}

/**
 * Copy one storage subtree into a compound file of its own. An embedded message's property stream
 * has the 24-byte header; the copy gets the 32-byte top-level header ([MS-OXMSG] 2.4.1.1) so the
 * child reads as a standalone .msg.
 */
function repackStorage(
  store: MessageStore,
  storage: string,
  message: boolean,
  budget: Budget,
): Uint8Array | undefined {
  const prefix = `${storage}/`;
  const entries: CfbWriteEntry[] = [];
  for (const entry of store.entries) {
    budget.tick();
    if (!entry.path.startsWith(prefix)) continue;
    const path = entry.path.slice(prefix.length);
    if (entry.type !== 'stream') {
      entries.push({ path, type: 'storage' });
      continue;
    }
    let data = store.stream(entry.path) ?? new Uint8Array(0);
    if (message && path === PROPERTIES) {
      if (data.length < EMBEDDED_HEADER) return undefined;
      const promoted = new Uint8Array(data.length + ROOT_HEADER - EMBEDDED_HEADER);
      promoted.set(data.subarray(0, EMBEDDED_HEADER));
      promoted.set(data.subarray(EMBEDDED_HEADER), ROOT_HEADER);
      data = promoted;
    }
    entries.push({ path, type: 'stream', data });
  }
  return entries.length > 0 ? writeCfb(entries, budget) : undefined;
}

function hasExtension(name: string, extension: string): boolean {
  return name.length > extension.length && name.slice(-extension.length).toLowerCase() === extension;
}

async function readAttachments(
  ctx: ReadContext,
  store: MessageStore,
  cidReferences: Map<string, string>,
): Promise<void> {
  const storages = store.storages(ATTACHMENT_PREFIX);
  if (storages.length === 0) return;
  ctx.out.setFeature('hasEmbeddedFiles');
  if (ctx.options.children === 'skip') return;
  let missing = 0;
  for (const storage of storages) {
    ctx.budget.tick();
    const objectStorage = `${storage}/${EMBEDDED_OBJECT}`;
    // Without a method, an object storage holding a property stream is an embedded message.
    const method =
      store.long(storage, PR_ATTACH_METHOD, SUB_OBJECT_HEADER) ??
      (store.hasStream(`${objectStorage}/${PROPERTIES}`) ? ATTACH_EMBEDDED_MESSAGE : 1);
    const contentId = cleanHeader(store.string(storage, PR_ATTACH_CONTENT_ID));
    let name = safeAttachmentName(
      store.string(storage, PR_ATTACH_LONG_FILENAME) ??
        store.string(storage, PR_ATTACH_FILENAME) ??
        store.string(storage, PR_DISPLAY_NAME),
      contentId,
      ctx.budget,
    );
    let bytes: Uint8Array | undefined;
    let mimeType = cleanHeader(store.string(storage, PR_ATTACH_MIME_TAG));
    if (method === ATTACH_EMBEDDED_MESSAGE || method === ATTACH_OLE) {
      const embedded = method === ATTACH_EMBEDDED_MESSAGE;
      if (store.hasStorage(objectStorage)) bytes = repackStorage(store, objectStorage, embedded, ctx.budget);
      if (embedded) {
        mimeType = MSG_MIME;
        if (!hasExtension(name, '.msg')) name = `${name}.msg`;
      }
    } else {
      bytes = store.stream(streamPath(storage, PR_ATTACH_DATA, TYPE_BINARY));
    }
    if (!ctx.budget.canRead) return;
    if (!bytes) {
      missing++;
      continue;
    }
    await ctx.extractChild(name, bytes, mimeType ? { mimeType } : undefined);
    if (contentId) cidReferences.set(contentId, ctx.path ? `${ctx.path}/${name}` : name);
  }
  if (missing > 0)
    ctx.warnings.add({
      code: 'UNREADABLE_PART',
      message: `${missing} attachment(s) had no readable data (stored by reference or damaged).`,
      ...(ctx.path ? { loc: { path: ctx.path } } : {}),
    });
}

async function readBody(
  ctx: ReadContext,
  store: MessageStore,
  cidReferences: Map<string, string>,
): Promise<void> {
  const drop = ctx.options.quotedReplies === 'drop';
  const text = store.string('', PR_BODY);
  if (text !== undefined && text.trim().length > 0) {
    const body = text.replaceAll('\r\n', '\n');
    emitPlain(ctx, drop ? dropQuotedText(body, ctx.budget) : body);
    return;
  }
  const htmlBytes = store.stream(streamPath('', PR_HTML, TYPE_BINARY));
  const html =
    htmlBytes !== undefined
      ? store.decode(htmlBytes, store.long('', PR_INTERNET_CPID, ROOT_HEADER) ?? store.codePage)
      : store.string('', PR_HTML);
  if (html !== undefined && html.trim().length > 0) {
    emitHtml(ctx, html, cidReferences, drop ? quotedHtml : undefined);
    return;
  }
  const compressed = store.stream(streamPath('', PR_RTF_COMPRESSED, TYPE_BINARY));
  if (!compressed) return;
  const rtf = decompressRtf(compressed, ctx.budget);
  if (!rtf || rtf.damaged)
    ctx.warnings.add({
      code: 'UNREADABLE_PART',
      message: rtf
        ? 'The compressed RTF body is damaged; the text read before the damage is kept.'
        : 'The compressed RTF body could not be read.',
      ...(ctx.path ? { loc: { path: ctx.path } } : {}),
    });
  if (!rtf || rtf.bytes.length === 0) return;
  const encapsulated = deencapsulateRtfHtml(rtf.bytes, ctx.budget);
  if (encapsulated !== undefined) {
    emitHtml(ctx, encapsulated, cidReferences, drop ? quotedHtml : undefined);
    return;
  }
  await rtfReader.read({ ...ctx, bytes: rtf.bytes });
}

/** Read an Outlook .msg ([MS-OXMSG]) into the same shape as EML: header table, body, attachments as children. */
export async function readMsg(ctx: ReadContext): Promise<void> {
  ctx.budget.tick();
  const store = new MessageStore(ctx, ctx.cfb ?? openCfb(ctx.bytes, ctx.budget));
  const subject = cleanHeader(store.string('', PR_SUBJECT));
  const from =
    mailbox(
      store.string('', PR_SENDER_NAME),
      store.string('', PR_SENDER_SMTP_ADDRESS) ?? store.string('', PR_SENDER_EMAIL),
    ) ?? mailbox(store.string('', PR_SENT_REPRESENTING_NAME), store.string('', PR_SENT_REPRESENTING_EMAIL));
  const listed = recipients(store, ctx.budget);
  const to = listed.to ?? cleanHeader(store.string('', PR_DISPLAY_TO));
  const cc = listed.cc ?? cleanHeader(store.string('', PR_DISPLAY_CC));
  const created =
    store.time('', PR_CLIENT_SUBMIT_TIME, ROOT_HEADER) ??
    store.time('', PR_MESSAGE_DELIVERY_TIME, ROOT_HEADER);
  if (subject) ctx.out.setMetadata({ title: subject });
  if (created) ctx.out.setMetadata({ created });
  if (from && ctx.options.metadata) ctx.out.setMetadata({ authors: [from] });
  const rows: Cell[][] = [[{ text: 'Field' }, { text: 'Value' }]];
  if (ctx.options.metadata) {
    if (from) rows.push([{ text: 'From' }, { text: from }]);
    if (to) rows.push([{ text: 'To' }, { text: to }]);
    if (cc) rows.push([{ text: 'Cc' }, { text: cc }]);
  }
  if (created) rows.push([{ text: 'Date' }, { text: created }]);
  if (subject) rows.push([{ text: 'Subject' }, { text: subject }]);
  if (rows.length > 1) ctx.out.table(rows, 1, ctx.path ? { path: ctx.path } : {});

  const cidReferences = new Map<string, string>();
  await readAttachments(ctx, store, cidReferences);
  await readBody(ctx, store, cidReferences);
}

/** The Outlook MSG reader: headers as a field/value table, one body, attachments and embedded messages as children. */
export const msgReader: Reader = { id: 'msg', mimeTypes: [MSG_MIME], read: readMsg };
