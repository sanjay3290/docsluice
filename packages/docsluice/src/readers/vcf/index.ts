import type { ReadContext, Reader } from '../../core/reader.js';
import { parseComponents, unescapeText } from '../ics/content-lines.js';
import type { ContentLine } from '../ics/content-lines.js';
import { emitComponent, isoDateTime } from '../ics/emit.js';
import type { FieldRules } from '../ics/emit.js';
import { decodeTextInput } from '../text-input.js';

/** Split a structured value at unescaped `;` and join the non-empty parts. */
function structured(value: string, order: readonly number[] | undefined, joiner: string): string {
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === '\\' && index + 1 < value.length) {
      current += char + value[++index]!;
    } else if (char === ';') {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  const picked = order ? order.map((index) => parts[index] ?? '') : parts;
  return picked
    .map((part) => unescapeText(part).trim())
    .filter((part) => part.length > 0)
    .join(joiner);
}

const RULES: FieldRules = {
  // PHOTO, LOGO, SOUND and KEY hold binary data or links to it.
  skipped: new Set([
    'VERSION',
    'PRODID',
    'UID',
    'REV',
    'PHOTO',
    'LOGO',
    'SOUND',
    'KEY',
    'SOURCE',
    'CLIENTPIDMAP',
  ]),
  personal: new Set(['EMAIL', 'TEL', 'ADR', 'BDAY', 'ANNIVERSARY', 'GEO', 'IMPP', 'URL', 'LABEL', 'RELATED']),
  format(line: ContentLine): string {
    switch (line.name) {
      // N is Family;Given;Additional;Prefix;Suffix: shown as Prefix Given Additional Family Suffix.
      case 'N':
        return structured(line.value, [3, 1, 2, 0, 4], ' ');
      case 'ADR':
        return structured(line.value, undefined, ', ');
      case 'ORG':
        return structured(line.value, undefined, ', ');
      case 'BDAY':
      case 'ANNIVERSARY':
        return isoDateTime(line.value, undefined);
      case 'TEL':
      case 'EMAIL':
      case 'URL':
        return line.value.toLowerCase().startsWith('tel:') ? line.value.slice(4) : line.value;
      default:
        return unescapeText(line.value);
    }
  },
};

/**
 * vCard reader ([RFC 6350], also 2.1 and 3.0): lines are unfolded and each card becomes one
 * Field/Value table in file order. Contact details (email, phone, address, birthday, URL…) are
 * personal and need `metadata: true`; the name, organization and title are always shown.
 */
export const vcfReader: Reader = {
  id: 'vcf',
  mimeTypes: ['text/vcard', 'text/x-vcard'],
  async read(ctx: ReadContext): Promise<void> {
    ctx.budget.tick();
    const text = decodeTextInput(ctx);
    if (text === undefined) return;
    const { components, depthLimited } = parseComponents(text, ctx.budget);
    let shown = 0;
    for (const component of components) {
      ctx.budget.tick();
      if (component.name !== 'VCARD') continue;
      if (!emitComponent(ctx, component, RULES)) break;
      if (++shown % 64 === 0) await ctx.out.flush();
    }
    if (depthLimited)
      ctx.warnings.add({
        code: 'DEPTH_LIMIT',
        message: `Components nested deeper than the block depth limit of ${ctx.budget.limits.blockDepth} were merged into their parent.`,
      });
  },
};
