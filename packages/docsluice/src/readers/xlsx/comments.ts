import type { XmlContext } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';
import { parseIndex, SHEET_NAMESPACES } from './spreadsheetml.js';

/** Threaded comments and persons ([MS-XLSX] 2.6.205, 2.6.198). */
const THREADED_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments';
/** Comment text longer than this is cut; a note is not a document. */
const MAX_COMMENT = 32_768;

/** One cell comment: the cell (`B2`), its text, and its author when the file names one. */
export interface XlsxComment {
  ref: string;
  text: string;
  author?: string;
}

interface Draft {
  ref: string;
  text: string;
  author?: string;
}

/** Element local names in the given namespaces, `undefined` for any other namespace. */
function scan(
  input: Uint8Array,
  ctx: XmlContext,
  namespaces: ReadonlySet<string>,
  handlers: {
    open(
      local: string | undefined,
      parent: string | undefined,
      attrs: Map<string, string>,
      depth: number,
    ): void;
    text(text: string): void;
    close(local: string | undefined): void;
  },
): void {
  const names: Array<string | undefined> = [];
  scanXml(
    input,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        const local =
          info.namespaceURI !== undefined && namespaces.has(info.namespaceURI) ? info.localName : undefined;
        const parent = names.at(-1);
        names.push(local);
        handlers.open(local, parent, attrs, names.length);
      },
      onText(text) {
        handlers.text(text);
      },
      onClose() {
        ctx.budget.tick();
        handlers.close(names.pop());
      },
    },
    ctx,
  );
}

const append = (draft: Draft, text: string): void => {
  if (draft.text.length < MAX_COMMENT) draft.text += text.slice(0, MAX_COMMENT - draft.text.length);
};

/**
 * Legacy comments, called notes in current Excel (ECMA-376 Part 1, 18.7): `authors/author` and
 * `commentList/comment` with a `ref` and rich `text`. Phonetic runs (`rPh`) are not text.
 */
export function parseComments(input: Uint8Array, ctx: XmlContext): XlsxComment[] {
  const authors: string[] = [];
  const comments: XlsxComment[] = [];
  let author: string | undefined;
  let draft: Draft | undefined;
  let inText = 0;
  let phonetic = 0;
  scan(input, ctx, SHEET_NAMESPACES, {
    open(local, parent, attrs) {
      if (local === 'author' && parent === 'authors') author = '';
      else if (local === 'comment' && parent === 'commentList') {
        const ref = attrs.get('ref');
        const authorId = parseIndex(attrs.get('authorId'), Number.MAX_SAFE_INTEGER);
        if (ref !== undefined) {
          draft = { ref, text: '' };
          const name = authorId === undefined ? undefined : authors[authorId];
          if (name) draft.author = name;
        }
      } else if (draft && local === 'rPh') phonetic++;
      else if (draft && local === 't' && phonetic === 0) inText++;
    },
    text(text) {
      if (author !== undefined) author += text;
      else if (draft && inText > 0) append(draft, text);
    },
    close(local) {
      if (local === 'author' && author !== undefined) {
        authors.push(author.trim());
        author = undefined;
      } else if (local === 'comment' && draft) {
        const text = draft.text.trim();
        if (text.length > 0) comments.push({ ...draft, text });
        draft = undefined;
      } else if (local === 'rPh' && phonetic > 0) phonetic--;
      else if (local === 't' && inText > 0) inText--;
    },
  });
  return comments;
}

const THREADED: ReadonlySet<string> = new Set([THREADED_NS]);

/** Person display names by id, from the workbook's person list. */
export function parsePersons(input: Uint8Array, ctx: XmlContext): Map<string, string> {
  const persons = new Map<string, string>();
  scan(input, ctx, THREADED, {
    open(local, parent, attrs) {
      if (local !== 'person' || parent !== 'personList') return;
      const id = attrs.get('id');
      const name = attrs.get('displayName');
      if (id !== undefined && name !== undefined && !persons.has(id)) persons.set(id, name);
    },
    text() {},
    close() {},
  });
  return persons;
}

/** Threaded comments and their replies, in file order, with authors from the person list. */
export function parseThreadedComments(
  input: Uint8Array,
  ctx: XmlContext,
  persons: ReadonlyMap<string, string>,
): XlsxComment[] {
  const comments: XlsxComment[] = [];
  let draft: Draft | undefined;
  let inText = 0;
  scan(input, ctx, THREADED, {
    open(local, parent, attrs) {
      if (local === 'threadedComment' && parent === 'ThreadedComments') {
        const ref = attrs.get('ref');
        if (ref === undefined) return;
        draft = { ref, text: '' };
        const person = attrs.get('personId');
        const name = person === undefined ? undefined : persons.get(person);
        if (name) draft.author = name;
      } else if (draft && local === 'text' && parent === 'threadedComment') inText++;
    },
    text(text) {
      if (draft && inText > 0) append(draft, text);
    },
    close(local) {
      if (local === 'threadedComment' && draft) {
        const text = draft.text.trim();
        if (text.length > 0) comments.push({ ...draft, text });
        draft = undefined;
      } else if (local === 'text' && inText > 0) inText--;
    },
  });
  return comments;
}
