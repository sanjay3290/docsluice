import type { ReadContext, Reader } from '../core/reader.js';
import { decodeReaderText, emitParagraph } from './text-family.js';

/** Make an ICS or VCF reader for one component type. */
export function makeCalendarTextReader(
  id: 'ics' | 'vcf',
  component: 'VEVENT' | 'VCARD',
  mimeType: string,
): Reader {
  return {
    id,
    mimeTypes: [mimeType],
    // The common reader contract is async so readers can extract nested documents.
    // eslint-disable-next-line @typescript-eslint/require-await
    async read(ctx: ReadContext): Promise<void> {
      const text = decodeReaderText(ctx);
      if (text === undefined) return;
      const unfolded: string[] = [];
      for (const line of text.split(/\r\n|\n|\r/)) {
        ctx.budget.tick();
        if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
          unfolded[unfolded.length - 1] += line.slice(1);
        } else unfolded.push(line);
      }
      let fields: string[] | undefined;
      let count = 0;
      for (const line of unfolded) {
        ctx.budget.tick();
        if (line.toUpperCase() === `BEGIN:${component}`) {
          fields = [];
          continue;
        }
        if (line.toUpperCase() === `END:${component}` && fields !== undefined) {
          count++;
          const body = fields.join('\n');
          if (!emitParagraph(ctx, `${component}\n${body}`, `${component}[${count}]`)) return;
          fields = undefined;
          continue;
        }
        if (fields === undefined || line === '') continue;
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const property = line.slice(0, colon).split(';', 1)[0]!.toUpperCase();
        if (ctx.options.metadata === false && isPersonalProperty(id, property)) continue;
        if (!ctx.budget.addCells(1)) {
          count++;
          emitParagraph(ctx, `${component}\n${fields.join('\n')}`, `${component}[${count}]`);
          return;
        }
        fields.push(`${line.slice(0, colon)}: ${line.slice(colon + 1)}`);
      }
      if (fields !== undefined && fields.length > 0) {
        ctx.warnings.add({
          code: 'UNREADABLE_PART',
          message: `${component} component ended before its closing marker.`,
        });
        count++;
        emitParagraph(ctx, `${component}\n${fields.join('\n')}`, `${component}[${count}]`);
      }
    },
  };
}

/** Personal contact/organizer fields are omitted when metadata is disabled. */
function isPersonalProperty(id: 'ics' | 'vcf', property: string): boolean {
  if (id === 'vcf') return ['FN', 'N', 'ADR', 'EMAIL', 'TEL'].includes(property);
  return ['ORGANIZER', 'ATTENDEE'].includes(property);
}
