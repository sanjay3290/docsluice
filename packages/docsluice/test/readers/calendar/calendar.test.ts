import { describe, expect, it } from 'vitest';
import ics from '../../../src/readers/ics/index.js';
import vcf from '../../../src/readers/vcf/index.js';
import { parse } from '../text-family/harness.js';

describe('calendar and contact readers', () => {
  it('unfolds RFC 5545 lines and emits VEVENT fields together', async () => {
    const { doc } = await parse(
      ics,
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Example\r\nDESCRIPTION:two\r\n lines\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    );
    expect(doc.blocks).toMatchObject([
      { kind: 'paragraph', text: 'VEVENT\nSUMMARY: Example\nDESCRIPTION: twolines' },
    ]);
    expect(doc.blocks[0]?.loc.path).toBe('VEVENT[1]');
  });

  it('drops personal VCF fields when metadata is disabled', async () => {
    const { doc } = await parse(
      vcf,
      'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Example Person\r\nEMAIL:lin@example.invalid\r\nTEL:555-0100\r\nN:Person;Example;;;\r\nADR:;;1 Main Street;;;;\r\nNOTE:folded\r\n continuation\r\nEND:VCARD\r\n',
      { metadata: false },
    );
    expect(doc.blocks).toMatchObject([
      { kind: 'paragraph', text: 'VCARD\nVERSION: 4.0\nNOTE: foldedcontinuation' },
    ]);
    expect(JSON.stringify(doc)).not.toContain('lin@example.invalid');
    expect(JSON.stringify(doc)).not.toContain('555-0100');
    expect(JSON.stringify(doc)).not.toContain('Example Person');
    expect(JSON.stringify(doc)).not.toContain('1 Main Street');
    expect(doc.blocks[0]?.loc.path).toBe('VCARD[1]');
  });

  it('drops organizer and attendee contact metadata but keeps ICS event content', async () => {
    const { doc } = await parse(
      ics,
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Private meeting\nDESCRIPTION:Bring the draft\nORGANIZER;CN=Host:mailto:lin@example.invalid\nATTENDEE;CN=Guest:mailto:guest@example.invalid\nEND:VEVENT\nEND:VCALENDAR',
      { metadata: false },
    );
    const text = JSON.stringify(doc);
    expect(text).toContain('SUMMARY: Private meeting');
    expect(text).toContain('DESCRIPTION: Bring the draft');
    expect(text).not.toContain('lin@example.invalid');
    expect(text).not.toContain('guest@example.invalid');
  });

  it('stops adding fields when the shared cell budget is exhausted', async () => {
    const { doc, warnings } = await parse(
      ics,
      'BEGIN:VEVENT\nSUMMARY:first\nDESCRIPTION:second\nEND:VEVENT',
      { limits: { cells: 1 } },
    );
    expect(doc.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'VEVENT\nSUMMARY: first' });
    expect(warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });
});
