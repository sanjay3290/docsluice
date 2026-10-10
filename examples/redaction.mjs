// Recipe: redaction. Mask e-mail addresses and ID numbers in every block before anything is rendered.
import { extract } from 'docsluice';

// Linear patterns: no nested or overlapping quantifiers, and the address may only start where its
// characters start (the lookbehind), so a long line without an `@` is scanned once, not quadratically.
const EMAIL = /(?<![\w%+.-])[\w%+.-]+@[\w-]+(?:\.[\w-]+)+/g;
/** US social security style numbers: 123-45-6789. */
const NATIONAL_ID = /\b\d{3}-\d{2}-\d{4}\b/g;
/** Payment card numbers: 13 to 19 digits, optionally in groups split by single spaces or dashes. */
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;

/** The text with every e-mail address and ID number replaced by a fixed mask. */
export function mask(text) {
  return text.replace(EMAIL, '[email]').replace(NATIONAL_ID, '[id]').replace(CARD, '[card]');
}

/**
 * A `transform` hook (EXT-3) that masks every text field of a block: paragraph text and runs,
 * headings, code, notes, headers and footers, list items, table cells and captions, image alt text.
 * docsluice calls it once for every block, nested ones included, before any renderer or `onBlock`.
 */
export function redact(block) {
  switch (block.kind) {
    case 'paragraph':
      block.text = mask(block.text);
      // Runs carry the same text in pieces; mask them together so they keep joining to the text.
      if (block.runs) block.runs = [{ text: block.text }];
      break;
    case 'heading':
    case 'code':
    case 'note':
    case 'header':
    case 'footer':
      block.text = mask(block.text);
      break;
    case 'list': {
      // Items nest; walk them with a stack, not recursion.
      const stack = [...block.items];
      while (stack.length > 0) {
        const item = stack.pop();
        item.text = mask(item.text);
        if (item.items) stack.push(...item.items);
      }
      break;
    }
    case 'table':
      for (const row of block.rows) for (const cell of row) cell.text = mask(cell.text);
      if (block.caption !== undefined) block.caption = mask(block.caption);
      break;
    case 'image':
      if (block.alt !== undefined) block.alt = mask(block.alt);
      break;
  }
  return block;
}

/** Extract with redaction on and personal metadata (authors) off (PRD section 15). */
export function extractRedacted(bytes, options = {}) {
  return extract(bytes, { ...options, metadata: false, transform: redact });
}
