import type { ReadContext, Reader } from '../../core/reader.js';
import { decodeTextInput } from '../text-input.js';
import { parseComponents, param, unescapeText } from './content-lines.js';
import type { ContentLine } from './content-lines.js';
import { emitComponent, isoDateTime, person } from './emit.js';
import type { FieldRules } from './emit.js';

/** Components that become a table; time zones and the calendar wrapper do not. */
const SHOWN = new Set(['VEVENT', 'VTODO', 'VJOURNAL', 'VFREEBUSY', 'VALARM']);
const DATE_PROPERTIES = new Set(['DTSTART', 'DTEND', 'DUE', 'RECURRENCE-ID', 'EXDATE', 'RDATE', 'COMPLETED']);

const RULES: FieldRules = {
  skipped: new Set(['UID', 'DTSTAMP', 'SEQUENCE', 'CREATED', 'LAST-MODIFIED', 'ATTACH', 'TRANSP', 'CLASS']),
  personal: new Set(['ORGANIZER', 'ATTENDEE', 'CONTACT']),
  format(line: ContentLine): string {
    if (line.name === 'ORGANIZER' || line.name === 'ATTENDEE') return person(line);
    if (DATE_PROPERTIES.has(line.name)) {
      const zone = param(line, 'TZID');
      return line.value
        .split(',')
        .map((value) => isoDateTime(value, zone))
        .join(', ');
    }
    return unescapeText(line.value);
  },
};

/**
 * iCalendar reader ([RFC 5545]): lines are unfolded, and each event, to-do, journal, free/busy and
 * alarm becomes one Field/Value table in file order. Organizer, attendee and contact lines are
 * personal and need `metadata: true`. `X-WR-CALNAME` is the title.
 */
export const icsReader: Reader = {
  id: 'ics',
  mimeTypes: ['text/calendar'],
  async read(ctx: ReadContext): Promise<void> {
    ctx.budget.tick();
    const text = decodeTextInput(ctx);
    if (text === undefined) return;
    const { components, depthLimited } = parseComponents(text, ctx.budget);
    let shown = 0;
    for (const component of components) {
      ctx.budget.tick();
      if (component.name === 'VCALENDAR') {
        const name = component.lines.find((line) => line.name === 'X-WR-CALNAME');
        if (name) ctx.out.setMetadata({ title: unescapeText(name.value) });
        continue;
      }
      if (!SHOWN.has(component.name)) continue;
      if (!emitComponent(ctx, component, RULES)) break;
      // A streaming consumer can apply backpressure between components (EXT-2).
      if (++shown % 64 === 0) await ctx.out.flush();
    }
    if (depthLimited)
      ctx.warnings.add({
        code: 'DEPTH_LIMIT',
        message: `Components nested deeper than the block depth limit of ${ctx.budget.limits.blockDepth} were merged into their parent.`,
      });
  },
};
